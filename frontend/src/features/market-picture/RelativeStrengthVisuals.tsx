import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, axisFormatter, niceTicks } from "@/features/quant-ops/kit/series";
import { useState } from "react";
import {
  placeScatterLabels,
  projectRelativeRankMovers,
  projectRelativeStrength,
  type RelativeRankMover,
  type RelativeScatterPoint,
} from "./relative-visuals.mjs";
import type { DisplayFrame } from "./presentation";

const exact = (value: number) => `${value > 0 ? "+" : ""}${value}`;
const number = (value: number, unit: string) => `${exact(value)} ${unit}`;
/** Quadrant axis: always spans zero, rounded outward so every point stays inside. */
function quadrantAxis(values: number[]) {
  const nice = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  if (!nice) return null;
  const first = nice.ticks[0], last = nice.ticks[nice.ticks.length - 1], margin = (last - first) * 0.04;
  // The margin beyond the outer ticks keeps edge points and their labels off the plot frame.
  return { ticks: nice.ticks, domain: [first - margin, last + margin] as [number, number], format: axisFormatter(nice.step, true) };
}
// At most this many symbols are offered for direct labels: pullback candidates first, then the
// points farthest from the origin. Placement still drops any that would overlap; the table lists all.
const LABELLED_POINTS = 24;
function labelBudget(points: RelativeScatterPoint[], xSpan: number, ySpan: number) {
  const reach = (point: RelativeScatterPoint) => Math.hypot(point.oneHourReturn / (xSpan || 1), point.relativeReturn / (ySpan || 1));
  return [...points].sort((a, b) => Number(b.pullback) - Number(a.pullback) || reach(b) - reach(a) || a.instrumentId.localeCompare(b.instrumentId))
    .slice(0, LABELLED_POINTS);
}
// Scatter plot frame inside its 290px container: chart margins plus the 48px y axis and ~30px x axis.
const PLOT_INSET = { horizontal: 12 + 18 + 48, vertical: 12 + 20 + 30 };

function RelativeTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: RelativeScatterPoint }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="mp-chart-tooltip">
      <strong>{point.symbol}</strong>
      <span>1h asset return: {number(point.oneHourReturn, "%")}</span>
      <span>24h excess return: {number(point.relativeReturn, "pp")}</span>
      {point.pullback && <span>Pullback predicate: positive excess return and negative 1h return</span>}
    </div>
  );
}

function RankTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: RelativeRankMover }>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const movement = row.delta > 0 ? `improved ${row.delta}` : `weakened ${Math.abs(row.delta)}`;
  return <div className="mp-chart-tooltip"><strong>{row.symbol}</strong><span>{movement} {Math.abs(row.delta) === 1 ? "place" : "places"} over 1h</span></div>;
}

type QuadrantAxis = NonNullable<ReturnType<typeof quadrantAxis>>;

