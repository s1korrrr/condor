import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { TooltipCard } from "@/features/quant-ops/kit/charts";
import { CHART, axisFormatter, niceTicks } from "@/features/quant-ops/kit/series";
import { assetColor } from "@/features/quant-ops/format";
import { numberText } from "./presentation";
import { useState } from "react";
import {
  groupCoincident,
  placeScatterLabels,
  projectRelativeRankMovers,
  projectRelativeStrength,
  type RelativeRankMover,
  type RelativeScatterGroup,
  type RelativeScatterPoint,
} from "./relative-visuals.mjs";
import type { DisplayFrame } from "./presentation";

const exact = (value: number) => `${value > 0 ? "+" : ""}${value}`;
/** Quadrant axis: always spans zero, rounded outward so every point stays inside. */
function quadrantAxis(values: number[]) {
  // Every quadrant keeps at least a fifth of the span, so its label never sits on an axis tick.
  const low = Math.min(0, ...values), high = Math.max(0, ...values), span = high - low || 1;
  const nice = niceTicks(Math.min(low, -0.2 * span), Math.max(high, 0.2 * span));
  if (!nice) return null;
  const first = nice.ticks[0], last = nice.ticks[nice.ticks.length - 1], margin = (last - first) * 0.04;
  // The margin beyond the outer ticks keeps edge points and their labels off the plot frame.
  return { ticks: nice.ticks, domain: [first - margin, last + margin] as [number, number], format: axisFormatter(nice.step, true) };
}
// At most this many symbols are offered for direct labels: pullback candidates first, then the
// points farthest from the origin. Placement still drops any that would overlap; the table lists all.
const LABELLED_POINTS = 24;
function labelBudget(points: RelativeScatterPoint[], xSpan: number, ySpan: number) {
  const reach = (point: RelativeScatterGroup) => Math.hypot(point.oneHourReturn / (xSpan || 1), point.relativeReturn / (ySpan || 1));
  return groupCoincident(points).sort((a, b) => Number(b.pullback) - Number(a.pullback) || reach(b) - reach(a) || a.instrumentId.localeCompare(b.instrumentId))
    .slice(0, LABELLED_POINTS);
}
/** Quadrant meaning: +x is a positive 1h return, +y a positive 24h return in excess of the benchmark. */
const QUADRANTS = [
  { key: "lr", x: 1, y: 1, label: "Leading · rising", position: "insideTopRight" as const, color: CHART.positive },
  { key: "lp", x: -1, y: 1, label: "Leading · pulling back", position: "insideTopLeft" as const, color: CHART.warning },
  { key: "lb", x: 1, y: -1, label: "Lagging · bouncing", position: "insideBottomRight" as const, color: CHART.blue },
  { key: "lf", x: -1, y: -1, label: "Lagging · falling", position: "insideBottomLeft" as const, color: CHART.negative },
];
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
  const tone = (value: number) => value > 0 ? "q-positive" : value < 0 ? "q-negative" : undefined;
  return <TooltipCard title={`${point.symbol}${point.pullback ? " · pullback predicate" : ""} · click to inspect`} rows={[
    { key: "1h", label: "1h asset return", color: assetColor(point.symbol), value: `${numberText(point.oneHourReturn, 3, true)}%`, tone: tone(point.oneHourReturn) },
    { key: "rs", label: "24h excess return", color: assetColor(point.symbol), value: `${numberText(point.relativeReturn, 3, true)} pp`, tone: tone(point.relativeReturn) },
  ]} />;
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
  return <TooltipCard title={`${row.symbol} · click to inspect`} rows={[{
    key: "delta", label: row.delta > 0 ? "Improved over 1h" : "Weakened over 1h", color: row.delta > 0 ? CHART.positive : CHART.negative,
    value: `${row.delta > 0 ? "+" : ""}${row.delta} ${Math.abs(row.delta) === 1 ? "place" : "places"}`, tone: row.delta > 0 ? "q-positive" : "q-negative",
  }]} />;
}

type QuadrantAxis = NonNullable<ReturnType<typeof quadrantAxis>>;

