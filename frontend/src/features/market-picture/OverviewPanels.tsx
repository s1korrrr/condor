import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
} from "recharts";
import { heatmapColor, heatmapAreas, histogramMembers, histogramBinIndex } from "./model.mjs";
import {
  metricText,
  numberText,
  type DisplayFrame,
} from "./presentation";
import { RingGauge } from "@/features/quant-ops/kit/gauges";
import { TileGrid } from "@/features/quant-ops/kit/grid";
import { Empty, Panel } from "./Primitives";

export function MarketHeatmapPanel({
  frame,
  selected,
  select,
  cohort,
  sector,
  setSector,
}: {
  frame: DisplayFrame | null;
  selected: string | null;
  select: (id: string) => void;
  cohort: Set<string>;
  sector: string;
  setSector: (s: string) => void;
}) {
  const [equal, setEqual] = useState(false),
    [showList, setShowList] = useState(false);
  const assets = frame?.assets ?? [];
  const sectors = ["All", ...new Set(assets.map((a) => a.sector))].sort(
    (a, b) => (a === "All" ? -1 : b === "All" ? 1 : a.localeCompare(b)),
  );
  const visible = assets.filter((a) => sector === "All" || a.sector === sector);
  const layout = heatmapAreas(assets.map(a => a.weight), equal);
  const areas = new Map(assets.map((asset, index) => [asset.instrument_id, layout.areas[index]]));
  const mode = layout.equalSize ? "Equal size" : "Size: activity-scaled prior-day quote volume";
  const data = visible.filter((a) => a.returns["1440"]?.value != null).map((a) => ({
    name: a.symbol,
    id: a.instrument_id,
    value: areas.get(a.instrument_id),
    change: a.returns["1440"]?.value ?? null,
  }));
  return (
    <Panel
      id="mp-heatmap"
      title="Market heatmap"
      detail={`${visible.length} / ${frame?.expected ?? 0} symbols · 24h`}
      className="mp-heatmap"
      actions={
        <button
          className="mp-text-button"
          aria-pressed={showList}
          onClick={() => setShowList(!showList)}
        >
          {showList ? "Tiles" : "Accessible list"}
        </button>
      }
    >
      <div className="mp-heatmap-controls">
        {sectors.length > 2 ? (
        <div className="mp-sector-chips">
          {sectors.map((s) => (
            <button
              key={s}
              aria-pressed={sector === s}
              onClick={() => setSector(s)}
            >
              {s}
            </button>
          ))}
        </div>
        ) : <span />}
        <select
          aria-label="Heatmap tile sizing"
          value={equal ? "equal" : "activity"}
          onChange={(e) => setEqual(e.target.value === "equal")}
        >
          <option value="activity">Activity size</option>
          <option value="equal">Equal size</option>
        </select>
      </div>
      <div className="mp-heatmap-plot">
        {!data.length ? (
          <Empty>No assets in this sector.</Empty>
        ) : showList ? (
          <div className="mp-heatmap-list">
            {visible.map((a) => (
              <button
                key={a.instrument_id}
                aria-pressed={selected === a.instrument_id}
                onClick={() => select(a.instrument_id)}
              >
                <strong>{a.symbol}</strong>
                <span>{metricText(a.returns["1440"], 2, true)}</span>
                <small>{a.sector}</small>
              </button>
            ))}
          </div>
        ) : (
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 1, height: 1 }}
          >
            <Treemap
              data={data}
              dataKey="value"
              nameKey="name"
              aspectRatio={1.7}
              isAnimationActive={false}
              content={(node) => {
                if (node.depth === 0) return <g />;
                const id = String(node.id),
                  change = typeof node.change === "number" ? node.change : null;
                const label = `${node.name} · ${change == null ? "—" : numberText(change, 2, true) + "%"} · 24h`;
                return (
                  <g
                    role="button"
                    tabIndex={-1}
                    aria-label={label}
                    onClick={() => select(id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        select(id);
                      }
                    }}
                    className="mp-heatmap-tile"
                    data-selected={selected === id || undefined}
                    data-cohort={cohort.has(id) || undefined}
                  >
                    <title>
                      {label}
                      {change !== null && Math.abs(change) > 10
                        ? " · color saturated beyond ±10%"
                        : ""}
                    </title>
                    <rect
                      x={node.x + 1}
                      y={node.y + 1}
                      width={Math.max(0, node.width - 2)}
                      height={Math.max(0, node.height - 2)}
                      rx={1}
                      fill={heatmapColor(change)}
                      stroke={
                        selected === id
                          ? "#E6F0FA"
                          : cohort.has(id)
                            ? "#F5C85B"
                            : "#050D18"
                      }
                      strokeWidth={selected === id || cohort.has(id) ? 2 : 1}
                    />
                    {node.width > 32 && node.height > 23 && (
                      <text
                        x={node.x + node.width / 2}
                        y={
                          node.y + node.height / 2 - (node.height > 42 ? 4 : -4)
                        }
                        textAnchor="middle"
                        fill="#ECF7FF"
                        fontSize={node.width > 70 ? 13 : 10}
                        fontWeight={600}
                      >
                        {node.name}
                      </text>
                    )}
                    {node.width > 42 && node.height > 42 && (
                      <text
                        x={node.x + node.width / 2}
                        y={node.y + node.height / 2 + 13}
                        textAnchor="middle"
                        fill="#ECF7FF"
                        fontSize={10}
                      >
                        {change === null
                          ? "—"
                          : numberText(change, 1, true) + "%"}
                        {change !== null && Math.abs(change) > 10 ? " ↗" : ""}
                      </text>
                    )}
                  </g>
                );
              }}
            />
          </ResponsiveContainer>
        )}
      </div>
      <div className="mp-color-legend">
        <span>≤ −10%</span>
        <i />
        <span>0%</span>
        <i />
        <span>≥ +10%</span>
      </div>
      <footer className="mp-panel-footnote">
        {mode} · {assets.filter((a) => a.weight === null).length} missing
        weights
        {layout.equalSize ? (equal ? "" : "; no qualified positive activity weights")
          : "; square-root area, minimum 5% of median positive weight applied"}
        . Sector selection only changes these tiles.
      </footer>
    </Panel>
  );
}

