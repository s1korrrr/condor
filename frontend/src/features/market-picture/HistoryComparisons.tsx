import { useId, useMemo, useState } from "react";
import { TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { CHART, axisScale, niceTicks, valueExtent, type ChartSeries } from "@/features/quant-ops/kit/series";
import { historyComparisons, valuedDomain, type HistoryComparisonResult } from "./history-comparisons.mjs";
import { marketPulseWindow } from "./model.mjs";
import { returnsHistoryRetained } from "./availability";
import { Panel } from "./Primitives";
import type { HistoryPoint, Horizon } from "./presentation";

const colors = [CHART.blue, CHART.positive, CHART.warning, CHART.violet];
const patterns = [undefined, "6 4", "2 4", "8 3 2 3"];
const signed = (value: number) => `${value > 0 ? "+" : ""}${value !== 0 && Math.abs(value) < 0.01 ? value.toExponential(2) : value.toFixed(3)}`;

function ComparisonPlot({ comparison, horizon, zoom, onZoom }: {
  comparison: HistoryComparisonResult; horizon: Horizon;
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
      zeroLine ariaLabel={`${comparison.label} · ${horizon}m horizon · ${scale?.multiplier ? `axis ticks ${scale.multiplier} ` : ""}${comparison.unit}`}
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
            <th scope="col">Coverage</th><th scope="col">Continuity</th></tr></thead>
          <tbody>{comparison.rows.map(row => <tr key={`${row.time}/${row.snapshot}`}>
            <th scope="row" title={`${row.snapshot ?? "Snapshot unavailable"} · ${row.benchmark}`}>{new Date(row.time).toISOString()}</th>
            {all.map(item => <td key={item.id}>{row.values[item.id] === null ? "—" : String(row.values[item.id])}</td>)}
            <td>{row.coverage}</td><td>{row.continuity}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </details>
  </>;
}

/** Benchmark and full-cohort rolling returns; breadth momentum and divergence live in the hero timeline. */
export function HistoryComparisons({ history, window, horizon, zoom, onZoom }: {
  history: HistoryPoint[]; window: string; horizon: Horizon;
  zoom: [number, number] | null; onZoom: (range: [number, number] | null) => void;
}) {
  const samples = useMemo(() => marketPulseWindow(history, window).samples, [history, window]);
  const returns = useMemo(() => historyComparisons(samples, horizon, "15", "returns", zoom), [samples, horizon, zoom]);
  // Retention is judged on the whole window, so zooming into an empty stretch shows an empty chart, not no panel.
  const returnsRetained = useMemo(() => returnsHistoryRetained(samples, horizon), [samples, horizon]);
  if (!returnsRetained) return null;
  return <Panel id="mp-history-comparisons" title="Benchmark & cohort returns" detail="BTC and full-cohort rolling returns at the same cutoffs · drag to zoom, double-click to reset">
    <section className="mp-history-comparisons" aria-label="Historical benchmark and cohort returns">
      <article className="mp-visual-card">
        <header><h3>Rolling returns</h3><span className="mp-kicker">Price participation</span></header>
        <ComparisonPlot comparison={returns} horizon={horizon} zoom={zoom} onZoom={onZoom} />
      </article>
      <details className="mp-pulse-data mp-visual-notes">
        <summary>How to read this chart</summary>
        <p className="mp-panel-footnote">Rolling returns, not cumulative portfolio performance. Raw owner points; no extra smoothing. Gaps and changes of source or cohort break the line. The zoom applies to the breadth timeline and this chart together.</p>
      </details>
    </section>
  </Panel>;
}