/** The scatter chart; it owns the measured plot width so labels can be placed without overlap. */
function ScatterPlot({ benchmark, cutoff, xAxis, yAxis, other, pullbacks, labelCandidates, selected, select }: {
  benchmark: string; cutoff: number; xAxis: QuadrantAxis | null; yAxis: QuadrantAxis | null;
  other: RelativeScatterPoint[]; pullbacks: RelativeScatterPoint[]; labelCandidates: RelativeScatterGroup[];
  /** The instrument open in the drawer; ringed on the plot. */
  selected: string | null;
  select: (id: string) => void;
}) {
  const focus = [...other, ...pullbacks].find(point => point.instrumentId === selected);
  const [plotWidth, setPlotWidth] = useState(0);
  const labels = labelCandidates.length && xAxis && yAxis
    ? placeScatterLabels(labelCandidates, xAxis.domain, yAxis.domain, { width: plotWidth - PLOT_INSET.horizontal, height: 290 - PLOT_INSET.vertical })
    : new Map<string, "left" | "right">();
  const labelText = new Map(labelCandidates.map(group => [group.instrumentId, group.label]));
  const pick = (item: unknown) => {
    const id = (item as { payload?: { instrumentId?: string }; instrumentId?: string } | null)?.payload?.instrumentId ?? (item as { instrumentId?: string } | null)?.instrumentId;
    if (id) select(id);
  };
  const pointLabel = (series: RelativeScatterPoint[]) => <LabelList dataKey="symbol" content={(props: { x?: number | string; y?: number | string; width?: number | string; height?: number | string; index?: number }) => {
    const point = props.index == null ? undefined : series[props.index];
    const side = point && labels.get(point.instrumentId);
    const text = point && labelText.get(point.instrumentId);
    if (!point || !side || !text) return null;
    const x = Number(props.x) + Number(props.width ?? 0) / 2, y = Number(props.y) + Number(props.height ?? 0) / 2;
    return <text x={side === "right" ? x + 9 : x - 9} y={y} dy="0.35em" textAnchor={side === "right" ? "start" : "end"} fill={CHART.text} fontSize={11} fontWeight={600}>{text}</text>;
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
          {xAxis && yAxis && QUADRANTS.map(q => <ReferenceArea key={q.key} x1={q.x > 0 ? 0 : xAxis.domain[0]} x2={q.x > 0 ? xAxis.domain[1] : 0} y1={q.y > 0 ? 0 : yAxis.domain[0]} y2={q.y > 0 ? yAxis.domain[1] : 0}
            fill={q.color} fillOpacity={0.06} stroke="none" ifOverflow="hidden"
            label={{ value: q.label, position: q.position, fill: CHART.muted, fontSize: 10, opacity: 0.85 }} />)}
          <ReferenceLine x={0} stroke={CHART.neutral} strokeDasharray="4 4" />
          <ReferenceLine y={0} stroke={CHART.neutral} strokeDasharray="4 4" />
          <ZAxis range={[110, 110]} />
          <Tooltip isAnimationActive={false} cursor={{ stroke: CHART.muted, strokeDasharray: "3 4" }} content={<RelativeTooltip />} />
          <Scatter name="Other qualified instruments" data={other} fillOpacity={0.9} stroke={CHART.surface} strokeWidth={1} shape="circle" isAnimationActive={false} cursor="pointer" onClick={pick}>
            {other.map(point => <Cell key={point.instrumentId} fill={assetColor(point.symbol)} />)}
            {labels.size > 0 && pointLabel(other)}</Scatter>
          <Scatter name="Pullback predicate" data={pullbacks} fillOpacity={0.95} stroke={CHART.warning} strokeWidth={1.5} shape="diamond" isAnimationActive={false} cursor="pointer" onClick={pick}>
            {pullbacks.map(point => <Cell key={point.instrumentId} fill={assetColor(point.symbol)} />)}
            {labels.size > 0 && pointLabel(pullbacks)}</Scatter>
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
  const relativeChange = frame.comparisons?.[`relative_strength/${benchmark.toLowerCase()}`];
  const relativeTrend = relativeChange?.status === "VALID" && relativeChange.value != null
    ? relativeChange.value > 0 ? "Strengthening" : relativeChange.value < 0 ? "Weakening" : "Unchanged" : null;
  // When only one view has data it takes the full row; the other stays as a compact status card.
  const single = scatterShown !== rankShown;
  const cardClass = (shown: boolean) => `mp-visual-card${single ? (shown ? " mp-visual-card--full" : " mp-visual-card--status") : ""}`;

  return (
    <div className="mp-visual-grid mp-visual-grid--relative">
      <article className={cardClass(scatterShown)} aria-labelledby="mp-relative-map-title">
        <header><h3 id="mp-relative-map-title">Absolute return vs relative strength</h3><span className="mp-kicker">Price participation</span></header>
        <p className="mp-panel-footnote" title={`Owner 1h return against 24h arithmetic excess return. Diamonds mark the pullback predicate (positive excess, negative 1h). Labels name pullbacks first, then the most extreme points; "×n" counts instruments at one position. Observed cutoff ${new Date(frame.cutoff_ms).toISOString()}; assessed ${Number.isFinite(asOf) ? new Date(asOf).toISOString() : "at an invalid time"}.`}>
          {`${scatter.valid}/${scatter.expected} qualified${scatter.omitted ? ` · ${scatter.omitted} missing or not current` : ""} · ◆ pullback (positive 24h excess, negative 1h) · click a point to inspect it`}
        </p>
        {scatter.points.length ? <>
          <div className="mp-visual-axis-labels" aria-hidden="true"><span>↑ 24h excess return vs {scatter.benchmark} (pp)</span><span>→ 1h asset return (%)</span></div>
          <ScatterPlot benchmark={scatter.benchmark} cutoff={frame.cutoff_ms} xAxis={xAxis} yAxis={yAxis}
            other={otherPoints} pullbacks={pullbackPoints} selected={selected} select={select}
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
        <p className="mp-panel-footnote" title={`Owner rank changes in places. Observed cutoff ${new Date(frame.cutoff_ms).toISOString()}.`}>
          {rank.available
            ? `${rank.totalImproving + rank.totalWeakening} movers · ${rank.unchanged} unchanged · ${rank.expected}/${rank.expected} matched · baseline ${rank.baselineCutoff == null ? "unavailable" : `${new Date(rank.baselineCutoff).toISOString().slice(11, 16)} UTC`}`
            : rank.reason}
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
                <Bar dataKey="delta" name="Rank movement (places)" barSize={18} isAnimationActive={false} cursor="pointer" radius={3}
                  onClick={(item: unknown) => { const id = (item as { payload?: { instrumentId?: string } } | null)?.payload?.instrumentId; if (id) select(id); }}>
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
        {relativeTrend && <div className="mp-relative-trend" title={relativeChange?.definition ?? undefined}>
          <span className="mp-kicker">Cohort relative strength vs {benchmark}</span>
          <strong className={relativeChange!.value! > 0 ? "mp-up" : relativeChange!.value! < 0 ? "mp-down" : undefined}>{relativeTrend}</strong>
          <small>median 24h excess return {numberText(relativeChange!.value, 2, true)} pp over 1h · {relativeChange!.valid}/{relativeChange!.expected} matched</small>
        </div>}
      </article>
    </div>
  );
}
