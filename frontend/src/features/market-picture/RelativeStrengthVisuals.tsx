import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART } from "@/features/quant-ops/kit/series";
import { Empty } from "./Primitives";
import {
  projectRelativeRankMovers,
  projectRelativeStrength,
  type RelativeRankMover,
  type RelativeScatterPoint,
} from "./relative-visuals.mjs";
import type { DisplayFrame } from "./presentation";

const number = (value: number, unit: string) => `${value > 0 ? "+" : ""}${value.toFixed(2)} ${unit}`;
const axisTick = (value: number) => Number(value.toPrecision(3)).toString();

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

/** Owner-value relative return views; interaction remains available through native buttons. */
export function RelativeStrengthVisuals({
  frame,
  benchmark,
  select,
  selected,
}: {
  frame: DisplayFrame;
  benchmark: string;
  select: (id: string) => void;
  selected: string | null;
}) {
  const scatter = projectRelativeStrength(frame.assets, benchmark);
  const rank = projectRelativeRankMovers(frame);
  const rankExtent = Math.max(1, ...rank.rows.map(row => Math.abs(row.delta)));
  const otherPoints = scatter.points.filter((point) => !point.pullback);
  const pullbackPoints = scatter.points.filter((point) => point.pullback);

  return (
    <div className="mp-visual-grid">
      <article className="mp-visual-card" aria-labelledby="mp-relative-map-title">
        <header><h3 id="mp-relative-map-title">Absolute return vs relative strength</h3><span className="mp-kicker">Price participation</span></header>
        <p className="mp-panel-footnote">
          X: owner 1h asset return (%) · Y: owner 24h arithmetic excess return vs {scatter.benchmark} (pp).
          Diamonds mark the existing pullback predicate: positive excess return and negative 1h return.
          {` ${scatter.valid}/${scatter.expected} qualified; ${scatter.omitted} missing or unavailable. Observed cutoff ${new Date(frame.cutoff_ms).toISOString()}.`}
        </p>
        {scatter.points.length ? <>
          <div className="mp-visual-axis-labels"><span>X · 1h asset return (%)</span><span>Y · 24h excess return vs {scatter.benchmark} (pp)</span></div>
          <div role="img" aria-label={`Scatter plot at observed cutoff ${new Date(frame.cutoff_ms).toISOString()}. Horizontal axis is one-hour asset return in percent. Vertical axis is twenty-four-hour arithmetic excess return versus ${scatter.benchmark} in percentage points. Vertical and horizontal zero lines divide positive and negative values. Diamonds identify existing pullback candidates.`} style={{ width: "100%", height: 290 }}>
            <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
              <ScatterChart margin={{ top: 12, right: 18, bottom: 20, left: 12 }}>
                <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="oneHourReturn"
                  name="1h asset return"
                  unit="%"
                  tickFormatter={axisTick}
                  tick={{ fill: CHART.muted, fontSize: 10 }}
                  stroke={CHART.muted}
                />
                <YAxis
                  type="number"
                  dataKey="relativeReturn"
                  name={`24h excess return vs ${scatter.benchmark}`}
                  unit=" pp"
                  tickFormatter={axisTick}
                  tick={{ fill: CHART.muted, fontSize: 10 }}
                  stroke={CHART.muted}
                  width={48}
                />
                <ReferenceLine x={0} stroke={CHART.neutral} strokeDasharray="4 4" />
                <ReferenceLine y={0} stroke={CHART.neutral} strokeDasharray="4 4" />
                <Tooltip isAnimationActive={false} cursor={{ stroke: CHART.muted, strokeDasharray: "3 4" }} content={<RelativeTooltip />} />
                <Scatter name="Other qualified instruments" data={otherPoints} fill={CHART.blue} shape="circle" isAnimationActive={false} />
                <Scatter name="Pullback predicate" data={pullbackPoints} fill={CHART.warning} shape="diamond" isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <details>
            <summary>Inspect {scatter.valid} plotted instruments</summary>
            <div className="mp-table-scroll" tabIndex={0} role="region" aria-label="Relative-strength scatter data">
              <table className="mp-table">
              <caption>Qualified scatter points at observed cutoff {new Date(frame.cutoff_ms).toISOString()}; select a symbol to open its existing instrument drawer.</caption>
                <thead><tr><th scope="col">Instrument</th><th scope="col">1h return (%)</th><th scope="col">24h excess vs {scatter.benchmark} (pp)</th><th scope="col">Predicate</th></tr></thead>
                <tbody>{scatter.points.map((point) => <tr key={point.instrumentId}>
                  <th scope="row"><button type="button" aria-pressed={selected === point.instrumentId} onClick={() => select(point.instrumentId)}>{point.symbol}</button></th>
                  <td>{number(point.oneHourReturn, "%")}</td>
                  <td>{number(point.relativeReturn, "pp")}</td>
                  <td>{point.pullback ? "Pullback condition" : "Other qualified point"}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </details>
        </> : <Empty>No qualified 1h return and 24h {scatter.benchmark} excess-return pairs.</Empty>}
      </article>

      <article className="mp-visual-card" aria-labelledby="mp-relative-rank-chart-title">
        <header><h3 id="mp-relative-rank-chart-title">One-hour relative-rank movement</h3><span className="mp-kicker">Matched cohort</span></header>
        <p className="mp-panel-footnote">
          Owner rank changes in places; positive means improvement. {rank.available
            ? `${rank.displayed} displayed of ${rank.totalImproving + rank.totalWeakening} movers · ${rank.unchanged} unchanged · ${rank.expected}/${rank.expected} instruments matched · baseline ${rank.baselineCutoff == null ? "unavailable" : new Date(rank.baselineCutoff).toISOString()}.`
            : rank.reason}{` Observed cutoff ${new Date(frame.cutoff_ms).toISOString()}.`}
        </p>
        {rank.available && rank.rows.length ? <>
          <div className="mp-visual-axis-labels"><span>X · rank movement (places; positive improves)</span></div>
          <div role="img" aria-label={`Horizontal bar chart at observed cutoff ${new Date(frame.cutoff_ms).toISOString()}, of up to five improving and five weakening relative ranks, measured in places over one hour. Positive bars mean improvement. ${rank.displayed} shown of ${rank.totalImproving + rank.totalWeakening} movers; ${rank.unchanged} unchanged.`} style={{ width: "100%", height: Math.max(230, rank.rows.length * 27) }}>
            <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
              <BarChart data={rank.rows} layout="vertical" margin={{ top: 8, right: 18, bottom: 8, left: 8 }}>
                <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" />
                <XAxis type="number" dataKey="delta" domain={[-rankExtent, rankExtent]} allowDecimals={false} tickFormatter={(value: number) => String(value)} tick={{ fill: CHART.muted, fontSize: 10 }} stroke={CHART.muted} />
                <YAxis type="category" dataKey="symbol" width={72} tick={{ fill: CHART.muted, fontSize: 10 }} stroke={CHART.muted} />
                <ReferenceLine x={0} stroke={CHART.neutral} />
                <Tooltip isAnimationActive={false} cursor={{ fill: CHART.grid, fillOpacity: 0.45 }} content={<RankTooltip />} />
                <Bar dataKey="delta" name="Rank movement (places)" maxBarSize={28} isAnimationActive={false}>
                  {rank.rows.map((row) => <Cell key={row.instrumentId} fill={row.delta > 0 ? CHART.positive : CHART.negative} />)}
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
        </> : <Empty>{rank.available ? "No relative ranks moved during the one-hour comparison." : "Rank movement is unavailable until a complete matched one-hour owner baseline is present."}</Empty>}
      </article>
    </div>
  );
}