/** The scatter chart; it owns the measured plot width so labels can be placed without overlap. */
function ScatterPlot({ benchmark, cutoff, xAxis, yAxis, other, pullbacks, labelCandidates, selected }: {
  benchmark: string; cutoff: number; xAxis: QuadrantAxis | null; yAxis: QuadrantAxis | null;
  other: RelativeScatterPoint[]; pullbacks: RelativeScatterPoint[]; labelCandidates: RelativeScatterPoint[];
  /** The instrument open in the drawer; ringed on the plot. */
  selected: string | null;
}) {
  const focus = [...other, ...pullbacks].find(point => point.instrumentId === selected);
  const [plotWidth, setPlotWidth] = useState(0);
  const labels = labelCandidates.length && xAxis && yAxis
    ? placeScatterLabels(labelCandidates, xAxis.domain, yAxis.domain, { width: plotWidth - PLOT_INSET.horizontal, height: 290 - PLOT_INSET.vertical })
    : new Map<string, "left" | "right">();
  const pointLabel = (series: RelativeScatterPoint[]) => <LabelList dataKey="symbol" content={(props: { x?: number | string; y?: number | string; width?: number | string; height?: number | string; index?: number }) => {
    const point = props.index == null ? undefined : series[props.index];
    const side = point && labels.get(point.instrumentId);
    if (!point || !side) return null;
    const x = Number(props.x) + Number(props.width ?? 0) / 2, y = Number(props.y) + Number(props.height ?? 0) / 2;
    return <text x={side === "right" ? x + 7 : x - 7} y={y} dy="0.35em" textAnchor={side === "right" ? "start" : "end"} fill={CHART.text} fontSize={10}>{point.symbol}</text>;
  }} />;
  return (
    <div role="img" aria-label={`Scatter plot at observed cutoff ${new Date(cutoff).toISOString()}. Horizontal axis is one-hour asset return in percent. Vertical axis is twenty-four-hour arithmetic excess return versus ${benchmark} in percentage points. Vertical and horizontal zero lines divide positive and negative values. Diamonds identify existing pullback candidates.`} style={{ width: "100%", height: 290 }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }} onResize={width => setPlotWidth(width)}>
        <ScatterChart margin={{ top: 12, right: 18, bottom: 20, left: 12 }}>
          <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="oneHourReturn"
            name="1h asset return"
            domain={xAxis?.domain}
            ticks={xAxis?.ticks}
            interval={0}
            tickFormatter={xAxis?.format}
            tick={{ fill: CHART.muted, fontSize: 10 }}
            stroke={CHART.muted}
          />
          <YAxis
            type="number"
            dataKey="relativeReturn"
            name={`24h excess return vs ${benchmark}`}
            domain={yAxis?.domain}
            ticks={yAxis?.ticks}
            interval={0}
            tickFormatter={yAxis?.format}
            tick={{ fill: CHART.muted, fontSize: 10 }}
            stroke={CHART.muted}
            width={48}
          />
          <ReferenceLine x={0} stroke={CHART.neutral} strokeDasharray="4 4" />
          <ReferenceLine y={0} stroke={CHART.neutral} strokeDasharray="4 4" />
          <Tooltip isAnimationActive={false} cursor={{ stroke: CHART.muted, strokeDasharray: "3 4" }} content={<RelativeTooltip />} />
          <Scatter name="Other qualified instruments" data={other} fill={CHART.blue} fillOpacity={0.75} stroke={CHART.surface} strokeWidth={0.6} shape="circle" isAnimationActive={false}>{labels.size > 0 && pointLabel(other)}</Scatter>
          <Scatter name="Pullback predicate" data={pullbacks} fill={CHART.warning} fillOpacity={0.85} stroke={CHART.surface} strokeWidth={0.6} shape="diamond" isAnimationActive={false}>{labels.size > 0 && pointLabel(pullbacks)}</Scatter>
          {focus && <ReferenceDot x={focus.oneHourReturn} y={focus.relativeReturn} r={8} fill="none" stroke={CHART.text} strokeWidth={1.5} ifOverflow="hidden" />}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Owner-value relative return views; interaction remains available through native buttons. */
export function RelativeStrengthVisuals({
  frame,
  benchmark,
  asOf,
  select,
  selected,
}: {
  frame: DisplayFrame;
  /** The page's assessment clock; historical inspection passes its recorded time. */
  asOf: number;
  benchmark: string;
  select: (id: string) => void;
  selected: string | null;
}) {
  const scatter = projectRelativeStrength(frame.assets, benchmark, frame, asOf);
  const rank = projectRelativeRankMovers(frame, asOf);
  const rankExtent = Math.max(1, ...rank.rows.map(row => Math.abs(row.delta)));
  const rankTicks = niceTicks(-rankExtent, rankExtent, 5, true)?.ticks.filter(tick => Math.abs(tick) <= rankExtent);
  const otherPoints = scatter.points.filter((point) => !point.pullback);
  const pullbackPoints = scatter.points.filter((point) => point.pullback);
  const xAxis = quadrantAxis(scatter.points.map(point => point.oneHourReturn));
  const yAxis = quadrantAxis(scatter.points.map(point => point.relativeReturn));
  const scatterShown = scatter.points.length > 0, rankShown = rank.available && rank.rows.length > 0;
  // When only one view has data it takes the full row; the other stays as a compact status card.
  const single = scatterShown !== rankShown;
  const cardClass = (shown: boolean) => `mp-visual-card${single ? (shown ? " mp-visual-card--full" : " mp-visual-card--status") : ""}`;

  return (
    <div className="mp-visual-grid">
      <article className={cardClass(scatterShown)} aria-labelledby="mp-relative-map-title">
        <header><h3 id="mp-relative-map-title">Absolute return vs relative strength</h3><span className="mp-kicker">Price participation</span></header>
        <p className="mp-panel-footnote">
          Owner 1h return against 24h arithmetic excess return; diamonds mark the pullback predicate (positive excess, negative 1h).
          Labels name pullbacks first, then the most extreme points; overlapping marks show darker.
          {` ${scatter.valid}/${scatter.expected} qualified; ${scatter.omitted} missing, unavailable or not current. Observed cutoff ${new Date(frame.cutoff_ms).toISOString()}; assessed ${Number.isFinite(asOf) ? new Date(asOf).toISOString() : "at an invalid time"}.`}
        </p>
        {scatter.points.length ? <>
          <div className="mp-visual-axis-labels" aria-hidden="true"><span>↑ 24h excess return vs {scatter.benchmark} (pp)</span><span>→ 1h asset return (%)</span></div>
          <ScatterPlot benchmark={scatter.benchmark} cutoff={frame.cutoff_ms} xAxis={xAxis} yAxis={yAxis}
            other={otherPoints} pullbacks={pullbackPoints} selected={selected}
            labelCandidates={xAxis && yAxis ? labelBudget(scatter.points, xAxis.domain[1] - xAxis.domain[0], yAxis.domain[1] - yAxis.domain[0]) : []} />
          <details>
            <summary>Inspect {scatter.valid} plotted instruments</summary>
            <div className="mp-table-scroll" tabIndex={0} role="region" aria-label="Relative-strength scatter data">
              <table className="mp-table mp-visual-table">
              <caption>Qualified scatter points at observed cutoff {new Date(frame.cutoff_ms).toISOString()}; excess return is measured against {scatter.benchmark}. Values are exact owner values. Select a symbol to open its existing instrument drawer.</caption>
                <thead><tr><th scope="col">Instrument</th><th scope="col">1h (%)</th><th scope="col">24h excess (pp)</th><th scope="col">Predicate</th></tr></thead>
                <tbody>{scatter.points.map((point) => <tr key={point.instrumentId}>
                  <th scope="row"><button type="button" aria-pressed={selected === point.instrumentId} onClick={() => select(point.instrumentId)}>{point.symbol}</button></th>
                  <td>{exact(point.oneHourReturn)}</td>
                  <td>{exact(point.relativeReturn)}</td>
                  <td>{point.pullback ? "Pullback" : "Other"}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </details>
        </> : <p className="mp-visual-status">{scatter.reason ? `No point qualifies: the frame is not current at this assessment time (${scatter.reason}).` : `No qualified 1h return and 24h ${scatter.benchmark} excess-return pairs.`}</p>}
      </article>

      <article className={cardClass(rankShown)} aria-labelledby="mp-relative-rank-chart-title">
        <header><h3 id="mp-relative-rank-chart-title">One-hour relative-rank movement</h3><span className="mp-kicker">Matched cohort</span></header>
        <p className="mp-panel-footnote">
          Owner rank changes in places. {rank.available
            ? `${rank.displayed} displayed of ${rank.totalImproving + rank.totalWeakening} movers · ${rank.unchanged} unchanged · ${rank.expected}/${rank.expected} instruments matched · baseline ${rank.baselineCutoff == null ? "unavailable" : new Date(rank.baselineCutoff).toISOString()}.`
            : rank.reason}{` Observed cutoff ${new Date(frame.cutoff_ms).toISOString()}.`}
        </p>
        {rank.available && rank.rows.length ? <>
          <div className="mp-visual-axis-labels" aria-hidden="true"><span>← weakened · rank movement (places) · improved →</span></div>
          <div role="img" aria-label={`Horizontal bar chart at observed cutoff ${new Date(frame.cutoff_ms).toISOString()}, of up to five improving and five weakening relative ranks, measured in places over one hour. Positive bars mean improvement. ${rank.displayed} shown of ${rank.totalImproving + rank.totalWeakening} movers; ${rank.unchanged} unchanged.`} style={{ width: "100%", height: Math.max(110, rank.rows.length * 30 + 44) }}>
            <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
              <BarChart data={rank.rows} layout="vertical" margin={{ top: 8, right: 18, bottom: 8, left: 8 }}>
                <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" />
                <XAxis type="number" dataKey="delta" domain={[-rankExtent - 0.5, rankExtent + 0.5]} ticks={rankTicks} interval={0} allowDecimals={false} tickFormatter={(value: number) => String(value)} tick={{ fill: CHART.muted, fontSize: 10 }} stroke={CHART.muted} />
                <YAxis type="category" dataKey="symbol" width={72} tick={{ fill: CHART.muted, fontSize: 10 }} stroke={CHART.muted} />
                <ReferenceLine x={0} stroke={CHART.neutral} />
                <Tooltip isAnimationActive={false} cursor={{ fill: CHART.grid, fillOpacity: 0.45 }} content={<RankTooltip />} />
                <Bar dataKey="delta" name="Rank movement (places)" barSize={18} isAnimationActive={false}>
                  {rank.rows.map((row) => <Cell key={row.instrumentId} fill={row.delta > 0 ? CHART.positive : CHART.negative} />)}
                  <LabelList dataKey="delta" position="right" fill={CHART.text} fontSize={10} formatter={(value: unknown) => typeof value === "number" ? (value > 0 ? `+${value}` : String(value)) : ""} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <details>
            <summary>Inspect {rank.displayed} plotted rank changes</summary>
            <div className="mp-table-scroll" tabIndex={0} role="region" aria-label="Relative-rank movement data">
              <table className="mp-table">
                <caption>Displayed owner rank movements; select a symbol to open its existing instrument drawer.</caption>
                <thead><tr><th scope="col">Instrument</th><th scope="col">Movement</th><th scope="col">Meaning</th></tr></thead>
                <tbody>{rank.rows.map((row) => <tr key={row.instrumentId}>
                  <th scope="row"><button type="button" aria-pressed={selected === row.instrumentId} onClick={() => select(row.instrumentId)}>{row.symbol}</button></th>
                  <td>{row.delta > 0 ? `+${row.delta}` : row.delta} places</td>
                  <td>{row.direction === "improving" ? "Improving" : "Weakening"}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </details>
        </> : <p className="mp-visual-status">{rank.available ? "No relative ranks moved during the one-hour comparison." : "Rank movement is unavailable until a current, complete matched one-hour owner baseline is present."}</p>}
      </article>
    </div>
  );
}
