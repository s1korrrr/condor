import { useMemo } from "react";
import { TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { SparkChart } from "@/features/quant-ops/kit/charts";
import { TileGrid } from "@/features/quant-ops/kit/grid";
import { CHART, type ChartSeries, type SeriesPoint } from "@/features/quant-ops/kit/series";
import { useElementWidth } from "@/features/quant-ops/kit/useElementWidth";
import { HORIZONS, HORIZON_LABELS } from "./model.mjs";
import {
  breadthLadder,
  horizonLabel,
  marketVerdict,
  pulseSeries,
  VERDICT_THRESHOLD,
} from "./pulse.mjs";
import {
  type DisplayFrame,
  type HistoryPoint,
  type Horizon,
  metricText,
  metricTitle,
  numberText,
} from "./presentation";
import { Metric } from "./Primitives";

/** Coverage changes within a partial universe are just as material as a full/partial flip. */
function coverageChangePoints(history: HistoryPoint[]): HistoryPoint[] {
  return history.filter((point, index) => {
    if (index === 0) return false;
    const previous = history[index - 1];
    return point.membership !== previous.membership ||
      point.valid !== previous.valid || point.expected !== previous.expected;
  });
}

const signed = (value: number, digits = 2) =>
  `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
const percent = (value: number) => `${value.toFixed(0)}%`;

/** Diverging bar for a -1..+1 score: fills from the centre toward risk-on or risk-off. */
function ScoreBar({ score, marks = false }: { score: number; marks?: boolean }) {
  const magnitude = Math.min(1, Math.abs(score)) * 50;
  return (
    <span className="mp-score" aria-hidden="true">
      <i
        className="mp-score__fill"
        data-side={score >= 0 ? "on" : "off"}
        style={score >= 0 ? { left: "50%", width: `${magnitude}%` } : { right: "50%", width: `${magnitude}%` }}
      />
      <i className="mp-score__zero" />
      {marks && (
        <>
          <i className="mp-score__mark" style={{ left: `${50 - VERDICT_THRESHOLD * 50}%` }} />
          <i className="mp-score__mark" style={{ left: `${50 + VERDICT_THRESHOLD * 50}%` }} />
        </>
      )}
    </span>
  );
}

/** Verdict plus the three transparent components behind it. */
function VerdictCard({ frame, horizon }: { frame: DisplayFrame | null; horizon: Horizon }) {
  const verdict = useMemo(() => marketVerdict(frame, horizon), [frame, horizon]);
  if (!frame || !verdict)
    return (
      <div className="mp-verdict" data-state="loading" aria-busy="true">
        <span className="mp-skeleton" style={{ height: 22, width: "40%" }} />
        <span className="mp-skeleton" style={{ height: 54, width: "70%" }} />
        <span className="mp-skeleton" style={{ height: 12 }} />
      </div>
    );
  const mean = frame.distribution[horizon]?.mean;
  return (
    <div className="mp-verdict" data-state={verdict.state} title={verdict.rule}>
      <span className="mp-kicker">
        Market state · {horizonLabel(horizon)} · {frame.expected} instruments
      </span>
      <strong className="mp-verdict__word" aria-label={`Market state: ${verdict.label}`}>
        <span aria-hidden="true">{verdict.state === "risk-on" ? "▲" : verdict.state === "risk-off" ? "▼" : "◆"}</span>
        {verdict.label}
      </strong>
      <div className="mp-verdict__meter">
        <ScoreBar score={verdict.score} marks />
        <span className="mp-verdict__ends">
          <span>Risk-off</span>
          <b>{signed(verdict.score)}</b>
          <span>Risk-on</span>
        </span>
      </div>
      <p className="mp-verdict__counts">
        <span className="mp-up">{verdict.advancing ?? "—"} advancing</span>
        <span className="mp-down">{verdict.declining ?? "—"} declining</span>
        <span className="mp-neutral">{verdict.unchanged ?? "—"} unchanged</span>
        {mean?.value != null && (
          <span title={metricTitle(mean)}>mean {metricText(mean, 2, true)}</span>
        )}
      </p>
      <ul className="mp-verdict__parts" aria-label="Verdict components">
        {verdict.components.map((c) => (
          <li key={c.id} title={c.detail}>
            <span>{c.label}</span>
            <ScoreBar score={c.score} />
            <small>{c.detail}</small>
          </li>
        ))}
      </ul>
      <details className="mp-verdict__rule">
        <summary>How is this decided?</summary>
        <p>{verdict.rule}</p>
      </details>
    </div>
  );
}

/** Advancing / unchanged / declining share for every horizon; click one to drive the hero. */
function BreadthLadder({
  frame,
  horizon,
  setHorizon,
}: {
  frame: DisplayFrame | null;
  horizon: Horizon;
  setHorizon: (h: Horizon) => void;
}) {
  const rows = useMemo(() => breadthLadder(frame), [frame]);
  if (!rows.length) return null;
  return (
    <div className="mp-ladder" role="group" aria-label="Breadth by horizon">
      <span className="mp-kicker">Breadth by horizon</span>
      {rows.map((row) => {
        const tip = `${row.label}: ${row.advancing} advancing · ${row.unchanged} unchanged · ${row.declining} declining of ${row.valid}/${row.expected} valid${row.pressure == null ? "" : ` · pressure ${signed(row.pressure)}`}`;
        return (
          <button
            key={row.horizon}
            className="mp-ladder__row"
            aria-pressed={row.horizon === horizon}
            onClick={() => setHorizon(row.horizon as Horizon)}
            title={tip}
            aria-label={tip}
          >
            <span className="mp-ladder__label">{row.label}</span>
            <span className="mp-ladder__bar" aria-hidden="true">
              <i data-side="up" style={{ flexGrow: row.up }} />
              <i data-side="flat" style={{ flexGrow: row.flat }} />
              <i data-side="down" style={{ flexGrow: row.down }} />
            </span>
            <span className="mp-ladder__value">
              <b className="mp-up">{row.advancing}</b>
              <span>/</span>
              <b className="mp-down">{row.declining}</b>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function MarketPulseHero({
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
  const pulse = useMemo(() => pulseSeries(history, window, horizon), [history, window, horizon]);
  const markers = useMemo(
    () => coverageChangePoints(pulse.samples).map((p) => ({ time: p.time, label: "Coverage changed" })),
    [pulse.samples],
  );
  const series = useMemo<ChartSeries[]>(
    () => [
      {
        id: "pressure",
        label: "Breadth pressure",
        color: CHART.violet,
        points: pulse.pressure,
        area: true,
        signSplit: { positive: CHART.positive, negative: CHART.negative },
        fillOpacity: 0.7,
        format: (v: number) => signed(v),
      },
      { id: "advancing", label: "Advancing share", color: CHART.blue, points: pulse.advancing, axis: "secondary", tooltipOnly: true, format: percent },
      { id: "declining", label: "Declining share", color: CHART.negative, points: pulse.declining, axis: "secondary", tooltipOnly: true, format: percent },
    ],
    [pulse],
  );
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const breadth = frame?.breadth[horizon];
  const hasHistory = pulse.advancing.some((p) => p.value !== null);
  const replayable = pulse.samples.filter((p) => p.snapshot_id);
  return (
    <section id="mp-pulse" className="mp-hero" aria-labelledby="mp-pulse-title">
      <header className="mp-hero__head">
        <h2 id="mp-pulse-title">Market Pulse</h2>
        <span className="mp-panel-detail">Observed breadth &amp; pressure across the admitted universe</span>
        <div className="mp-segment" role="group" aria-label="Breadth horizon">
          {HORIZONS.map((h, i) => (
            <button key={h} aria-pressed={h === horizon} onClick={() => setHorizon(h as Horizon)}>
              {HORIZON_LABELS[i]}
            </button>
          ))}
        </div>
      </header>
      <div className="mp-hero__body">
        <aside className="mp-hero__side">
          <VerdictCard frame={frame} horizon={horizon} />
          <BreadthLadder frame={frame} horizon={horizon} setHorizon={setHorizon} />
        </aside>
        <div className="mp-hero__chart" ref={ref}>
          <div className="mp-chart-legend">
            <span className="mp-up">
              ▲ {breadth?.advancing ?? "—"} advancing <Metric metric={breadth?.positive} digits={0} />
            </span>
            <span className="mp-down">
              ▼ {breadth?.declining ?? "—"} declining <Metric metric={breadth?.negative} digits={0} />
            </span>
            <span className="mp-pressure-color">
              ● Breadth pressure{" "}
              <Metric metric={frame?.pressure[horizon]} digits={2} signed /> · −3…+3
            </span>
          </div>
          {hasHistory ? (
            <TimeSeriesChart
              series={series}
              markers={markers}
              height={width > 0 && width < 560 ? 240 : 360}
              domains={{ left: [-3, 3], right: [0, 100] }}
              zeroLine
              leftFormat={(v) => signed(v, 1)}
              rightFormat={percent}
              ariaLabel={`Advancing and declining share with breadth pressure over ${window}, ${horizonLabel(horizon)} horizon`}
              emptyText="Recording market history. The chart fills as frames are stored."
            />
          ) : (
            <div className="mp-hero__recording" role="status">
              <span className="mp-skeleton" style={{ height: 220 }} />
              <p>Recording market history. The chart fills as frames are stored.</p>
            </div>
          )}
          <div className="mp-pulse-tools">
            <span className="mp-panel-detail" role="status">{pulse.label}</span>
            <div className="mp-segment" role="group" aria-label="History window">
              {["6h", "24h", "7d"].map((w) => (
                <button key={w} aria-pressed={w === window} onClick={() => setWindow(w)}>
                  {w}
                </button>
              ))}
            </div>
            {replayable.length > 0 && (
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
                  {replayable.slice(-240).reverse().map((p) => (
                    <option value={p.snapshot_id!} key={p.snapshot_id}>
                      {new Date(p.time).toISOString().slice(0, 16).replace("T", " ")} · {p.valid}/{p.expected}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
      </div>
      <footer
        className="mp-panel-footnote"
        title="Breadth pressure = 3 × (advancing − declining) / valid population. Descriptive balance, not trade flow or probability."
      >
        Pressure = 3 × (advancing − declining) ÷ valid instruments · descriptive balance, not trade flow or probability.
      </footer>
    </section>
  );
}

interface Tile {
  key: string;
  label: string;
  value: string;
  hint: string;
  title: string;
  points: SeriesPoint[];
  format: (value: number) => string;
  delta: string | null;
  deltaTone: string;
}

const SNAPSHOT = [
  ["market_participation", "Participation", "Above EMA21 · 1m", "share"],
  ["trend_strength", "Trend strength", "Mean ADX14 · 0–100", "adx"],
  ["realized_volatility_24h", "Realized volatility", "Median · 24h annualized", "share"],
  ["relative_volume_24h", "Relative volume", "Median · vs prior 24h baseline", "ratio"],
] as const;

/** Compact market-wide tiles that sit under the hero. Tiles without a value are not drawn. */
export function MarketSnapshotTiles({
  frame,
  history,
  window,
}: {
  frame: DisplayFrame | null;
  history: HistoryPoint[];
  window: string;
}) {
  const samples = useMemo(() => pulseSeries(history, window, "15").samples, [history, window]);
  if (!frame) return null;
  const tiles = SNAPSHOT.flatMap<Tile>(([key, label, hint, kind]) => {
    const metric = frame.summary[key];
    if (!metric || metric.value == null) return [];
    const points = samples.map((p) => ({ time: p.time, value: p.summary[key] ?? null }));
    const digits = kind === "ratio" && metric.value < 0.1 ? 3 : kind === "ratio" ? 2 : kind === "adx" ? 1 : 0;
    const count = key === "market_participation" ? Math.round(metric.value * metric.valid) : null;
    const delta = frame.comparisons[`summary/${key}`];
    return [
      {
        key,
        label,
        value: metricText(metric, digits),
        hint: count == null ? hint : `${count} of ${metric.valid} instruments · ${hint}`,
        title: metricTitle(metric),
        points,
        format: (v: number) =>
          kind === "share" ? `${(v * 100).toFixed(0)}%` : numberText(v, digits),
        delta: delta?.value == null ? null : `${metricText(delta, 1, true)} · 1h`,
        deltaTone: delta?.value == null ? "" : delta.value < 0 ? "mp-down" : "mp-up",
      },
    ];
  });
  const breaks = [frame.summary.new_highs_24h, frame.summary.new_lows_24h];
  if (breaks.every((m) => m?.value != null))
    tiles.push({
      key: "range_breaks",
      label: "New highs / lows",
      value: `${metricText(breaks[0], 0)} / ${metricText(breaks[1], 0)}`,
      hint: `Instruments breaking their 24h range · of ${frame.expected}`,
      title: `${metricTitle(breaks[0])} | ${metricTitle(breaks[1])}`,
      points: samples.map((p) => ({ time: p.time, value: (p.summary.new_highs_24h ?? 0) - (p.summary.new_lows_24h ?? 0) })),
      format: (v: number) => `net ${signed(v, 0)}`,
      delta: null,
      deltaTone: "",
    });
  tiles.push({
    key: "coverage",
    label: "Coverage",
    value: `${frame.valid} / ${frame.expected}`,
    hint: `${frame.quote} · ${frame.universeId}`,
    title: `${frame.valid} of ${frame.expected} admitted instruments have a qualified observation`,
    points: [],
    format: (v: number) => String(v),
    delta: null,
    deltaTone: "",
  });
  return (
    <TileGrid min={170} label="Market summary" className="mp-tiles">
      {tiles.map((tile) => (
        <article className="mp-tile" key={tile.key} title={tile.title}>
          <h3>{tile.label}</h3>
          <strong>{tile.value}</strong>
          <small>{tile.hint}</small>
          {tile.delta && <small className={tile.deltaTone}>{tile.delta}</small>}
          {tile.points.filter((p) => p.value != null).length >= 2 && (
            <SparkChart points={tile.points} height={34} format={tile.format} ariaLabel={`${tile.label} over ${window}`} color={CHART.blue} />
          )}
        </article>
      ))}
    </TileGrid>
  );
}
