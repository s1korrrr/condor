import { useId, useMemo, useState } from "react";
import { TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { CHART, axisScale, niceTicks, valueExtent, type ChartSeries } from "@/features/quant-ops/kit/series";
import { HISTORY_COMPARISONS, historyComparisons, type HistoryComparison, type HistoryComparisonResult } from "./history-comparisons.mjs";
import type { HistoryPoint, Horizon } from "./presentation";

const colors = [CHART.blue, CHART.positive, CHART.warning, CHART.violet];
const patterns = [undefined, "6 4", "2 4", "8 3 2 3"];
const signed = (value: number) => `${value > 0 ? "+" : ""}${value !== 0 && Math.abs(value) < 0.01 ? value.toExponential(2) : value.toFixed(3)}`;

function ComparisonPlot({ comparison, horizon, interval }: {
  comparison: HistoryComparisonResult; horizon: Horizon; interval: string;
}) {
  const captionId = useId();
  const [tableOpen, setTableOpen] = useState(false);
  const series = useMemo<ChartSeries[]>(() => comparison.series.map((item, index) => ({
    ...item, color: colors[index], dash: patterns[index], format: value => String(value),
  })), [comparison]);
  const latest = comparison.rows.at(-1);
  // Same extent and tick rule as the chart axis, so the heading names the multiplier its ticks use.
  const scale = useMemo(() => {
    const extent = valueExtent(series);
    const nice = extent && niceTicks(extent[0], extent[1]);
    return nice ? axisScale(nice.step, true, nice.ticks) : null;
  }, [series]);
  return <>
    <p className="mp-visual-unit">{scale?.multiplier ? <><b>{scale.multiplier}</b> </> : null}{comparison.unit} · {horizon}m return horizon · UTC</p>
    <div className="mp-visual-legend">{series.map(item => <span key={item.id}>
      <svg width="26" height="10" aria-hidden="true"><line x1="0" x2="26" y1="5" y2="5" stroke={item.color} strokeWidth="2" strokeDasharray={item.dash} /></svg>
      {item.label}<b>{latest?.values[item.id] == null ? "Unavailable" : signed(latest.values[item.id])}</b>
    </span>)}</div>
    <TimeSeriesChart series={series} markers={comparison.markers} height={230} leftFormat={signed} leftTickFormat={(value, step, ticks) => axisScale(step, true, ticks).format(value)}
      timeDomain={comparison.rows.length > 1 ? [comparison.rows[0].time, comparison.rows.at(-1)!.time] : undefined}
      zeroLine ariaLabel={`${comparison.label} · ${horizon}m horizon · ${interval}m change interval · ${scale?.multiplier ? `axis ticks ${scale.multiplier} ` : ""}${comparison.unit}`}
      emptyText={comparison.unavailable ?? "No retained comparison values."} />
    <p className="mp-panel-footnote">{latest ? `Latest retained point ${new Date(latest.time).toISOString()} · ${latest.coverage}` : "No retained points in this range."}</p>
    <details className="mp-pulse-data" onToggle={event => setTableOpen(event.currentTarget.open)}>
      <summary>{comparison.label} data table · {comparison.rows.length} retained points</summary>
      {tableOpen && <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby={captionId}>
        <table className="mp-table mp-trajectory-table">
          <caption id={captionId}>{comparison.label} · {horizon}m horizon · raw owner observations in {comparison.unit}</caption>
          <thead><tr><th scope="col">UTC cutoff</th>{series.map(item => <th key={item.id} scope="col">{item.label}</th>)}
            <th scope="col">Coverage</th><th scope="col">Continuity</th><th scope="col">15m divergence</th></tr></thead>
          <tbody>{comparison.rows.map(row => <tr key={`${row.time}/${row.snapshot}`}>
            <th scope="row" title={`${row.snapshot ?? "Snapshot unavailable"} · ${row.benchmark}`}>{new Date(row.time).toISOString()}</th>
            {series.map(item => <td key={item.id}>{row.values[item.id] === null ? "Unavailable" : String(row.values[item.id])}</td>)}
            <td>{row.coverage}</td><td>{row.continuity}</td><td>{row.divergence}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </details>
  </>;
}

/** Side-by-side views keep returns and breadth derivatives on their own named scales. */
export function HistoryComparisons({ samples, horizon, range }: {
  samples: HistoryPoint[]; horizon: Horizon; range: [number, number] | null;
}) {
  const [view, setView] = useState<HistoryComparison>("change");
  const [interval, setInterval] = useState("15");
  const returns = useMemo(() => historyComparisons(samples, horizon, interval, "returns", range),
    [samples, horizon, interval, range]);
  const trajectory = useMemo(() => historyComparisons(samples, horizon, interval, view, range),
    [samples, horizon, interval, view, range]);
  return <section className="mp-history-comparisons" aria-label="Historical benchmark, trajectory & divergence comparisons">
    <div className="mp-visual-grid">
      <article className="mp-visual-card">
        <header><h3>Benchmark &amp; cohort returns</h3><span className="mp-kicker">Price participation</span></header>
        <p className="mp-panel-detail">BTC and full-cohort returns at the same cutoff. Rolling returns, not cumulative portfolio performance.</p>
        <ComparisonPlot comparison={returns} horizon={horizon} interval={interval} />
      </article>
      <article className="mp-visual-card">
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
        <ComparisonPlot comparison={trajectory} horizon={horizon} interval={interval} />
      </article>
    </div>
    {horizon !== "15" && <p className="mp-panel-footnote">Select the 15m return horizon to show price–breadth divergence markers.</p>}
    <details className="mp-pulse-data mp-visual-notes">
      <summary>How to read these charts</summary>
      <p className="mp-panel-footnote">The chart range above applies to both views. Raw owner points; no extra smoothing. Gaps and changes of source or cohort break the line. Level, change, velocity and acceleration have separate units.</p>
      <p className="mp-panel-footnote">Divergence markers use BTC confirmed-close breaks of the prior 24-hour range and opposing matched breadth change at H=15m.
        {horizon === "15" ? " A missing marker does not prove agreement; the tables distinguish unavailable from not observed." : ""}
        {" Stored flags retain their definition and window; raw benchmark candles are not part of this history response."}</p>
    </details>
  </section>;
}
