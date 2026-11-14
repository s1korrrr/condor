import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { BarsChart, TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { DataTable, type TableColumn } from "@/features/quant-ops/kit/DataTable";
import { CHART, type ChartSeries } from "@/features/quant-ops/kit/series";
import { readCandleStore } from "./candle-store-api";
import { v5Api } from "./api";
import { daily, equityChangeSince, holdReturn, latest, series, type DailyRow, type MoneyRow } from "./money-model.mjs";
import { MARKET_COINS, REFERENCE } from "./market-model.mjs";
import { utcMinute } from "./shown.mjs";
import "./market.css";

type MoneyRead = { sampler: boolean; interval_s: number; started_at_ms: number | null; now_ms: number; range: string; rows: MoneyRow[] };
type CrossLine = { venue: string; lane: string; close: [number, number][] };
const RANGES = ["24h", "7d", "30d"] as const;

async function readMoney(range: string): Promise<MoneyRead> {
  const response = await fetch(`/api/v5/money?range=${range}`, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(14_000) });
  if (!response.ok) throw new Error(`Money read failed (HTTP ${response.status})`);
  return response.json() as Promise<MoneyRead>;
}

/** The reference spot lane's closes for each coin over the candle store's 7 days, read one after another. */
async function readHold(): Promise<{ closes: Record<string, [number, number][] | undefined>; startS: number }> {
  const closes: Record<string, [number, number][] | undefined> = {};
  let startS = Number.POSITIVE_INFINITY;
  for (const coin of MARKET_COINS) {
    try {
      const view = await readCandleStore<{ start: number; series: CrossLine[] }>("cross", { asset: coin, segment: "spot", range: "7d" });
      startS = Math.min(startS, view.start);
      closes[coin] = view.series.find(line => line.lane === REFERENCE.spot)?.close;
    } catch { closes[coin] = undefined; }
  }
  return { closes, startS };
}

const amount = (value: number | null | undefined, digits = 2) => value == null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (value: number | null | undefined, digits = 2) => value == null ? "—" : `${value > 0 ? "+" : ""}${amount(value, digits)}`;
const num = (value: string | null | undefined) => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const at = (ms: number | null | undefined) => utcMinute(ms) ?? "unknown time";

const dailyColumns: TableColumn<DailyRow>[] = [
  { id: "day", header: "Day (UTC)", value: row => new Date(row.day).toISOString().slice(0, 10), rowHeader: true, size: 100 },
  { id: "start", header: "Equity, first sample", value: row => row.equityStart, kind: "number", size: 120, cell: row => amount(row.equityStart) },
  { id: "end", header: "Equity, last sample", value: row => row.equityEnd, kind: "number", size: 120, cell: row => amount(row.equityEnd) },
  { id: "change", header: "Equity change", value: row => row.equityChange, kind: "number", size: 110, cell: row => signed(row.equityChange), className: row => row.equityChange == null ? undefined : row.equityChange < 0 ? "is-down" : "is-up" },
  { id: "realized", header: "Closed-trade profit", value: row => row.realizedChange, kind: "number", size: 120, cell: row => signed(row.realizedChange), title: () => "Change in lifetime realized P&L between the day's first and last sample" },
  { id: "coverage", header: "Day covered", value: row => Math.round(row.coverage * 100), kind: "number", size: 90, cell: row => `${Math.round(row.coverage * 100)}%`, title: row => `${row.samples} samples, ${row.gaps} gaps; a full day is 288 samples` },
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
  const days = daily(rows, "v5");
  const holdView = hold.data ? holdReturn(hold.data.closes, hold.data.startS) : null;
  const v5Since = hold.data && Number.isFinite(hold.data.startS) ? equityChangeSince(rows, "v5", hold.data.startS * 1000) : null;

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
          {!candleConfigured ? <p className="v5m-hint">{profile.isPending ? "Checking for the candle store…" : "No candle store in this deployment, so holding the coins cannot be priced."}</p> : hold.isPending ? <p role="status" className="v5m-hint">Reading 7 days of prices…</p> : !holdView || holdView.pct == null ? <p className="v5m-hint">Holding comparison unavailable: no 7-day prices.</p> : <div className="v5m-stats">
            <Stat label="Holding the five coins" value={`${signed(holdView.pct)}%`} note={`since ${at(hold.data!.startS * 1000)}${holdView.missing.length ? ` · without ${holdView.missing.join(", ")}` : ""}`} />
            <Stat label="V5 wallet equity" value={v5Since == null ? "—" : `${signed(v5Since)}%`} note={v5Since == null ? "needs samples back to the same start; the record is younger" : "same window"} />
          </div>}
          <p className="v5m-hint">Only the candle store's 7 days can be priced, so the comparison never reaches the trial start (2026-10-29).</p></article>
      </div>

      <section className="v5m-section"><header><h2>Day by day</h2><span>UTC days · first and last sample of each day · sort or filter any column</span></header>
        <div className="v5m-card">{days.length ? <DataTable rows={days} columns={dailyColumns} rowId={row => String(row.day)} label="V5 daily money" initialSort={{ id: "day", desc: true }} pageSize={14} dense exportName={`v5-money-daily-${range}`} /> : <p className="v5m-hint">No samples yet.</p>}</div>
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
