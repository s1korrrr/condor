import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { BarsChart, TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { DataTable, type TableColumn } from "@/features/quant-ops/kit/DataTable";
import { CHART, type ChartSeries } from "@/features/quant-ops/kit/series";
import { readCandleStore } from "./candle-store-api";
import { v5Api } from "./api";
import { equityChange, holdReturn, latest, series, type DailyMoneyRow, type MoneyRow } from "./money-model.mjs";
import { MARKET_COINS, REFERENCE } from "./market-model.mjs";
import { utcExact, utcMinute } from "./shown.mjs";
import "./market.css";

type MoneyRead = { sampler: boolean; started_at_ms: number | null; now_ms: number; range: string; rows: MoneyRow[]; daily_report?: DailyMoneyRow[]; recorder_errors: { count: number; last: string | null; at_ms: number | null } };
type CrossLine = { venue: string; lane: string; close: [number, number][] };
type Hold = { closes: Record<string, [number, number][] | undefined> };
const RANGES = ["24h", "7d"] as const;

async function readMoney(range: string): Promise<MoneyRead> {
  const response = await fetch(`/api/v5/money?range=${range}`, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(14_000) });
  if (!response.ok) throw new Error(`Money read failed (HTTP ${response.status})`);
  return response.json() as Promise<MoneyRead>;
}

/** The reference spot lane's closes for each coin over the candle store's 7 days, read one after another. */
async function readHold(): Promise<Hold> {
  const closes: Record<string, [number, number][] | undefined> = {};
  for (const coin of MARKET_COINS) {
    try {
      const view = await readCandleStore<{ series: CrossLine[] }>("cross", { asset: coin, segment: "spot", range: "7d" });
      closes[coin] = view.series.find(line => line.lane === REFERENCE.spot)?.close;
    } catch { closes[coin] = undefined; }
  }
  return { closes };
}

const amount = (value: number | null | undefined, digits = 2) => value == null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (value: number | null | undefined, digits = 2) => value == null ? "—" : `${value > 0 ? "+" : ""}${amount(value, digits)}`;
const num = (value: string | null | undefined) => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const at = (ms: number | null | undefined) => utcMinute(ms) ?? "unknown time";

// Decimal strings stay text in cells, filters, sorting and CSV exports. Numeric
// table columns coerce to binary floats, so they are unsuitable for this report.
const dailyColumns: TableColumn<DailyMoneyRow>[] = [
  { id: "date", header: "Day (UTC)", value: row => row.date, rowHeader: true, size: 110 },
  { id: "bot", header: "Bot", value: row => row.bot.toUpperCase(), size: 70 },
  { id: "unit", header: "Unit", value: row => row.unit, size: 100 },
  ...([
    ["equity_start", "Start equity"], ["equity_end", "End equity"],
    ["equity_change", "Change"], ["equity_change_pct", "Change %"],
    ["realized_pnl", "Realized PnL"], ["fees", "Fees"],
    ["unrealized_pnl_end", "Unrealized at end"], ["buys", "Buys"],
    ["sells", "Sells"], ["fills", "Fills"], ["cash_end", "Cash at end"],
    ["held_value_end", "Held value at end"],
  ] as const).map(([id, header]): TableColumn<DailyMoneyRow> => ({
    id, header, value: row => row[id], size: 155,
  })),
  { id: "first", header: "First sample (UTC)", value: row => utcExact(row.first_at_ms) ?? "UNAVAILABLE", size: 210 },
  { id: "last", header: "Last sample (UTC)", value: row => utcExact(row.last_at_ms) ?? "UNAVAILABLE", size: 210 },
  { id: "quality", header: "Data quality", value: row => row.data_quality, wrap: true, size: 330 },
];

