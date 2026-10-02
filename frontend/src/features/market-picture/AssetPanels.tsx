import { useEffect, useMemo, useState } from "react";
import { BarsChart } from "@/features/quant-ops/kit/charts";
import { DataTable, type TableColumn } from "@/features/quant-ops/kit/DataTable";
import { CHART } from "@/features/quant-ops/kit/series";
import { BENCHMARKS, rankAssets, rankCoverageLabel } from "./model.mjs";
import {
  assetState,
  derivedRegime,
  hasCorrelationValues,
  horizonLabel,
  REGIME_BASIS,
  regimeSummary,
  returnHeat,
} from "./pulse.mjs";
import {
  type DisplayAsset,
  type DisplayCorrelation,
  type DisplayFrame,
  numberText,
} from "./presentation";
import { api } from "@/lib/api";
import { boundedJson, projectCorrelations } from "./source";
import { Metric, Panel, Sparkline } from "./Primitives";

interface AssetPanelProps {
  frame: DisplayFrame | null;
  selected: string | null;
  select: (id: string) => void;
  cohort: Set<string>;
}

const RETURN_COLUMNS: Array<[string, string]> = [
  ["1", "1m"],
  ["5", "5m"],
  ["15", "15m"],
  ["60", "1h"],
  ["240", "4h"],
  ["1440", "24h"],
  ["10080", "7d"],
];
const signedPercent = (value: number, digits = 2) =>
  `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
const priceDigits = (asset: DisplayAsset) =>
  asset.price.value !== null && asset.price.value < 1 ? 6 : asset.price.value !== null && asset.price.value < 100 ? 3 : 2;
const symbolMatch = (asset: DisplayAsset, search: string) =>
  `${asset.symbol} ${asset.instrument_id}`.toLowerCase().includes(search.toLowerCase());

function SymbolButton({ asset, select }: { asset: DisplayAsset; select: (id: string) => void }) {
  return (
    <button className="mp-symbol" onClick={() => select(asset.instrument_id)} title={`Inspect ${asset.instrument_id}`}>
      {asset.symbol}
    </button>
  );
}

/** Return heat cell: tint scales with the move in units of the asset's own volatility-implied move. */
function HeatCell({ asset, horizon }: { asset: DisplayAsset; horizon: string }) {
  const heat = returnHeat(asset, horizon);
  if (heat.value === null) return <span className="mp-heat" data-empty>—</span>;
  const tone = heat.value === 0 ? "var(--mp-unchanged)" : heat.value > 0 ? "var(--mp-positive)" : "var(--mp-negative)";
  return (
    <span
      className="mp-heat"
      title={`${horizonLabel(horizon)} return ${asset.returns[horizon].original}% · tint = move ÷ 2× its volatility-implied move`}
      style={{ background: `color-mix(in srgb, ${tone} ${Math.round(8 + heat.intensity * 52)}%, transparent)` }}
    >
      {signedPercent(heat.value, Math.abs(heat.value) < 0.1 ? 3 : 2)}
    </span>
  );
}

/** Per-instrument strip: price, returns on every horizon as heat cells, momentum and trend state. */
export function InstrumentsPanel({ frame, selected, select, cohort, search }: AssetPanelProps & { search: string }) {
  const rows = useMemo(
    () => (frame?.assets ?? []).filter((a) => symbolMatch(a, search)),
    [frame, search],
  );
  const columns = useMemo<TableColumn<DisplayAsset>[]>(
    () => [
      {
        id: "symbol", header: "Symbol", rowHeader: true, size: 84, minSize: 70,
        value: (a) => a.symbol,
        cell: (a) => <SymbolButton asset={a} select={select} />,
      },
      {
        id: "price", header: `Price (${frame?.quote ?? ""})`, kind: "number", size: 112,
        value: (a) => a.price.value,
        cell: (a) => <Metric metric={a.price} digits={priceDigits(a)} />,
        title: (a) => a.price.original ?? undefined,
      },
      ...RETURN_COLUMNS.map<TableColumn<DisplayAsset>>(([h, label]) => ({
        id: `r${h}`, header: label, kind: "number", size: 82, minSize: 64,
        value: (a) => (a.returns[h]?.value == null ? null : Number(a.returns[h].value!.toFixed(4))),
        cell: (a) => <HeatCell asset={a} horizon={h} />,
        title: () => undefined,
      })),
      {
        id: "rsi", header: "RSI14", kind: "number", size: 118,
        value: (a) => { const v = assetState(a).rsi; return v === null ? null : Number(v.toFixed(1)); },
        cell: (a) => {
          const s = assetState(a);
          return s.rsi === null ? "—" : <span className="mp-rsi" data-zone={s.rsiZone}><b>{s.rsi.toFixed(1)}</b> {s.rsiZone}</span>;
        },
      },
      {
        id: "trend", header: "Trend", size: 112,
        value: (a) => assetState(a).trend,
        cell: (a) => {
          const s = assetState(a);
          return s.trend === null ? "—" : (
            <span className="mp-chip" data-trend={s.trend} title={`ADX14 ${s.adx?.toFixed(1) ?? "—"} · ${s.emaDistance == null ? "" : `${signedPercent(s.emaDistance)} vs EMA21`}`}>{s.trend}</span>
          );
        },
      },
    ],
    [frame?.quote, select],
  );
  return (
    <Panel
      id="mp-instruments"
      title="Instruments"
      detail={`${rows.length} / ${frame?.expected ?? 0} · returns on every horizon`}
      className="mp-instruments"
    >
      <div className="mp-table-host">
        <DataTable
          rows={rows}
          columns={columns}
          rowId={(a) => a.instrument_id}
          label="Instrument returns and trend"
          initialSort={{ id: "r1440", desc: true }}
          pageSize={25}
          exportName="market-instruments.csv"
          dense
          rowState={(a) => (a.instrument_id === selected ? "highlight" : cohort.has(a.instrument_id) ? "highlight" : undefined)}
          emptyText="No symbols match this search."
        />
      </div>
      <footer className="mp-panel-footnote">
        Heat tint is each move measured against the instrument's own 24h-volatility-implied move for that horizon. RSI14, EMA21 and ADX14 are the owner's observed 1m values.
      </footer>
    </Panel>
  );
}

/** Derived (or stored) regime per instrument, with the observed inputs shown beside the label. */
export function RegimePanel({ frame, selected, select, cohort, search }: AssetPanelProps & { search: string }) {
  const rows = useMemo(
    () => (frame?.assets ?? []).filter((a) => symbolMatch(a, search)),
    [frame, search],
  );
  const summary = useMemo(() => regimeSummary(frame), [frame]);
  const derived = rows.some((a) => derivedRegime(a)?.basis === "derived");
  const columns = useMemo<TableColumn<DisplayAsset>[]>(
    () => [
      { id: "symbol", header: "Symbol", rowHeader: true, size: 84, minSize: 70, value: (a) => a.symbol, cell: (a) => <SymbolButton asset={a} select={select} /> },
      {
        id: "regime", header: "Regime", size: 170,
        value: (a) => derivedRegime(a)?.label ?? null,
        cell: (a) => {
          const r = derivedRegime(a);
          return r ? <span className="mp-chip" data-regime={r.label} title={r.detail}>{r.label}{r.tags.length ? <small> · {r.tags.join(", ")}</small> : null}</span> : "Warming";
        },
        title: (a) => derivedRegime(a)?.detail,
      },
      { id: "adx", header: "ADX14", kind: "number", size: 78, value: (a) => { const v = assetState(a).adx; return v === null ? null : Number(v.toFixed(1)); }, cell: (a) => numberText(assetState(a).adx, 1) },
      {
        id: "atr", header: "ATR14 %", kind: "number", size: 88,
        value: (a) => { const v = a.indicators.atr14_percent?.value; return v == null ? null : Number(v.toFixed(4)); },
        cell: (a) => numberText(a.indicators.atr14_percent?.value ?? null, 3),
        title: (a) => `ATR14 percentile ${numberText(a.indicators.atr14_percentile?.value ?? null, 0)} of its recent range`,
      },
      {
        id: "ema", header: "vs EMA21", kind: "number", size: 92,
        value: (a) => { const v = assetState(a).emaDistance; return v === null ? null : Number(v.toFixed(3)); },
        cell: (a) => { const v = assetState(a).emaDistance; return v === null ? "—" : <span className={v >= 0 ? "mp-up" : "mp-down"}>{signedPercent(v, 3)}</span>; },
      },
      {
        id: "vol", header: "Realized vol 24h", kind: "number", size: 126,
        value: (a) => { const v = a.indicators.realized_volatility_24h?.value; return v == null ? null : Number((v * 100).toFixed(1)); },
        cell: (a) => { const v = a.indicators.realized_volatility_24h?.value; return v == null ? "—" : `${(v * 100).toFixed(1)}%`; },
      },
      { id: "rsi", header: "RSI14", kind: "number", size: 78, value: (a) => { const v = assetState(a).rsi; return v === null ? null : Number(v.toFixed(1)); }, cell: (a) => numberText(assetState(a).rsi, 1) },
    ],
    [select],
  );
  return (
    <Panel
      id="mp-regimes"
      title="Regimes"
      detail={derived ? "Derived from observed indicators" : "Stored regime observations"}
      className="mp-regimes"
    >
      {summary.length > 0 && (
        <ul className="mp-regime-summary" aria-label="Market-wide regime shares">
          {summary.map((item) => (
            <li key={item.key} title={`${item.rule} · ${item.count} of ${item.valid} instruments`}>
              <b>{item.count}/{item.valid}</b> {item.label}
            </li>
          ))}
        </ul>
      )}
      <div className="mp-table-host">
        <DataTable
          rows={rows}
          columns={columns}
          rowId={(a) => a.instrument_id}
          label="Instrument regimes"
          initialSort={{ id: "symbol" }}
          pageSize={25}
          dense
          rowState={(a) => (a.instrument_id === selected || cohort.has(a.instrument_id) ? "highlight" : undefined)}
          emptyText="No symbols match this search."
        />
      </div>
      <footer className="mp-panel-footnote">{derived ? REGIME_BASIS : "Regime labels, origin and calibration come from the recorded regime publisher."}</footer>
    </Panel>
  );
}

/** Sorted per-instrument return bars: works for any universe size, 5 assets included. */
export function LeadersLaggardsPanel({ frame, select, selected, cohort, benchmark }: AssetPanelProps & { benchmark: string }) {
  const [sort, setSort] = useState("1440");
  const value = (a: DisplayAsset) => (sort === "relative" ? (a.relative[benchmark]?.value ?? null) : (a.returns[sort]?.value ?? null));
  const assets = frame?.assets ?? [];
  const { leaders, laggards, qualified, expected } = rankAssets(assets, value);
  const warming = assets.filter((asset) => (sort === "relative" ? asset.relative[benchmark]?.status : asset.returns[sort]?.status) === "WARMING").length;
  const ordered = assets
    .map((a) => ({ a, v: value(a) }))
    .filter((row): row is { a: DisplayAsset; v: number } => row.v !== null)
    .sort((x, y) => y.v - x.v);
  const unit = sort === "relative" ? " pp" : "%";
  const label = sort === "relative" ? `vs ${benchmark} (pp)` : `${horizonLabel(sort)} return`;
  return (
    <Panel
      id="mp-rankings"
      title="Leaders & laggards"
      detail={rankCoverageLabel(qualified, expected, warming)}
      className="mp-rankings"
      actions={
        <select aria-label="Rank leaders and laggards by" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="60">1h</option>
          <option value="240">4h</option>
          <option value="1440">24h</option>
          <option value="10080">7d</option>
          <option value="relative">RS vs {benchmark}</option>
        </select>
      }
    >
      <div className="mp-rank-chart">
        <BarsChart
          rows={ordered.map(({ a, v }) => ({ label: a.symbol, value: v }))}
          bars={[{ id: "value", label, color: CHART.positive, signColors: true }]}
          height={230}
          format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}${unit}`}
          ariaLabel={`Instruments ranked by ${label}`}
        />
      </div>
      <div className="mp-rank-chips">
        <div>
          <span className="mp-kicker">Leaders</span>
          {leaders.length ? leaders.map((a) => (
            <button key={a.instrument_id} className="mp-up" aria-pressed={selected === a.instrument_id} data-cohort={cohort.has(a.instrument_id) || undefined} onClick={() => select(a.instrument_id)}>
              {a.symbol} <b>{signedPercent(value(a)!, 2).replace("%", unit.trim() === "pp" ? " pp" : "%")}</b>
            </button>
          )) : <small>None positive</small>}
        </div>
        <div>
          <span className="mp-kicker">Laggards</span>
          {laggards.length ? laggards.map((a) => (
            <button key={a.instrument_id} className="mp-down" aria-pressed={selected === a.instrument_id} data-cohort={cohort.has(a.instrument_id) || undefined} onClick={() => select(a.instrument_id)}>
              {a.symbol} <b>{signedPercent(value(a)!, 2).replace("%", unit.trim() === "pp" ? " pp" : "%")}</b>
            </button>
          )) : <small>None negative</small>}
        </div>
      </div>
    </Panel>
  );
}

