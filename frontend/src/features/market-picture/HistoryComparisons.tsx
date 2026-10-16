import { useMemo, useState } from "react";
import { TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { CHART, type ChartSeries } from "@/features/quant-ops/kit/series";
import { HISTORY_COMPARISONS, historyComparisons, type HistoryComparison } from "./history-comparisons.mjs";
import type { HistoryPoint, Horizon } from "./presentation";

const colors = [CHART.blue, CHART.positive, CHART.warning, CHART.violet];
const signed = (value: number) => `${value > 0 ? "+" : ""}${value !== 0 && Math.abs(value) < 0.001 ? value.toExponential(2) : value.toFixed(3)}`;

/** Same-time owner observations on a single, explicitly labeled measurement scale. */
export function HistoryComparisons({ samples, horizon, range }: {
  samples: HistoryPoint[]; horizon: Horizon; range: [number, number] | null;
}) {
  const [view, setView] = useState<HistoryComparison>("returns");
  const [interval, setInterval] = useState("15");
  const [open, setOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const comparison = useMemo(() => historyComparisons(samples, horizon, interval, view, range),
    [samples, horizon, interval, view, range]);
  const series = useMemo<ChartSeries[]>(() => comparison.series.map((item, index) => ({
    ...item, color: colors[index], format: signed,
  })), [comparison]);
  return <details className="mp-pulse-data" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Historical benchmark, trajectory &amp; divergence comparisons</summary>
    {open && <>
      <div className="mp-pulse-tools">
        <label className="mp-history-select">Comparison <select aria-label="Historical comparison" value={view}
          onChange={event => setView(event.target.value as HistoryComparison)}>
          {(Object.entries(HISTORY_COMPARISONS) as [HistoryComparison, { label: string; unit: string }][])
            .map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
        </select></label>
        <label className="mp-history-select">Change interval <select aria-label="Historical change interval" value={interval}
          onChange={event => setInterval(event.target.value)}>
          {["5", "15", "60"].map(value => <option key={value} value={value}>{value}m</option>)}
        </select></label>
      </div>
      <p className="mp-panel-detail">Return horizon {horizon}m · {comparison.unit} · retained owner points without extra smoothing.
        {view === "returns" ? " BTC and full-cohort returns use the same horizon, cutoff and percent scale; these are rolling returns, not a cumulative portfolio." : " Level, change, velocity and acceleration have separate units."}
        {" The chart range above applies here. Gaps and changes of source or cohort break the line."}
      </p>
      <div className="mp-chart-legend">{series.map(item => <span key={item.id} style={{ color: item.color }}>● {item.label}</span>)}</div>
      <TimeSeriesChart series={series} markers={comparison.markers} height={240} leftFormat={value => `${signed(value)} ${comparison.unit}`}
        zeroLine ariaLabel={`${comparison.label} · ${horizon}m horizon · ${interval}m change interval · ${comparison.unit}`}
        emptyText={comparison.unavailable ?? "No retained comparison values."} />
      {comparison.unavailable && <p className="mp-panel-footnote" role="status">{comparison.unavailable}</p>}
      <p className="mp-panel-footnote">Divergence markers use BTC confirmed-close breaks of the prior 24-hour range and opposing matched breadth change at H=15m.
        {horizon !== "15" ? " Select the 15m return horizon to show those markers." : " A missing marker does not prove agreement; the table distinguishes unavailable from not observed."}
        {" Stored flags retain their definition and window; raw benchmark candles are not part of this history response."}</p>
      <details className="mp-pulse-data" onToggle={event => setTableOpen(event.currentTarget.open)}>
        <summary>Historical comparison data table · {comparison.rows.length} retained points</summary>
        {tableOpen && <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-history-comparison-caption">
          <table className="mp-table mp-trajectory-table">
            <caption id="mp-history-comparison-caption">{comparison.label} · {horizon}m horizon · raw owner observations in {comparison.unit}</caption>
            <thead><tr><th scope="col">UTC cutoff</th>{series.map(item => <th key={item.id} scope="col">{item.label}</th>)}
              <th scope="col">Coverage</th><th scope="col">Continuity</th><th scope="col">15m divergence</th></tr></thead>
            <tbody>{comparison.rows.map(row => <tr key={`${row.time}/${row.snapshot}`}>
              <th scope="row" title={`${row.snapshot ?? "Snapshot unavailable"} · ${row.benchmark}`}>{new Date(row.time).toISOString()}</th>
              {series.map(item => <td key={item.id}>{row.values[item.id] === null ? "Unavailable" : signed(row.values[item.id])}</td>)}
              <td>{row.coverage}</td><td>{row.continuity}</td><td>{row.divergence}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      </details>
    </>}
  </details>;
}