export function V5Money() {
  const [range, setRange] = useState<(typeof RANGES)[number]>("7d");
  const money = useQuery({ queryKey: ["v5-money", range], queryFn: () => readMoney(range), retry: false, refetchInterval: 60_000 });
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile, retry: false });
  // Prices come from the candle store only where this deployment has one; otherwise the comparison says so.
  const candleConfigured = profile.data?.candle_store?.configured === true;
  const hold = useQuery({ queryKey: ["v5-money-hold"], queryFn: readHold, retry: false, refetchInterval: 15 * 60_000, enabled: candleConfigured });
  const rows = money.data?.rows ?? [];
  const v5 = latest(rows, "v5"), helm = latest(rows, "helm");
  const now = v5.withValues;
  const equity = num(now?.equity), funding = num(now?.initial_funding);
  const equitySeries: ChartSeries[] = [{ id: "equity", label: "V5 wallet equity", color: CHART.blue, points: series(rows, "v5", "equity"), unit: now?.unit ?? "USDC", format: value => amount(value) }];
  const pnlSeries: ChartSeries[] = [
    { id: "realized", label: "Profit from closed trades", color: CHART.positive, points: series(rows, "v5", "realized"), format: value => signed(value) },
    { id: "unrealized", label: "Gain or loss on coins still held", color: CHART.negative, points: series(rows, "v5", "unrealized"), format: value => signed(value) },
  ];
  const coins = (now?.coins ?? {}) as Record<string, { realized: string | null; unrealized: string | null }>;
  const coinRows = Object.entries(coins).map(([coin, values]) => ({ label: coin, realized: num(values.realized), unrealized: num(values.unrealized) }));
  const days = money.data?.daily_report ?? [];
  const holdView = hold.data ? holdReturn(hold.data.closes) : null;
  // V5 over its own first and last sample in the 7-day rows; it is "the same window" only if both ends match exactly.
  const v5View = money.data?.range === "7d" ? equityChange(rows, "v5") : null;
  const sameWindow = holdView?.pct != null && v5View?.pct != null && holdView.startS! * 1000 === v5View.startMs && holdView.endS! * 1000 === v5View.endMs;

  return <div className="v5m">
    <header className="v5m-head">
      <div><h1>Money</h1><p>Paper money for V5 and Helm at a glance. Recorded by this dashboard every 5 minutes{money.data?.started_at_ms ? ` since ${at(money.data.started_at_ms)}` : ""}; there is no record before that.</p></div>
      <div className="v5m-chips">
        <div role="group" aria-label="Range" className="v5m-seg">{RANGES.map(item => <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>)}</div>
        <button className="v5m-refresh" onClick={() => { void money.refetch(); void hold.refetch(); }}><RotateCw size={14} />Refresh</button>
      </div>
    </header>
    {money.isPending ? <p role="status" className="v5m-status">Reading money samples…</p> : money.isError ? <p role="alert" className="v5m-status">{money.error.message}. Nothing older is shown.</p> : <>
      {!money.data.sampler && <p role="note" className="v5m-status">The money recorder is off in this deployment, so no new samples are being taken.</p>}
      {(money.data.recorder_errors?.count ?? 0) > 0 && <p role="alert" className="v5m-status">The recorder failed {money.data.recorder_errors.count} time(s), last at {at(money.data.recorder_errors.at_ms)} ({money.data.recorder_errors.last}); those samples are missing and show as gaps.</p>}
      {v5.newest?.gap && <p role="note" className="v5m-status">Latest V5 sample at {at(v5.newest.at_ms)} is a gap: {v5.newest.gap}. Tiles show the last sample with values{now ? ` (${at(now.at_ms)})` : ""}.</p>}

      <section className="v5m-section"><header><h2>V5 paper bot</h2><span>{now ? `as of ${at(now.at_ms)} · ${now.unit ?? "USDC"}` : "no sample with values yet"}</span></header>
        <div className="v5m-stats v5m-stats--wide">
          <Stat label="Wallet equity" value={amount(equity)} note={funding != null && equity != null ? `${signed(equity - funding)} vs the ${amount(funding, 0)} start (${signed((equity / funding - 1) * 100)}%)` : "start funding not published"} warn={equity != null && funding != null && equity < funding} />
          <Stat label="Profit from closed trades" value={signed(num(now?.realized))} note="lifetime, owner accounting" />
          <Stat label="Gain or loss on coins still held" value={signed(num(now?.unrealized))} note="marked at the owner's fresh book midpoint" warn={(num(now?.unrealized) ?? 0) < 0} />
          <Stat label="Fees paid" value={amount(num(now?.fees))} note="lifetime" />
        </div>
      </section>

      <div className="v5m-row">
        <article className="v5m-card"><h3>Wallet equity over time</h3><p className="v5m-hint">One point per 5-minute sample · lines break at gaps · hover for values</p>
          <TimeSeriesChart series={equitySeries} height={240} ariaLabel="V5 wallet equity over time" leftFormat={value => amount(value)} emptyText="No samples in this range yet." /></article>
        <article className="v5m-card"><h3>Closed-trade profit and held-coin gain or loss</h3><p className="v5m-hint">Lifetime totals at each sample · hover for values</p>
          <TimeSeriesChart series={pnlSeries} height={240} zeroLine includeZero signed ariaLabel="V5 realized and unrealized P&L over time" leftFormat={value => signed(value)} emptyText="No samples in this range yet." /></article>
      </div>

      <div className="v5m-row">
        <article className="v5m-card"><h3>By coin</h3><p className="v5m-hint">Lifetime closed-trade profit and held-coin gain or loss per coin, latest sample</p>
          <BarsChart rows={coinRows} bars={[{ id: "realized", label: "Closed-trade profit", color: CHART.positive }, { id: "unrealized", label: "Held-coin gain or loss", color: CHART.negative }]} height={200} ariaLabel="V5 P&L by coin" emptyText="No per-coin values in the latest sample." /></article>
        <article className="v5m-card"><h3>Against holding the five coins</h3><p className="v5m-hint">Equal weights in {MARKET_COINS.join(", ")} over the candle store's 7 days ({REFERENCE.venue} spot {REFERENCE.quote})</p>
          {!candleConfigured ? <p className="v5m-hint">{profile.isPending ? "Checking for the candle store…" : "No candle store in this deployment, so holding the coins cannot be priced."}</p> : hold.isPending ? <p role="status" className="v5m-hint">Reading 7 days of prices…</p> : !holdView || holdView.pct == null ? <p className="v5m-hint">Holding comparison unavailable{holdView?.missing.length ? `: no 7-day closes for ${holdView.missing.join(", ")}` : ": the five coins share no first and last minute"}. The basket is never reduced to fewer coins.</p> : <div className="v5m-stats">
            <Stat label="Holding the five coins" value={`${signed(holdView.pct)}%`} note={`from ${at(holdView.startS! * 1000)} to ${at(holdView.endS! * 1000)}`} />
            <Stat label="V5 wallet equity" value={v5View?.pct == null ? "—" : `${signed(v5View.pct)}%`} note={money.data.range !== "7d" ? "pick 7d to compare" : v5View?.pct == null ? "fewer than two samples with values in 7 days" : `from ${utcExact(v5View.startMs) ?? "unknown time"} to ${utcExact(v5View.endMs) ?? "unknown time"}${sameWindow ? " · same window" : " · its own record, not the same window"}`} />
          </div>}
          <p className="v5m-hint">Only the candle store's 7 days can be priced, so the comparison never reaches the trial start (2026-10-29).</p></article>
      </div>

      <section className="v5m-section"><header><h2>Daily</h2><span>V5 and Helm · simulated spot money · all retained UTC days, independent of chart range</span></header>
        <div className="v5m-card">{days.length ? <DataTable rows={days} columns={dailyColumns} rowId={row => `${row.date}-${row.bot}`} label="Daily simulated money" initialSort={{ id: "date", desc: true }} pageSize={14} dense exportName="daily-paper-money" /> : <p className="v5m-hint">UNAVAILABLE: daily report not returned by this dashboard.</p>}</div>
        <p className="v5m-hint">Start and end are the first and last recorded sample inside each UTC day, including gaps. Changes, realized PnL and fees cover that sample window. Equity change includes external cash flows. Counter resets cannot be fully identified. Percentages round half-even to 12 decimal places; amounts stay exact. Cash, held value and trade/fill counts are not recorded and stay UNAVAILABLE. Partial days and missing slots are marked. Amount columns use text sorting and text filters to preserve decimals.</p>
      </section>

      <section className="v5m-section"><header><h2>Helm paper bot</h2><span>{helm.newest ? `latest sample ${at(helm.newest.at_ms)}` : "no sample yet"}</span></header>
        <div className="v5m-card">{!helm.withValues ? <p className="v5m-hint">No Helm money yet{helm.newest?.gap ? `: ${helm.newest.gap.replaceAll("_", " ").toLowerCase()}` : ""}. Helm publishes profit and loss once it runs and has reports.</p> : <div className="v5m-stats">
          <Stat label="Profit from closed trades" value={signed(num(helm.withValues.realized))} note={`as of ${at(helm.withValues.at_ms)}`} />
          <Stat label="Gain or loss on coins still held" value={signed(num(helm.withValues.unrealized))} />
        </div>}</div>
      </section>
      <p className="v5m-hint">Limits: values come from the owners' own reads; the record starts when this dashboard's recorder started (no backfill); a missing sample stays a gap; nothing here is a trading signal.</p>
    </>}
  </div>;
}

function Stat({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) {
  return <div className={`v5m-stat${warn ? " is-warn" : ""}`}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}