export function ReturnDistributionPanel({
  frame,
  selectCohort,
}: {
  frame: DisplayFrame | null;
  selectCohort: (ids: string[], label: string) => void;
}) {
  const distribution = frame?.distribution["1440"];
  const bins =
    distribution?.counts.map((count, index) => {
      const low = index === 0 ? -Infinity : distribution.edges[index - 1];
      const high =
        index === distribution.counts.length - 1
          ? Infinity
          : distribution.edges[index];
      return {
        index,
        count,
        low,
        high,
        label:
          low === -Infinity
            ? `<${high}%`
            : high === Infinity
              ? `>${low}%`
              : `${low.toFixed(1)}…${high.toFixed(1)}%`,
        negative: high <= 0,
      };
    }) ?? [];
  const choose = (index: number) => {
    const bin = bins[index];
    if (!bin || !frame) return;
    selectCohort(
      histogramMembers(
        frame.assets,
        (a) => a.returns["1440"]?.value ?? null,
        bin.low,
        bin.high,
        index === bins.length - 2,
      ),
      `${bin.label} · 24h`,
    );
  };
  return (
    <Panel
      id="mp-distribution"
      title="Return distribution"
      detail="24h"
      className="mp-distribution"
    >
      <div className="mp-distribution-plot">
        {distribution && distribution.total > 0 ? (
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 1, height: 1 }}
          >
            <BarChart
              data={bins}
              margin={{ left: -25, right: 4, top: 14, bottom: 0 }}
              barCategoryGap={1}
            >
              <CartesianGrid vertical={false} stroke="#143047" />
              <XAxis
                dataKey="index"
                tickFormatter={(i) =>
                  i === 0 ? `${numberText(distribution.edges[0], 1)}%` : i === Math.ceil(distribution.edges.length / 2) ? "0%" : i === distribution.edges.length ? `${numberText(distribution.edges.at(-1)!, 1, true)}%` : ""
                }
                interval={0}
                tick={{ fill: "#91A6B9", fontSize: 10 }}
                stroke="#17415B"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: "#91A6B9", fontSize: 10 }}
                stroke="none"
              />
              <Tooltip
                contentStyle={{
                  background: "#0B2032",
                  border: "1px solid #17415B",
                  fontSize: 12,
                }}
                labelFormatter={(i) => bins[Number(i)]?.label ?? ""}
              />
              {distribution.median.value != null && (
                <ReferenceLine
                  x={histogramBinIndex(distribution.median.value, distribution.edges)}
                  stroke="#E6F0FA"
                  label={{
                    value: `Median ${metricText(distribution.median, 1, true)}`,
                    fill: "#C8DAE9",
                    fontSize: 10,
                    position: "insideTop",
                  }}
                />
              )}
              <Bar
                dataKey="count"
                name="Symbols"
                isAnimationActive={false}
                onClick={(_, index) => choose(index)}
              >
                {bins.map((b) => (
                  <Cell
                    key={b.index}
                    fill={b.negative ? "#FF536A" : "#00D9A0"}
                    cursor="pointer"
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <Empty>No instrument has a qualified 24h return yet.</Empty>
        )}
      </div>
      <label className="mp-bin-select">
        Highlight a return cohort{" "}
        <select
          value=""
          aria-label="Highlight assets in a histogram bin"
          onChange={(e) => {
            if (e.target.value !== "") choose(Number(e.target.value));
          }}
        >
          <option value="">Choose a bin</option>
          {bins.map((b) => (
            <option key={b.index} value={b.index}>
              {b.label}: {b.count} symbols
            </option>
          ))}
        </select>
      </label>
      <div className="mp-distribution-stats">
        <div className="mp-down">
          <span>Negative</span>
          <strong>{metricText(frame?.breadth["1440"]?.negative)}</strong>
        </div>
        <div>
          <span>Flat</span>
          <strong>{metricText(frame?.breadth["1440"]?.flat)}</strong>
        </div>
        <div className="mp-up">
          <span>Positive</span>
          <strong>{metricText(frame?.breadth["1440"]?.positive)}</strong>
        </div>
      </div>
      <footer className="mp-panel-footnote">
        Mean {metricText(distribution?.mean)} · σ{" "}
        {metricText(distribution?.dispersion)} · N{" "}
        {distribution?.total ?? 0} / {frame?.expected ?? 0} · fixed bins + tails
        <details>
          <summary>Distribution detail</summary>
          <p>Downside magnitude {metricText(distribution?.downside)} · max(−mean return, 0). This describes the mean loss magnitude, not a probability or tail risk.</p>
          <p>Best {distribution?.bestInstrument ?? "—"} · worst {distribution?.worstInstrument ?? "—"}.</p>
        </details>
      </footer>
    </Panel>
  );
}