/** Correlations need long paired history; the panel is drawn only once a coefficient exists. */
export function CorrelationsPanel({
  frame, selected, select, correlations, benchmark, setBenchmark, openMatrix,
}: AssetPanelProps & {
  correlations: DisplayCorrelation[];
  benchmark: string;
  setBenchmark: (b: string) => void;
  openMatrix: () => void;
}) {
  const [inverse, setInverse] = useState(false);
  if (!hasCorrelationValues(correlations)) return null;
  const rows = correlations
    .filter((c) => c.instrument_id !== c.benchmark_id && c.value !== null && c.benchmark_id.split(":").at(-1)?.startsWith(benchmark + "-"))
    .sort((a, b) => (inverse ? (a.value ?? Infinity) - (b.value ?? Infinity) : (b.value ?? -Infinity) - (a.value ?? -Infinity)))
    .slice(0, 8);
  return (
    <Panel id="mp-correlations" title="Correlations" detail="90D · 1h" className="mp-correlations">
      <div className="mp-segment mp-benchmark-chips">
        {BENCHMARKS.map((b) => (
          <button key={b} aria-pressed={benchmark === b} onClick={() => setBenchmark(b)}>{b}</button>
        ))}
      </div>
      <div className="mp-table-scroll">
        <table className="mp-table">
          <caption className="sr-only">Pearson correlation of aligned hourly log returns over 90 days. Sparkline contains historical 90 day estimates.</caption>
          <thead><tr><th>Symbol</th><th>Corr ({benchmark})</th><th>30D trend</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.instrument_id} data-selected={selected === c.instrument_id || undefined}>
                <th scope="row">
                  <button onClick={() => select(c.instrument_id)}>
                    {frame?.assets.find((a) => a.instrument_id === c.instrument_id)?.symbol ?? c.instrument_id.split(":").at(-1)}
                  </button>
                </th>
                <td title={`${c.samples}/${c.expected} paired hours · ${c.reasons.join(", ")} · ${new Date(c.cutoff).toISOString()}`}>{numberText(c.value, 2)}</td>
                <td><Sparkline values={c.trend.map((p) => p.value)} color={c.value !== null && c.value < 0 ? "var(--mp-negative)" : undefined} label="Daily history of 90-day correlation" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="mp-correlation-tools">
        <button className="mp-text-button" aria-pressed={inverse} onClick={() => setInverse(!inverse)}>
          {inverse ? "Strongest positive ↗" : "Explore inverse ↘"}
        </button>
        <button className="mp-text-button" onClick={openMatrix}>Matrix ↗</button>
      </footer>
    </Panel>
  );
}

