import {
  Area,
  Brush,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { HORIZONS, HORIZON_LABELS, marketPulseWindow } from "./model.mjs";
import {
  type DisplayFrame,
  type HistoryPoint,
  type Horizon,
  metricText,
} from "./presentation";
import { Delta, Empty, Metric, Panel, Quality, Sparkline } from "./Primitives";

export function MarketSummaryStrip({
  frame,
  history,
  horizon,
  setHorizon,
}: {
  frame: DisplayFrame | null;
  history: HistoryPoint[];
  horizon: Horizon;
  setHorizon: (h: Horizon) => void;
}) {
  const breadth = frame?.breadth[horizon];
  const summaries = [
    ["Market participation", "market_participation", "Above EMA21 · 1m"],
    ["Relative volume", "relative_volume_24h", "Median · prior 24h baseline"],
    ["Trend strength", "trend_strength", "Mean ADX14 · 0–100"],
    [
      "Realized volatility",
      "realized_volatility_24h",
      "Median · 24h annualized",
    ],
  ];
  return (
    <div
      className="mp-summary-strip"
      aria-label="Admitted-universe market summary"
    >
      <section className="mp-summary-card mp-breadth-card">
        <h2>Market breadth</h2>
        <div className="mp-breadth-horizons">
          {HORIZONS.map((h, i) => (
            <button
              key={h}
              aria-pressed={h === horizon}
              onClick={() => setHorizon(h)}
              title={`${HORIZON_LABELS[i]} · ${frame?.breadth[h]?.valid ?? 0}/${frame?.expected ?? 0} valid`}
            >
              <span>{HORIZON_LABELS[i]}</span>
              <Metric metric={frame?.breadth[h]?.positive} digits={0} />
              <Sparkline
                values={history.flatMap((p) => p.gapBefore ? [null, p.breadth[h]?.positive ?? null] : [p.breadth[h]?.positive ?? null])}
                label={`${HORIZON_LABELS[i]} advancing share history`}
              />
            </button>
          ))}
        </div>
      </section>
      <section className="mp-summary-card">
        <h2>
          Advances / declines{" "}
          <small>{HORIZON_LABELS[HORIZONS.indexOf(horizon)]}</small>
        </h2>
        <div className="mp-adu">
          <div className="mp-up">
            {breadth?.advancing ?? "—"}
            <small>
              <Metric metric={breadth?.positive} />
            </small>
          </div>
          <div className="mp-down">
            {breadth?.declining ?? "—"}
            <small>
              <Metric metric={breadth?.negative} />
            </small>
          </div>
          <div className="mp-neutral">
            {breadth?.unchanged ?? "—"}
            <small>
              <Metric metric={breadth?.flat} />
            </small>
          </div>
        </div>
        <div className="mp-share-bar" aria-hidden="true">
          {breadth &&
            [
              breadth.positive.value,
              breadth.negative.value,
              breadth.flat.value,
            ].map((v, i) => <span key={i} style={{ flexGrow: v ?? 0 }} />)}
        </div>
        <Quality valid={breadth?.valid ?? 0} expected={frame?.expected ?? 0} />
      </section>
      {summaries.map(([title, key, hint]) => (
        <section className="mp-summary-card" key={key}>
          <h2>{title}</h2>
          <div className="mp-summary-value">
            <Metric metric={frame?.summary[key]} />
          </div>
          <small>{hint}</small>
          <Delta metric={frame?.comparisons[`summary/${key}`]} />
          <Sparkline
            values={history.flatMap((p) => p.gapBefore ? [null, p.summary[key] ?? null] : [p.summary[key] ?? null])}
            label={`${title} history`}
          />
          <span className="mp-summary-quality">
            <Quality
              valid={frame?.summary[key]?.valid ?? 0}
              expected={frame?.expected ?? 0}
            />
          </span>
        </section>
      ))}
      <section className="mp-summary-card mp-coverage-card">
        <h2>Coverage</h2>
        <strong>
          {frame ? `${frame.valid} / ${frame.expected}` : "Unavailable"}
        </strong>
        <small>
          {frame
            ? `${frame.quote} · ${frame.universeId}`
            : "Observation source pending"}
        </small>
        <div className="mp-coverage-track">
          <span
            style={{
              width: frame?.expected
                ? `${(frame.valid / frame.expected) * 100}%`
                : "0%",
            }}
          />
        </div>
        <button
          className="mp-text-button"
          onClick={() => document.getElementById("mp-coverage-button")?.click()}
        >
          Inspect sources ↗
        </button>
      </section>
    </div>
  );
}

/** Coverage changes within a partial universe are just as material as a full/partial flip. */
function coverageChangePoints(history: HistoryPoint[]): HistoryPoint[] {
  return history.filter((point, index) => {
    if (index === 0) return false;
    const previous = history[index - 1];
    return point.membership !== previous.membership ||
      point.valid !== previous.valid || point.expected !== previous.expected;
  });
}

export function MarketPulsePanel({
  frame,
  history,
  horizon,
  window,
  setHorizon,
  setWindow,
  replay,
}: {
  frame: DisplayFrame | null;
  history: HistoryPoint[];
  horizon: Horizon;
  window: string;
  setHorizon: (h: Horizon) => void;
  setWindow: (w: string) => void;
  replay: (id: string) => void;
}) {
  const coverage = marketPulseWindow(history, window);
  const samples = coverage.samples.map((p) => ({
    ...p,
    ...p.breadth[horizon],
    positive:
      p.breadth[horizon]?.positive == null
        ? null
        : p.breadth[horizon].positive! * 100,
    negative:
      p.breadth[horizon]?.negative == null
        ? null
        : p.breadth[horizon].negative! * 100,
    flat:
      p.breadth[horizon]?.flat == null ? null : p.breadth[horizon].flat! * 100,
  }));
  const points = samples.flatMap((p) =>
    p.gapBefore
      ? [
          {
            ...p,
            time: p.time - 1,
            snapshot_id: null,
            positive: null,
            negative: null,
            flat: null,
            pressure: null,
          },
          p,
        ]
      : [p],
  );
  const breadth = frame?.breadth[horizon];
  const coverageChanges = coverageChangePoints(coverage.samples);
  return (
    <Panel
      id="mp-pulse"
      title="Market Pulse"
      detail="Admitted-universe breadth & pressure"
      className="mp-pulse"
      actions={
        <div className="mp-segment">
          {HORIZONS.map((h, i) => (
            <button
              key={h}
              aria-pressed={h === horizon}
              onClick={() => setHorizon(h)}
            >
              {HORIZON_LABELS[i]}
            </button>
          ))}
        </div>
      }
    >
      <div className="mp-chart-legend">
        <span className="mp-up">
          ● Advancing <Metric metric={breadth?.positive} digits={0} />
        </span>
        <span className="mp-down">
          ● Declining <Metric metric={breadth?.negative} digits={0} />
        </span>
        <span className="mp-neutral">
          ● Unchanged <Metric metric={breadth?.flat} digits={0} />
        </span>
        <span className="mp-pressure-color">● Breadth pressure · RHS</span>
      </div>
      <div
        className="mp-pulse-plot"
        aria-label="Market breadth history from zero to 100 percent with pressure from minus three to three"
      >
        {points.length ? (
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 1, height: 1 }}
          >
            <ComposedChart
              data={points}
              margin={{ top: 12, left: -18, right: -12, bottom: 0 }}
              onClick={(state) => {
                const point =
                  state.activeTooltipIndex != null
                    ? points[Number(state.activeTooltipIndex)]
                    : null;
                if (point?.snapshot_id) replay(point.snapshot_id);
              }}
            >
              <defs>
                <linearGradient
                  id="mp-pressure-fill"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor="#A67CFF" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#A67CFF" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#143047" vertical={false} />
              <XAxis
                dataKey="time"
                minTickGap={40}
                tickFormatter={(t) => new Date(t).toISOString().slice(11, 16)}
                tick={{ fill: "#91A6B9", fontSize: 10 }}
                stroke="#17415B"
              />
              <YAxis
                yAxisId="share"
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tickFormatter={(v) => `${v}%`}
                tick={{ fill: "#91A6B9", fontSize: 10 }}
                stroke="none"
              />
              <YAxis
                yAxisId="pressure"
                orientation="right"
                domain={[-3, 3]}
                ticks={[-3, -1.5, 0, 1.5, 3]}
                tick={{ fill: "#A67CFF", fontSize: 10 }}
                stroke="none"
              />
              <Tooltip
                contentStyle={{
                  background: "#0B2032",
                  border: "1px solid #17415B",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelFormatter={(t, entries) => {
                  const point = entries?.[0]?.payload as
                    | { valid?: number; expected?: number }
                    | undefined;
                  const coverage = point?.valid != null && point?.expected != null
                    ? ` · ${point.valid}/${point.expected} valid`
                    : "";
                  return `${new Date(Number(t)).toISOString()}${coverage}`;
                }}
                formatter={(value, name) => [
                  value == null
                    ? "Unavailable"
                    : `${Number(value).toFixed(2)}${name === "Pressure" ? "" : "%"}`,
                  name,
                ]}
              />
              {[
                [-3, -1.5, "Extreme Bear", "#ff536a"],
                [-1.5, -0.5, "Bear", "#ff536a"],
                [-0.5, 0.5, "Neutral", "#91a6b9"],
                [0.5, 1.5, "Bull", "#00d9a0"],
                [1.5, 3, "Extreme Bull", "#00d9a0"],
              ].map(([low, high, label, color]) => (
                <ReferenceArea
                  key={String(label)}
                  yAxisId="pressure"
                  y1={Number(low)}
                  y2={Number(high)}
                  fill={String(color)}
                  fillOpacity={0.025}
                  stroke="none"
                  label={{
                    value: label,
                    position: "insideRight",
                    fill: String(color),
                    fontSize: 8,
                  }}
                />
              ))}
              <ReferenceLine
                yAxisId="pressure"
                y={0}
                stroke="#74559c"
                strokeDasharray="3 5"
              />
              {coverageChanges.map((p) => (
                <ReferenceLine
                  key={p.time}
                  x={p.time}
                  yAxisId="share"
                  stroke="#F5C85B"
                  strokeDasharray="2 4"
                />
              ))}
              <Area
                yAxisId="pressure"
                dataKey="pressure"
                name="Pressure"
                type="linear"
                stroke="#A67CFF"
                fill="url(#mp-pressure-fill)"
                baseValue={-3}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                yAxisId="share"
                dataKey="positive"
                name="Advancing"
                stroke="#00D9A0"
                strokeWidth={1.6}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                yAxisId="share"
                dataKey="negative"
                name="Declining"
                stroke="#FF536A"
                strokeWidth={1.4}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                yAxisId="share"
                dataKey="flat"
                name="Unchanged"
                stroke="#7C91A6"
                strokeWidth={1}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Brush
                ariaLabel="Select the visible market-history time range"
                dataKey="time"
                height={16}
                stroke="#17415B"
                fill="#081725"
                tickFormatter={(t) => new Date(t).toISOString().slice(11, 16)}
              />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <Empty>
            Stored breadth history is unavailable. New observations appear after
            the source publishes a frame.
          </Empty>
        )}
      </div>
      <div className="mp-pulse-tools">
        <span className="mp-panel-detail" role="status">{coverage.label}</span>
        <div className="mp-segment">
          {["6h", "24h", "7d"].map((w) => (
            <button
              key={w}
              aria-pressed={w === window}
              onClick={() => setWindow(w)}
            >
              {w}
            </button>
          ))}
        </div>
        <label className="mp-history-select">
          Replay{" "}
          <select
            aria-label="Inspect a stored historical frame"
            value=""
            onChange={(e) => {
              if (e.target.value) replay(e.target.value);
            }}
          >
            <option value="">Choose a recorded time</option>
            {coverage.samples
              .filter((p) => p.snapshot_id)
              .map((p) => (
                <option value={p.snapshot_id!} key={p.snapshot_id}>
                  {new Date(p.time).toISOString()} · {p.valid}/{p.expected} ·{" "}
                  {p.source_kind}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div
        className="mp-pulse-footer"
        title="Breadth pressure = 3 × (advancing − declining) / valid population. Descriptive balance, not trade flow or probability."
      >
        {[
          ["Breadth", breadth?.positive],
          ["Pressure", frame?.pressure[horizon]],
          ["New highs · 24h", frame?.summary.new_highs_24h],
          ["New lows · 24h", frame?.summary.new_lows_24h],
          ["52W highs · daily", frame?.summary.highs_52w],
          ["52W lows · daily", frame?.summary.lows_52w],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <span>{String(label)}</span>
            <strong
              title={
                typeof value === "object" && value?.available
                  ? `Available ${new Date(value.available).toISOString()}`
                  : undefined
              }
            >
              {metricText(
                typeof value === "object" ? value : undefined,
                label === "Pressure" ? 2 : label === "Breadth" ? 1 : 0,
              )}
            </strong>
            {(label === "Breadth" || label === "Pressure") && (
              <Delta
                metric={
                  frame?.comparisons[
                    `${label === "Breadth" ? "breadth" : "pressure"}/${horizon}`
                  ]
                }
              />
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