const PREDICATES = [
  ["above_ema21", "Above EMA21", "Close > EMA21", "var(--mp-positive)"],
  ["rsi_above_50", "RSI > 50", "RSI14 above 50", "var(--mp-positive)"],
  ["rsi_above_70", "RSI > 70", "RSI14 overbought", "var(--mp-negative)"],
  ["rsi_below_30", "RSI < 30", "RSI14 oversold", "var(--mp-negative)"],
  ["trending", "Trending", "ADX14 > 25", "var(--mp-accent)"],
  ["compression", "Compression", "ATR14 percentile ≤ 20", "var(--mp-pressure)"],
  ["elevated_rvol", "Elevated RVOL", "20-bar baseline > 1.5×", "var(--mp-warning)"],
  ["high_volatility", "High vol", "> 80% annualized", "var(--mp-warning)"],
] as const;

/** Share of the universe satisfying each observed predicate; a ring per predicate. */
export function ParticipationPanel({
  frame,
  selectPredicate,
}: {
  frame: DisplayFrame | null;
  selectPredicate: (predicate: string) => void;
}) {
  const rings = PREDICATES.flatMap(([key, label, hint, color]) => {
    const metric = frame?.participation[key];
    if (!metric || metric.value == null) return [];
    const delta = frame?.comparisons[`participation/${key}`];
    const count = Math.round(metric.value * metric.valid);
    return [
      <RingGauge
        key={key}
        ratio={metric.value}
        label={label}
        valueText={metricText(metric, 0)}
        note={`${count} of ${metric.valid} · ${hint}`}
        tip={`${count} of ${metric.valid} instruments · ${metric.definition}`}
        color={color}
        onClick={() => selectPredicate(key)}
        delta={
          delta?.value == null
            ? null
            : { text: `${metricText(delta, 1, true)} · 1h`, tone: delta.value < 0 ? "negative" : delta.value > 0 ? "positive" : "neutral" }
        }
      />,
    ];
  });
  if (!rings.length) return null;
  return (
    <Panel
      id="mp-participation"
      title="Market participation"
      detail="Share of instruments · 1m observations"
      className="mp-participation"
    >
      <TileGrid min={132} label="Participation predicates">{rings}</TileGrid>
      <footer className="mp-panel-footnote">
        Predicates overlap. Each share uses its own qualified denominator. Select one to highlight its members.
      </footer>
    </Panel>
  );
}