export function CorrelationMatrix({
  frame,
  server,
  initial,
  fixture = false,
  select,
}: {
  frame: DisplayFrame | null;
  server: string | null;
  initial: DisplayCorrelation[];
  fixture?: boolean;
  select: (id: string) => void;
}) {
  const [rowPage, setRowPage] = useState(0),
    [columnPage, setColumnPage] = useState(0);
  const pageSize = 16;
  const assets = frame?.assets ?? [];
  const [stored, setStored] = useState<{
    key: string;
    pairs: DisplayCorrelation[];
    fault: string | null;
  } | null>(null);
  const key = `${frame?.snapshot_id}:${rowPage}:${columnPage}`;
  useEffect(() => {
    if (!frame || !server || fixture) return;
    const controller = new AbortController();
    const query = {
      snapshot_id: frame.snapshot_id,
      matrix: "true",
      row_offset: String(rowPage * pageSize),
      column_offset: String(columnPage * pageSize),
      page_size: String(pageSize),
      limit: "256",
    };
    void (async () => {
      try {
        const payload = await boundedJson(
          await api.getMarketPicture(
            server,
            "correlations",
            query,
            AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          ),
        );
        const pairs = projectCorrelations(payload, frame);
        if (!controller.signal.aborted) setStored({ key, pairs, fault: null });
      } catch (error) {
        if (!controller.signal.aborted)
          setStored({
            key,
            pairs: [],
            fault:
              error instanceof Error
                ? error.message
                : "Stored matrix page could not be read.",
          });
      }
    })();
    return () => controller.abort();
  }, [server, frame, rowPage, columnPage, fixture, key]);
  const correlations = fixture
    ? initial
    : stored?.key === key
      ? stored.pairs
      : [];
  const rows = assets.slice(rowPage * pageSize, (rowPage + 1) * pageSize),
    columns = assets.slice(columnPage * pageSize, (columnPage + 1) * pageSize);
  const values = new Map(
    correlations.map((c) => [`${c.instrument_id}|${c.benchmark_id}`, c]),
  );
  return (
    <>
      {!fixture && stored?.key !== key && (
        <p role="status">Loading stored matrix page…</p>
      )}
      {stored?.key === key && stored.fault && (
        <p className="mp-warning">{stored.fault}</p>
      )}
      <p className="mp-muted">
        90-day aligned hourly log returns. Each cell retains its own paired
        sample count; pairs without enough history have no coefficient. Showing at most 16
        × 16 cells.
      </p>
      <div className="mp-matrix-controls">
        {[
          ["Rows", rowPage, setRowPage],
          ["Columns", columnPage, setColumnPage],
        ].map(([label, page, setPage]) => (
          <label key={String(label)}>
            {String(label)}{" "}
            <select
              value={page as number}
              onChange={(e) =>
                (setPage as (n: number) => void)(Number(e.target.value))
              }
            >
              {Array.from(
                { length: Math.ceil(assets.length / pageSize) },
                (_, i) => (
                  <option value={i} key={i}>
                    {i * pageSize + 1}–
                    {Math.min(assets.length, (i + 1) * pageSize)}
                  </option>
                ),
              )}
            </select>
          </label>
        ))}
      </div>
      <div className="mp-matrix-scroll">
        <table className="mp-table mp-matrix">
          <thead>
            <tr>
              <th>Symbol</th>
              {columns.map((a) => (
                <th key={a.instrument_id}>{a.symbol}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.instrument_id}>
                <th scope="row">
                  <button onClick={() => select(a.instrument_id)}>
                    {a.symbol}
                  </button>
                </th>
                {columns.map((b) => {
                  const c =
                    values.get(`${a.instrument_id}|${b.instrument_id}`) ??
                    values.get(`${b.instrument_id}|${a.instrument_id}`);
                  return (
                    <td
                      key={b.instrument_id}
                      title={
                        c
                          ? `${c.samples}/${c.expected} paired hours · ${c.reasons.join(", ")}`
                          : "No coefficient: the paired hourly history is still building"
                      }
                      style={{
                        background:
                          c?.value == null
                            ? undefined
                            : c.value >= 0
                              ? `rgb(0 217 160 / ${Math.abs(c.value) * 0.35})`
                              : `rgb(255 83 106 / ${Math.abs(c.value) * 0.35})`,
                      }}
                    >
                      {c?.value == null ? "—" : c.value.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
