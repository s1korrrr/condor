import { useId, useMemo, useState } from "react";
import { TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { CHART, axisScale, niceTicks, valueExtent, type ChartSeries } from "@/features/quant-ops/kit/series";
import { HISTORY_COMPARISONS, historyComparisons, valuedDomain, type HistoryComparison, type HistoryComparisonResult } from "./history-comparisons.mjs";
import { marketPulseWindow } from "./model.mjs";
import { returnsHistoryRetained, trajectoryHistoryRetained } from "./availability";
import { Panel } from "./Primitives";
import type { HistoryPoint, Horizon } from "./presentation";

const colors = [CHART.blue, CHART.positive, CHART.warning, CHART.violet];
const patterns = [undefined, "6 4", "2 4", "8 3 2 3"];
const signed = (value: number) => `${value > 0 ? "+" : ""}${value !== 0 && Math.abs(value) < 0.01 ? value.toExponential(2) : value.toFixed(3)}`;

function ComparisonPlot({ comparison, horizon, interval, zoom, onZoom }: {
  comparison: HistoryComparisonResult; horizon: Horizon; interval: string;
  zoom: [number, number] | null; onZoom: (range: [number, number] | null) => void;
}) {
  const captionId = useId();
  const [tableOpen, setTableOpen] = useState(false);
  const all = useMemo<ChartSeries[]>(() => comparison.series.map((item, index) => ({
    ...item, color: colors[index], dash: patterns[index], format: value => String(value),
  })), [comparison]);
  // A series with no retained value is named once below the chart instead of drawn as an empty legend row.
  const series = useMemo(() => all.filter(item => item.points.some(point => point.value !== null)), [all]);
  const missing = all.filter(item => !series.includes(item));
  const domain = valuedDomain(comparison);
  const latest = [...comparison.rows].reverse().find(row => Object.values(row.values).some(value => value !== null));
  const scale = useMemo(() => {
    const extent = valueExtent(series);
    const nice = extent && niceTicks(extent[0], extent[1]);
    return nice ? axisScale(nice.step, true, nice.ticks) : null;
  }, [series]);
  const since = domain ? new Date(domain[0]).toISOString().slice(11, 16) : null;
  return <>
    <div className="mp-visual-legend">{series.map(item => <span key={item.id}>
      <svg width="26" height="10" aria-hidden="true"><line x1="0" x2="26" y1="5" y2="5" stroke={item.color} strokeWidth="2" strokeDasharray={item.dash} /></svg>
      {item.label}<b className={latest?.values[item.id] == null ? undefined : latest.values[item.id]! > 0 ? "mp-up" : latest.values[item.id]! < 0 ? "mp-down" : undefined}>
        {latest?.values[item.id] == null ? "—" : signed(latest.values[item.id]!)}</b>
    </span>)}
      <span className="mp-visual-unit">{scale?.multiplier ? <><b>{scale.multiplier}</b> </> : null}{comparison.unit} · {horizon}m horizon{since ? ` · retained since ${since} UTC` : ""}</span>
    </div>
    <TimeSeriesChart series={series} markers={comparison.markers} height={220} leftFormat={signed} leftTickFormat={(value, step, ticks) => axisScale(step, true, ticks).format(value)}
      timeDomain={domain} zoom={zoom} onZoom={onZoom}
      zeroLine ariaLabel={`${comparison.label} · ${horizon}m horizon · ${interval}m change interval · ${scale?.multiplier ? `axis ticks ${scale.multiplier} ` : ""}${comparison.unit}`}
      emptyText={comparison.unavailable ?? "No retained comparison values."} />
    <p className="mp-panel-footnote">
      {latest ? `Latest ${new Date(latest.time).toISOString().slice(11, 16)} UTC · ${latest.coverage}` : "No retained values in this range."}
      {missing.length ? ` · not retained: ${missing.map(item => item.label).join(", ")}` : ""}
    </p>
    <details className="mp-pulse-data" onToggle={event => setTableOpen(event.currentTarget.open)}>
      <summary>{comparison.label} data table · {comparison.rows.length} retained points</summary>
      {tableOpen && <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby={captionId}>
        <table className="mp-table mp-trajectory-table">
          <caption id={captionId}>{comparison.label} · {horizon}m horizon · raw owner observations in {comparison.unit}</caption>
          <thead><tr><th scope="col">UTC cutoff</th>{all.map(item => <th key={item.id} scope="col">{item.label}</th>)}
            <th scope="col">Coverage</th><th scope="col">Continuity</th><th scope="col">15m divergence</th></tr></thead>
          <tbody>{comparison.rows.map(row => <tr key={`${row.time}/${row.snapshot}`}>
            <th scope="row" title={`${row.snapshot ?? "Snapshot unavailable"} · ${row.benchmark}`}>{new Date(row.time).toISOString()}</th>
            {all.map(item => <td key={item.id}>{row.values[item.id] === null ? "—" : String(row.values[item.id])}</td>)}
            <td>{row.coverage}</td><td>{row.continuity}</td><td>{row.divergence}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </details>
  </>;
}

/** Returns and breadth derivatives on their own named scales; the breadth trajectory appears once the owner retains values. */
export function HistoryComparisons({ history, window, horizon, zoom, onZoom }: {
  history: HistoryPoint[]; window: string; horizon: Horizon;
  zoom: [number, number] | null; onZoom: (range: [number, number] | null) => void;
}) {
  const [view, setView] = useState<HistoryComparison>("change");
  const [interval, setInterval] = useState("15");
  const samples = useMemo(() => marketPulseWindow(history, window).samples, [history, window]);
  const returns = useMemo(() => historyComparisons(samples, horizon, interval, "returns", zoom),
    [samples, horizon, interval, zoom]);
  const trajectoryRetained = useMemo(() => trajectoryHistoryRetained(samples), [samples]);
  const trajectory = useMemo(() => trajectoryRetained ? historyComparisons(samples, horizon, interval, view, zoom) : null,
    [samples, horizon, interval, view, zoom, trajectoryRetained]);
  // Retention is judged on the whole window, so zooming into an empty stretch shows an empty chart, not no panel.
  const returnsRetained = useMemo(() => returnsHistoryRetained(samples, horizon), [samples, horizon]);
  if (!returnsRetained && !trajectory) return null;
  return <Panel id="mp-history-comparisons" title="Benchmark & cohort returns" detail="BTC and full-cohort rolling returns at the same cutoffs · drag a chart to zoom, double-click to reset">
    <section className="mp-history-comparisons" aria-label="Historical benchmark, trajectory & divergence comparisons">
      <div className={trajectory ? "mp-visual-grid" : undefined}>
        {returnsRetained && <article className="mp-visual-card">
          <header><h3>Rolling returns</h3><span className="mp-kicker">Price participation</span></header>
          <ComparisonPlot comparison={returns} horizon={horizon} interval={interval} zoom={zoom} onZoom={onZoom} />
        </article>}
        {trajectory && <article className="mp-visual-card">
          <header><h3>Breadth trajectory</h3><span className="mp-kicker">Matched instruments</span></header>
          <div className="mp-visual-controls">
            <label>Measure <select aria-label="Historical comparison" value={view} onChange={event => setView(event.target.value as HistoryComparison)}>
              {(Object.entries(HISTORY_COMPARISONS) as [HistoryComparison, { label: string; unit: string }][])
                .filter(([key]) => key !== "returns").map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
            </select></label>
            <label>Change interval <select aria-label="Historical change interval" value={interval} onChange={event => setInterval(event.target.value)}>
              {["5", "15", "60"].map(value => <option key={value} value={value}>{value}m</option>)}
            </select></label>
          </div>
          <ComparisonPlot comparison={trajectory} horizon={horizon} interval={interval} zoom={zoom} onZoom={onZoom} />
        </article>}
      </div>
      <details className="mp-pulse-data mp-visual-notes">
        <summary>How to read these charts</summary>
        <p className="mp-panel-footnote">Rolling returns, not cumulative portfolio performance. Raw owner points; no extra smoothing. Gaps and changes of source or cohort break the line. The zoom applies to the breadth timeline and these charts together.</p>
        <p className="mp-panel-footnote">Divergence markers use BTC confirmed-close breaks of the prior 24-hour range and opposing matched breadth change at H=15m.
          {horizon === "15" ? " A missing marker does not prove agreement; the tables distinguish unavailable from not observed." : " Select the 15m horizon to show them."}</p>
        {!trajectory && <p className="mp-panel-footnote">The breadth trajectory chart appears once the owner retains matched trajectory values.</p>}
      </details>
    </section>
  </Panel>;
}
