import { memo, useMemo, useState } from "react";
import { BarsChart, SparkChart, TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { TileGrid } from "@/features/quant-ops/kit/grid";
import { CHART, axisScale, type ChartSeries, type SeriesPoint } from "@/features/quant-ops/kit/series";
import { ageState, HORIZONS, HORIZON_LABELS, marketPulseWindow } from "./model.mjs";
import {
  canonicalVerdictHistoryFault,
  horizonLabel,
  isSingleBarRelativeVolume,
  marketVerdict,
  pulseSeries,
  VERDICT_HOLD,
  VERDICT_THRESHOLD,
} from "./pulse.mjs";
import {
  type DisplayFrame,
  type DisplayMetric,
  type HistoryPoint,
  type Horizon,
  dailyFeatureText,
  metricText,
  metricTitle,
  numberText,
} from "./presentation";
import { Metric, Panel } from "./Primitives";
import { selectMetricCohort, type MetricCohortRequest } from "./metric-cohort.mjs";
import { BreadthTimeline } from "./BreadthTimeline";
import { MOMENTUM_INTERVALS, momentumHorizon, momentumRetained, qualifiedDivergence } from "./breadth-timeline.mjs";
import { availabilityItems, currentDivergence, DAILY_COLUMNS, FLOW_HISTORY_POINTS, flowHistoryRetained, dailyColumnQualified, sourceFamilyReadings, type SourceFamilyReading } from "./availability";
import { MicrostructureVisuals } from "./MicrostructureVisuals";
import { rowTimeState } from "./observation-state";
import { flowHistoryVisuals } from "./flow-history-visuals.mjs";

const signed = (value: number, digits = 2) =>
  `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;

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
function VerdictCard({
  frame,
  horizon,
  history,
  historyFault,
  smooth,
  asOf = frame?.available_at_ms ?? Date.now(),
  historical = false,
}: {
  frame: DisplayFrame | null;
  horizon: Horizon;
  history: HistoryPoint[] | null;
  historyFault?: string | null;
  smooth: boolean;
  asOf?: number;
  historical?: boolean;
}) {
  const historyUnavailable = historyFault ?? (history ? canonicalVerdictHistoryFault(history, horizon, frame?.cutoff_ms ?? NaN) : "Canonical six-hour history is unavailable.");
  const verdict = useMemo(
    () => history && !historyUnavailable ? marketVerdict(frame, horizon, { history, smooth }) : null,
    [frame, horizon, history, historyUnavailable, smooth],
  );
  const freshness = ageState(frame, asOf, false).freshness;
  if (frame && freshness !== "FRESH")
    return (
      <div className="mp-verdict" data-state="unavailable">
        <span className="mp-kicker">Market state · {horizonLabel(horizon)}</span>
        <strong className="mp-verdict__word">Unavailable · {freshness}</strong>
        <p className="mp-panel-footnote">
          This observation cannot support a current verdict. Recorded values keep their original observation time and expiry.
        </p>
      </div>
    );
  if (frame && historyUnavailable)
    return (
      <div className="mp-verdict" data-state="unavailable">
        <span className="mp-kicker">Market state · {horizonLabel(horizon)}</span>
        <strong className="mp-verdict__word mp-verdict__word--pending">Waiting for 6h history</strong>
        <p className="mp-panel-footnote" title="The verdict replays the stored one-minute frames of the last six hours under one membership and definition. The chart window is never used as a substitute.">
          The verdict replays stored one-minute frames from the last six hours under one definition. {historyUnavailable}
        </p>
      </div>
    );
  if (!frame || !verdict)
    return (
      <div className="mp-verdict" data-state="loading" aria-busy="true">
        <span className="mp-skeleton" style={{ height: 22, width: "40%" }} />
        <span className="mp-skeleton" style={{ height: 54, width: "70%" }} />
        <span className="mp-skeleton" style={{ height: 12 }} />
      </div>
    );
  return (
    <div className="mp-verdict" data-state={historical ? "historical" : verdict.state} title={verdict.rule}>
      <span className="mp-kicker">
        {historical ? "Recorded market state" : "Market state"} · {horizonLabel(horizon)} · {frame.expected} instruments
      </span>
      <strong className="mp-verdict__word" aria-label={`${historical ? "Recorded market state" : "Market state"}: ${verdict.label}`}>
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
        <small className="mp-verdict__basis" role="status">
          {historical && `Recorded as of ${new Date(asOf).toISOString()} · `}
          {verdict.smoothed
            ? `${verdict.smoothingMinutes}-min mean of ${verdict.smoothedFrames} frames · latest frame ${signed(verdict.instantScore)}`
            : "Latest frame only"}
          {verdict.held
            ? ` · ${verdict.label} held until the score is inside ±${VERDICT_HOLD.toFixed(2)}`
            : ""}
        </small>
        {verdict.replaySince != null && (
          <small className="mp-verdict__replay" data-short={verdict.replayResetAt != null || undefined}>
            {verdict.replayResetKind === "current"
              ? "Held state starts at this frame · frames just before it were not stored"
              : verdict.replayResetKind === "gap"
                ? `Replayed from ${hhmm(verdict.replaySince)} UTC · stored gap at ${hhmm(verdict.replayResetAt!)} reset the held state to Mixed`
                : verdict.replayResetKind === "start"
                  ? `Replayed from ${hhmm(verdict.replaySince)} UTC · no stored frames before it in the six-hour window`
                  : `Replayed from stored frames since ${hhmm(verdict.replaySince)} UTC`}
          </small>
        )}
      </div>
      <ul className="mp-verdict__parts" aria-label="Verdict components">
        {verdict.components.map((c) => (
          <li key={c.id} title={c.detail}>
            <span>{c.label}</span>
            <b className={c.score > 0 ? "mp-up" : c.score < 0 ? "mp-down" : undefined}>{signed(c.score)}</b>
            <ScoreBar score={c.score} />
            <small className="sr-only">{c.detail}</small>
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

const hhmm = (time: number) => new Date(time).toISOString().slice(11, 16);

type PulseRow = {
  time: number; valid: number; expected: number; gapBefore: boolean; pressure: Array<number | null>;
  momentum: Array<{ change: number | null; matched: number; expected: number } | null>; divergence: string;
};

/** Accessible table of the retained observations in view; the newest 300 rows, newest first. */
function PulseDataTable({ samples, label, horizon }: { samples: HistoryPoint[]; label: string; horizon: Horizon }) {
  const momentum = useMemo(() => momentumRetained(samples), [samples]);
  const trajectoryHorizon = momentumHorizon(horizon);
  const rows = useMemo<PulseRow[]>(() => samples.slice(-300).reverse().map(point => {
    const flags = MOMENTUM_INTERVALS.map(interval => [interval, qualifiedDivergence(point, interval)] as const).filter(([, value]) => value !== null);
    return {
      time: point.time, valid: point.valid, expected: point.expected, gapBefore: point.gapBefore,
      pressure: HORIZONS.map(h => point.breadth?.[h]?.pressure ?? null),
      momentum: MOMENTUM_INTERVALS.map(interval => point.breadthTrajectory?.[`${trajectoryHorizon}/${interval}`] ?? null),
      divergence: !flags.length ? "—" : flags.some(([, value]) => value === 1)
        ? `observed · ${flags.filter(([, value]) => value === 1).map(([interval]) => `Δ${interval}m`).join(", ")}` : "not observed",
    };
  }), [samples, trajectoryHorizon]);
  return (
    <div className="mp-table-scroll mp-pulse-data__scroll" tabIndex={0} role="region" aria-labelledby="mp-pulse-data-caption">
      <table className="mp-table" id="mp-pulse-data-table">
        <caption id="mp-pulse-data-caption">Breadth pressure (−3…+3) by horizon{momentum ? ` · matched momentum at ${horizonLabel(trajectoryHorizon)}` : ""} · {label} · newest first{samples.length > rows.length ? ` · newest ${rows.length} of ${samples.length}` : ""}</caption>
        <thead><tr><th scope="col">UTC time</th><th scope="col">Coverage</th>{HORIZON_LABELS.map(h => <th key={h} scope="col">{h}</th>)}
          {momentum && <>{MOMENTUM_INTERVALS.map(interval => <th key={interval} scope="col" title={`Matched pressure change over ${interval}m at the ${horizonLabel(trajectoryHorizon)} horizon (−2…+2)`}>Δ{interval}m · {horizonLabel(trajectoryHorizon)}</th>)}
            <th scope="col">BTC divergence</th></>}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.time}>
          <th scope="row"><time dateTime={new Date(row.time).toISOString()}>{new Date(row.time).toISOString().slice(0, 16).replace("T", " ")}</time>{row.gapBefore ? " · after gap" : ""}</th>
          <td>{row.valid}/{row.expected}</td>
          {row.pressure.map((value, index) => <td key={index} className={value == null || value === 0 ? undefined : value > 0 ? "mp-up" : "mp-down"}>{value == null ? "—" : signed(value)}</td>)}
          {momentum && <>{row.momentum.map((cell, index) => <td key={`m${index}`} className={cell?.change == null || cell.change === 0 ? undefined : cell.change > 0 ? "mp-up" : "mp-down"}>
            {cell?.change == null ? "—" : `${signed(cell.change)}${cell.matched < cell.expected ? ` · ${cell.matched}/${cell.expected}` : ""}`}</td>)}
            <td>{row.divergence}</td></>}
        </tr>)}</tbody>
      </table>
    </div>
  );
}

const zoomText = (range: [number, number]) => {
  const fmt = (time: number) => new Date(time).toISOString().slice(range[1] - range[0] > 36 * 3_600_000 ? 5 : 11, 16).replace("T", " ");
  return `${fmt(range[0])}–${fmt(range[1])} UTC`;
};

export function MarketPulseHero({
  frame,
  history,
  canonicalHistory = null,
  canonicalHistoryFault = null,
  horizon,
  window,
  setHorizon,
  setWindow,
  replay,
  asOf,
  historical = false,
  onSelectMetric,
  zoom = null,
  onZoom,
}: {
  frame: DisplayFrame | null;
  history: HistoryPoint[];
  canonicalHistory?: HistoryPoint[] | null;
  canonicalHistoryFault?: string | null;
  horizon: Horizon;
  window: string;
  setHorizon: (h: Horizon) => void;
  setWindow: (w: string) => void;
  replay: (id: string) => void;
  asOf?: number;
  historical?: boolean;
  onSelectMetric?: (request: MetricCohortRequest) => void;
  zoom?: [number, number] | null;
  onZoom: (range: [number, number] | null) => void;
}) {
  const [dataTableOpen, setDataTableOpen] = useState(false);
  const { samples, label } = useMemo(() => marketPulseWindow(history, window), [history, window]);
  const visible = useMemo(() => zoom ? samples.filter(point => point.time >= zoom[0] && point.time <= zoom[1]) : samples, [samples, zoom]);
  const breadth = frame?.breadth[horizon];
  const showMomentum = useMemo(() => momentumRetained(samples), [samples]);
  // Current BTC divergence: shown only while a qualified owner value is current (same rule as the availability line).
  const divergence = useMemo(() => frame ? currentDivergence(frame, asOf ?? frame.available_at_ms) : null, [frame, asOf]);
  return (
    <section id="mp-pulse" className="mp-hero" aria-labelledby="mp-pulse-title">
      <header className="mp-hero__head">
        <h2 id="mp-pulse-title">Market Pulse</h2>
        <span className="mp-panel-detail">Breadth across the admitted universe · {frame ? `${frame.expected} instruments` : "loading"}</span>
        <div className="mp-hero__controls">
          <span className="mp-kicker" aria-hidden="true">Horizon</span>
          <div className="mp-segment" role="group" aria-label="Breadth horizon">
            {HORIZONS.map((h, i) => (
              <button key={h} aria-pressed={h === horizon} onClick={() => setHorizon(h as Horizon)}>
                {HORIZON_LABELS[i]}
              </button>
            ))}
          </div>
          <span className="mp-kicker" aria-hidden="true">Window</span>
          <div className="mp-segment" role="group" aria-label="History window">
            {["6h", "24h", "7d"].map((w) => (
              <button key={w} aria-pressed={w === window && !zoom} onClick={() => { onZoom(null); setWindow(w); }}>
                {w}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="mp-hero__body">
        <aside className="mp-hero__side">
          <VerdictCard frame={frame} horizon={horizon} history={canonicalHistory} historyFault={canonicalHistoryFault} smooth asOf={asOf} historical={historical} />
          <div className="mp-hero__counts" role="group" aria-label={`${horizonLabel(horizon)} breadth now · select to filter instruments`}>
            <span className="mp-kicker">{horizonLabel(horizon)} breadth{frame && Number.isFinite(frame.cutoff_ms) ? ` · frame ${new Date(frame.cutoff_ms).toISOString().slice(11, 16)} UTC` : ""}</span>
            <button type="button" className="mp-up" disabled={!onSelectMetric || !frame} aria-label={`Filter instruments: ${horizonLabel(horizon)} advancing`} onClick={() => onSelectMetric?.({ kind: "breadth", horizon, side: "advancing" })}>
              <b>▲ {breadth?.advancing ?? "—"}</b><span>advancing <Metric metric={breadth?.positive} digits={0} /></span>
            </button>
            <button type="button" className="mp-down" disabled={!onSelectMetric || !frame} aria-label={`Filter instruments: ${horizonLabel(horizon)} declining`} onClick={() => onSelectMetric?.({ kind: "breadth", horizon, side: "declining" })}>
              <b>▼ {breadth?.declining ?? "—"}</b><span>declining <Metric metric={breadth?.negative} digits={0} /></span>
            </button>
            <button type="button" disabled={!onSelectMetric || !frame} aria-label={`Filter instruments: ${horizonLabel(horizon)} unchanged`} onClick={() => onSelectMetric?.({ kind: "breadth", horizon, side: "unchanged" })}>
              <b>◆ {breadth?.unchanged ?? "—"}</b><span>unchanged</span>
            </button>
            <span className="mp-hero__pressure" title="Breadth pressure = 3 × (advancing − declining) ÷ valid instruments">
              Pressure <Metric metric={frame?.pressure[horizon]} digits={2} signed /> <small>of −3…+3</small>
            </span>
            {divergence && <span className="mp-tag mp-hero__divergence" data-on={divergence.observed.length ? true : undefined}
              title="BTC confirmed close beyond its prior 24h range while matched 15m breadth change opposes it. Descriptive, not predictive.">
              BTC vs 15m breadth · {divergence.observed.length
                ? <b>diverging ({divergence.observed.map(interval => `Δ${interval}m`).join(", ")})</b>
                : `not diverging at ${hhmm(divergence.time)}`}
            </span>}
          </div>
        </aside>
        <div className="mp-hero__chart">
          <BreadthTimeline samples={samples} horizon={horizon} setHorizon={setHorizon} zoom={zoom} onZoom={onZoom} replay={replay} />
          <div className="mp-pulse-tools">
            <span className="mp-panel-detail" role="status">
              {label} · colour = breadth pressure per horizon (green advancing, red declining) · bars = {horizonLabel(horizon)} advancing and declining share
              {showMomentum ? " · Δ rows = matched breadth change (momentum) · BTC÷ ticks = price–breadth divergence" : ""}
            </span>
            {zoom
              ? <button type="button" className="mp-zoom-chip" onClick={() => onZoom(null)} aria-label={`Reset zoom ${zoomText(zoom)}`}>Zoom {zoomText(zoom)} <b>×</b></button>
              : <span className="mp-panel-detail mp-hint" title="Keyboard: focus the chart, Shift+arrows select a range, Enter zooms, minus resets">Drag to zoom · click a column to pin it</span>}
          </div>
          <details className="mp-pulse-data" onToggle={(event) => setDataTableOpen(event.currentTarget.open)}>
            <summary>Breadth data table · {visible.length} retained observations</summary>
            {dataTableOpen && <PulseDataTable samples={visible} label={label} horizon={horizon} />}
          </details>
        </div>
      </div>
    </section>
  );
}

/** Deterministic source-family summary. Correlated price measures stay one family. */
export function EvidenceMatrixPanel({
  frame,
  horizon,
  asOf = frame.available_at_ms,
}: {
  frame: DisplayFrame;
  horizon: Horizon;
  asOf?: number;
}) {
  const breadth = frame.breadth[horizon];
  const pressure = frame.pressure[horizon];
  const freshness = ageState(frame, asOf, false).freshness;
  const validBreadth = freshness === "FRESH" && breadth?.positive.status === "VALID" && pressure?.status === "VALID";
  const completeBreadth = validBreadth && breadth.positive.valid === breadth.positive.expected &&
    pressure.valid === pressure.expected;
  const pressureValue = validBreadth ? pressure?.value : null;
  const familyRows = [
    {
      family: "Price & participation",
      state: freshness !== "FRESH" ? freshness : !validBreadth ? "UNAVAILABLE" : completeBreadth ? "OBSERVED" : "PARTIAL",
      evidence: validBreadth
        ? `${metricText(breadth.positive, 0)} advancing · pressure ${metricText(pressure, 2, true)} · ${horizonLabel(horizon)}`
        : "Breadth or pressure is unavailable for this horizon.",
    },
    ...sourceFamilyReadings(frame, asOf),
  ];
  const continuation = !validBreadth || pressureValue == null
    ? "Continuation conditions are unavailable because this breadth horizon is not qualified."
    : pressureValue > 0
      ? `Pressure is currently above zero. Continuation remains conditional on advancing share staying at or above ${metricText(breadth.positive, 0)} and pressure staying above zero.`
      : pressureValue < 0
        ? `Pressure is currently below zero. Continued weakness would require it to remain below zero; improvement requires a cross above zero.`
        : "Pressure is currently at zero. Continuation is not established; a move above zero would indicate positive breadth pressure.";
  const deterioration = pressureValue == null
    ? "Deterioration trigger is unavailable because breadth pressure is not qualified."
    : pressureValue < 0
      ? `${horizonLabel(horizon)} breadth pressure is already below zero; that is the current deterioration sign, not a future cross.`
      : `A cross below zero in ${horizonLabel(horizon)} breadth pressure would describe deterioration; it is not a forecast.`;
  return (
    <Panel id="mp-evidence" title="Evidence families" detail="Observed measurements stay separate by source and meaning">
      <details className="mp-evidence-details">
      <summary>{Object.entries(familyRows.reduce<Record<string, string[]>>((groups, row) => {
        (groups[row.state] ??= []).push(row.family);
        return groups;
      }, {})).map(([state, families]) => <span key={state} className="mp-evidence-group" data-state={state}><b>{state.toLowerCase()}</b> {families.length === 1 ? families[0] : `${families.length} families`}</span>)}</summary>
      <div className="mp-evidence-grid">
        {familyRows.map((row) => (
          <article key={row.family} className="mp-evidence-row">
            <strong>{row.family}</strong>
            <span data-state={row.state}>{row.state}</span>
            <small>{row.evidence}</small>
          </article>
        ))}
      </div>
      <p className="mp-panel-footnote">
        {validBreadth
          ? `Deterministic reading: ${metricText(breadth.positive, 0)} of valid assets advanced; pressure is ${metricText(pressure, 2, true)}. Breadth, returns and other price-derived measures count as one correlated family.`
          : "Deterministic reading unavailable until breadth and pressure qualify. Related price-derived measures count as one correlated family."}
      </p>
      <div className="mp-evidence-scenarios" aria-label="Conditional scenarios">
        <p><b>Continuation condition</b> · {continuation}</p>
        <p><b>Deterioration condition</b> · {deterioration}</p>
      </div>
      </details>
    </Panel>
  );
}

/** One compact line of chips; each names a missing family and its reason, with the full detail on hover. */
export function AvailabilityLine({ frame, asOf, horizon, benchmark = "BTC", history, window = "24h", historyFault = null, onOpen }: {
  frame: DisplayFrame; asOf: number; horizon: Horizon; benchmark?: string;
  /** Retained history; with it the line also names history panels the page leaves out. */
  history?: HistoryPoint[]; window?: string; historyFault?: string | null; onOpen?: () => void;
}) {
  const items = useMemo(() => availabilityItems(frame, asOf, horizon, benchmark,
    history ? { samples: marketPulseWindow(history, window).samples, fault: historyFault } : null), [frame, asOf, horizon, benchmark, history, window, historyFault]);
  if (!items.length) return null;
  return (
    <section className="mp-availability" aria-label="Not available in this frame">
      <span className="mp-kicker">Not shown · {items.length}</span>
      <ul>{items.map(item => <li key={item.key} title={item.detail}><b>{item.label}</b> <span>{item.reason}</span></li>)}</ul>
      {onOpen && <button type="button" className="mp-text-button" onClick={onOpen}>Coverage &amp; sources ↗</button>}
    </section>
  );
}

const DECIMAL_FORMATTERS = Array.from(
  { length: 5 },
  (_, digits) => new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }),
);

function displayDecimal(value: string | null, digits = 4, signed = false) {
  if (value == null) return "Unavailable";
  const number = Number(value);
  if (!Number.isFinite(number)) return "Invalid";
  const formatter = DECIMAL_FORMATTERS[digits];
  const formatted = formatter
    ? formatter.format(number)
    : number.toLocaleString(undefined, { maximumFractionDigits: digits });
  return `${signed && number > 0 ? "+" : ""}${formatted}`;
}

/** Owner-recorded spot-flow and displayed-book observations. Never estimates depth or actionability. */
function MicrostructurePanelView({ frame, asOf = frame.available_at_ms, only, idPrefix = "mp" }: { frame: DisplayFrame; asOf?: number; only?: "flow" | "liquidity"; idPrefix?: string }) {
  const component = frame.microstructure;
  // Without an owner component the availability line names the missing flow and book families.
  if (!component) return null;
  const flows = only === "liquidity" ? [] : component.flows;
  const books = only === "flow" ? [] : component.liquidity;
  return (
    <Panel id={`${idPrefix}-microstructure`} title="Executed flow &amp; displayed liquidity" detail="Observed quantities from the owner component; price participation remains a separate correlated family">
      <p className="mp-panel-footnote">{component.sourceKind.toUpperCase()} · {component.replayClass.replaceAll("_", " ")} · assessed as of {new Date(asOf).toISOString()} · raw trades/books not retained · digest {component.componentId.slice(0, 12)}…</p>
      <MicrostructureVisuals frame={frame} asOf={asOf} only={only} />
      {flows.length ? <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby={`${idPrefix}-flow-observations-caption`}>
        <table className="mp-table mp-trajectory-table">
          <caption id={`${idPrefix}-flow-observations-caption`}>Executed spot notional by aggressor side · quote {frame.quote}</caption>
          <thead><tr><th>Instrument</th><th>Buy quote</th><th>Sell quote</th><th>Unknown quote</th><th>Unknown share</th><th>Known imbalance</th><th>Confirmation</th><th>Cumulative delta · before → after</th><th>Coverage / source</th></tr></thead>
          <tbody>{flows.map(row => {
            const timeState = rowTimeState(frame, row, asOf);
            if (timeState === "FUTURE") return <tr key={`${row.instrumentId}/${row.sourceId}`}>
              <th scope="row">{row.instrumentId.split(":").at(-1)}</th>
              {Array.from({ length: 7 }, (_, index) => <td key={index}>Unavailable · FUTURE</td>)}
              <td title={`${row.sourceId} · ${row.channel} · available ${row.available} · frame available ${frame.available_at_ms}`}>FUTURE</td>
            </tr>;
            const valid = row.capabilityUsable && row.complete && !row.reasons.length && timeState === "CURRENT";
            const state = timeState !== "CURRENT" ? timeState : !row.capabilityUsable ? "SOURCE NOT QUALIFIED" : row.reasons.length ? row.reasons.join(", ") : row.complete ? "COMPLETE" : "PARTIAL";
            const gapSummary = row.gaps.length ? row.gaps.map(([start, end]) => `${start}–${end}`).join(", ") : "none";
            return <tr key={`${row.instrumentId}/${row.sourceId}`}>
              <th scope="row">{row.instrumentId.split(":").at(-1)}</th>
              <td>{row.quoteAsset} {displayDecimal(row.buyQuote)}</td><td>{row.quoteAsset} {displayDecimal(row.sellQuote)}</td>
              <td>{row.quoteAsset} {displayDecimal(row.unknownQuote)}</td>
              <td>{displayDecimal(row.unknownShare, 3)}</td>
              <td>{displayDecimal(row.knownImbalance, 3, true)}</td>
              <td>{valid ? displayDecimal(row.confirmationImbalance, 3, true) : "Unavailable"}</td>
              <td>{row.cumulativeBefore == null && row.cumulativeAfter == null ? "Unavailable" : `${row.quoteAsset} ${row.cumulativeBefore == null ? "Unavailable" : displayDecimal(row.cumulativeBefore, 2, true)} → ${row.cumulativeAfter == null ? "Unavailable" : displayDecimal(row.cumulativeAfter, 2, true)}`}</td>
              <td title={`${row.sourceId} · ${row.channel} · input ${row.inputDigest} · window ${row.windowStart}–${row.windowEnd} · available ${row.available} · expires ${row.expires} · coverage ${row.coverageStart}–${row.coverageEnd} · reset ${row.resetId} at ${row.resetAt} · gaps ${gapSummary} · ${row.reasons.join(", ")}`}>
                {state} · {row.trades} trades · {row.duplicates} duplicates · reset {row.resetId} · {row.gaps.length} gap{row.gaps.length === 1 ? "" : "s"}
              </td>
            </tr>;
          })}</tbody>
        </table>
      </div> : only !== "liquidity" && <p className="mp-panel-footnote">No executed-flow rows in this owner snapshot.</p>}
      {books.length ? <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby={`${idPrefix}-book-observations-caption`}>
        <table className="mp-table mp-trajectory-table">
          <caption id={`${idPrefix}-book-observations-caption`}>Visible-book walk for recorded order sizes; no orders are sent</caption>
          <thead><tr><th>Instrument</th><th>Side / size</th><th>Covered / uncovered</th><th>Covered VWAP</th><th>Full-size VWAP</th><th>Book cost</th><th>Prior 7d cost percentile · midrank</th><th>Fee / total</th><th>Spread / band</th><th>State</th></tr></thead>
          <tbody>{books.map((row, index) => {
            const timeState = rowTimeState(frame, row, asOf);
            if (timeState === "FUTURE") return <tr key={`${row.instrumentId}/${row.sourceId}/${row.side}/${row.sizeUnit}/${row.requestedSize}/${index}`}>
              <th scope="row">{row.instrumentId.split(":").at(-1)}</th>
              {Array.from({ length: 8 }, (_, column) => <td key={column}>Unavailable · FUTURE</td>)}
              <td title={`${row.sourceId} · ${row.channel} · available ${row.available} · frame available ${frame.available_at_ms}`}>FUTURE</td>
            </tr>;
            const valid = row.capabilityUsable && !row.reasons.length && timeState === "CURRENT";
            const partial = Number(row.uncovered) > 0;
            const bookEstimateValid = row.capabilityUsable && row.access !== "unknown" &&
              timeState === "CURRENT" && !partial &&
              row.vwap != null && row.costBps != null;
            const percentileReasons = row.costPercentileReasons ?? ["INSUFFICIENT_HISTORY"];
            const state = timeState !== "CURRENT" ? timeState : !row.capabilityUsable ? "SOURCE NOT QUALIFIED" : partial ? `PARTIAL DEPTH${row.reasons.length ? ` · ${row.reasons.join(", ")}` : ""}` : row.reasons.length ? row.reasons.join(", ") : "COVERED";
            return <tr key={`${row.instrumentId}/${row.sourceId}/${row.side}/${row.sizeUnit}/${row.requestedSize}/${index}`}>
              <th scope="row">{row.instrumentId.split(":").at(-1)}</th>
              <td>{row.side} · {displayDecimal(row.requestedSize)} {row.sizeUnit}</td>
              <td>{displayDecimal(row.coveredBase)} base / {displayDecimal(row.coveredQuote, 2)} quote · {displayDecimal(row.uncovered)} uncovered</td>
              <td>{row.coveredVwap == null ? "Unavailable" : `${frame.quote} ${displayDecimal(row.coveredVwap)}`}</td>
              <td>{bookEstimateValid ? `${frame.quote} ${displayDecimal(row.vwap)}` : "Unavailable"}</td>
              <td>{bookEstimateValid ? `${displayDecimal(row.costBps, 2, true)} bps` : "Unavailable"}</td>
              <td title={`${percentileReasons.join(", ") || "Qualified against prior seven completed days"}${row.costPercentileReferenceDigest ? ` · reference ${row.costPercentileReferenceDigest}` : ""}`}>
                {timeState !== "CURRENT" ? `Unavailable · ${timeState}` : row.costPercentile7d == null
                  ? `Unavailable · ${percentileReasons.join(", ") || "no owner reason"}`
                  : `${displayDecimal(String(row.costPercentile7d * 100), 1)} percentile`}
                {` · ${row.costPercentileSampleCount ?? 0}/${row.costPercentileExpectedSamples ?? 10080} samples`}
                {row.costPercentileReferenceDigest ? ` · ref ${row.costPercentileReferenceDigest.slice(0, 12)}…` : ""}
              </td>
              <td>{row.feeBps == null ? "Fee unavailable" : `${displayDecimal(row.feeBps, 2)} bps · ${row.feeSource ?? "source unknown"}`} / {valid && row.totalCostBps != null ? `${displayDecimal(row.totalCostBps, 2)} bps` : "total unavailable"}</td>
              <td>{row.spreadBps == null ? "Spread unavailable" : `${displayDecimal(row.spreadBps, 2)} bps`} · ±{displayDecimal(row.bandBps, 1)} bps band · {row.bandComplete ? "complete" : "partial"}</td>
              <td title={`${row.sourceId} · ${row.channel} · sequence ${row.sequence} · ${row.access} · observed ${row.observed} · available ${row.available} · expires ${row.expires} · band bid ${row.bidCovered}, ask ${row.askCovered} · imbalance ${row.bandImbalance ?? "unavailable"} · ${row.reasons.join(", ")}`}>{state}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : only !== "flow" && <p className="mp-panel-footnote">No displayed-liquidity rows in this owner snapshot.</p>}
      <p className="mp-panel-footnote">Confirmation and execution-cost claims require a frame and row available at the assessment time and unexpired. Incomplete flow, unknown aggressor notional, partial book depth, missing fee provenance, and unsupported access remain unavailable; no candle color is used as trade flow.</p>
    </Panel>
  );
}
export const MicrostructurePanel = memo(MicrostructurePanelView);

/** Stored one-minute owner aggregates; points are never summed across gaps or resets. */
function FlowHistoryPanelView({
  history, window, fault,
}: { history: HistoryPoint[]; window: string; fault: string | null }) {
  const { samples, label } = marketPulseWindow(history, window);
  const points: HistoryPoint[] = samples.slice(-FLOW_HISTORY_POINTS);
  const hasFlow = flowHistoryRetained(samples);
  const [selectedQuote, setSelectedQuote] = useState("");
  const quotes = [...new Set(points.flatMap(point => point.flowHistory ? [point.flowHistory.quoteAsset] : []))];
  const quote = quotes.includes(selectedQuote) ? selectedQuote : quotes[0] ?? "";
  const { rows, notional, cvd, breaks } = flowHistoryVisuals(points, quote);
  if (!hasFlow && !fault) return null;
  // Named continuity breaks; the line already stops there, the marker says why.
  const breakMarkers = breaks.map(item => ({ time: item.time, label: `Break · ${item.label}`, color: CHART.warning }));
  const timeDomain: [number, number] | undefined = points.length > 1 ? [points[0].time, points.at(-1)!.time] : undefined;
  const compact = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);
  const notionalSeries: ChartSeries[] = [
    { id: "buy", label: "Buy", color: CHART.positive, points: notional.buy, unit: quote },
    { id: "sell", label: "Sell", color: CHART.negative, dash: "6 4", points: notional.sell, unit: quote },
    { id: "unknown", label: "Unknown side", color: CHART.warning, dash: "2 4", points: notional.unknown, unit: quote },
  ];
  return (
    <Panel id="mp-flow-history" title="Stored executed-flow history" detail="Owner-recorded one-minute totals; no raw tape or client aggregation">
      <p className="mp-panel-footnote" role="status">
        {fault ? `History read degraded · ${fault} · retained values remain tied to their stored times.` : "Stored history read validated."} {label} · showing {points.length} of {samples.length} retained points. Buy, sell and unknown totals are per stored point; they are never summed across gaps.
      </p>
      {hasFlow && <>
        {quotes.length > 1 && <div className="mp-visual-controls"><label>Quote asset <select aria-label="Flow history quote asset" value={quote} onChange={event => setSelectedQuote(event.target.value)}>
          {quotes.map(unit => <option key={unit} value={unit}>{unit}</option>)}
        </select></label></div>}
        <div className="mp-visual-grid">
          <article className="mp-visual-card">
            <header><h3>Executed notional over time</h3><span className="mp-kicker">Recorded trades</span></header>
            <p className="mp-visual-unit">{quote} per stored minute · UTC</p>
            <div className="mp-visual-legend">{notionalSeries.map(item => <span key={item.id}><svg width="26" height="10" aria-hidden="true"><line x1="0" x2="26" y1="5" y2="5" stroke={item.color} strokeWidth="2" strokeDasharray={item.dash} /></svg>{item.label}</span>)}</div>
            <TimeSeriesChart series={notionalSeries} markers={breakMarkers} timeDomain={timeDomain} height={210} leftFormat={compact} includeZero ariaLabel={`Executed buy, sell and unknown notional per stored minute in ${quote}`} />
            <p className="mp-panel-footnote">Unknown-side trades stay separate. Partial instrument coverage remains partial; exact coverage accompanies each point in the table below.</p>
          </article>
          <article className="mp-visual-card">
            <header><h3>Cumulative delta</h3><span className="mp-kicker">Owner-recorded balance</span></header>
            <p className="mp-visual-unit">{quote} · UTC · reset-aware</p>
            <div className="mp-visual-legend"><span>Buy minus sell since the recorded reset</span></div>
            <TimeSeriesChart series={[{id:"cvd", label:"Recorded cumulative delta", color:CHART.blue, points:cvd, unit:quote}]}
              markers={breakMarkers} timeDomain={timeDomain} height={210} leftFormat={compact} zeroLine ariaLabel={`Owner-recorded cumulative delta in ${quote}; gaps, scope changes and resets interrupt the line`}
              emptyText="No qualified owner cumulative delta is retained. Unknown sides and incomplete coverage cannot become a synthetic balance." />
            <p className="mp-panel-footnote">Gaps, resets and changes of source, quote or scope break the line. The browser never accumulates the displayed trade totals. {cvd.at(-1)?.value == null ? "The latest retained point has no qualified cumulative delta." : ""}</p>
          </article>
        </div>
      </>}
      {hasFlow ? <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-flow-history-caption">
        <table className="mp-table mp-trajectory-table">
          <caption id="mp-flow-history-caption">Stored aggregate executed spot flow for the selected window · totals are per point</caption>
          <thead><tr><th scope="col">Stored time</th><th scope="col">Buy quote</th><th scope="col">Sell quote</th><th scope="col">Unknown quote</th><th scope="col">Observed / expected</th><th scope="col">Complete / expected</th><th scope="col">Cumulative delta</th><th scope="col">Continuity</th></tr></thead>
          <tbody>{rows.map(({ point, flow, continuity }) => <tr key={`${point.time}/${point.snapshot_id ?? "none"}`}>
            <th scope="row">{new Date(point.time).toISOString().replace("T", " ").slice(0, 19)} · {point.source_kind}</th>
            {flow ? <>
              <td>{flow.quoteAsset} {displayDecimal(flow.buyQuote, 2)}</td>
              <td>{flow.quoteAsset} {displayDecimal(flow.sellQuote, 2)}</td>
              <td>{flow.quoteAsset} {displayDecimal(flow.unknownQuote, 2)}</td>
              <td>{flow.observedInstruments}/{flow.expectedInstruments}</td>
              <td>{flow.completeInstruments}/{flow.expectedInstruments}</td>
              <td title={`Scope ${flow.scopeHash} · reset ${flow.resetAt ?? "unavailable"} · ${flow.reasons.join(", ")}`}>
                {flow.cumulativeDeltaQuote == null
                  ? `Unavailable · ${flow.reasons.join(", ") || "owner did not qualify a common reset and full known-side coverage"}`
                  : `${flow.quoteAsset} ${displayDecimal(flow.cumulativeDeltaQuote, 2, true)}`}
              </td>
              <td>{continuity}</td>
            </> : <>
              <td>Unavailable</td><td>Unavailable</td><td>Unavailable</td>
              <td>0/{point.expected}</td><td>0/{point.expected}</td>
              <td>Unavailable · no flow aggregate in this stored point</td>
              <td>{continuity}</td>
            </>}
          </tr>)}</tbody>
        </table>
      </div> : <p className="mp-panel-footnote">{samples.length ? "No stored flow aggregates are attached to points in this window." : "No stored history points are available for this window."}</p>}
      {samples.length > points.length && <p className="mp-panel-footnote">Only the newest 300 points are shown in this bounded table; the stored history query remains limited to its existing 1,500-point page.</p>}
    </Panel>
  );
}
export const FlowHistoryPanel = memo(FlowHistoryPanelView);

const HORIZON_SHORT: Record<string, string> = { "1": "1m", "5": "5m", "15": "15m", "60": "1h", "240": "4h", "1440": "24h" };
const shortHorizon = (minutes: number | string) => HORIZON_SHORT[String(minutes)] ?? `${minutes}m`;
/** "sma20_cross_up_count" → "SMA20 cross up"; units go on the value, not the label. */
const hourlyLabel = (key: string) => HOURLY_LABELS[key] ?? key
  .replace(/_count$/, "").replace(/_slope_pct_per_hour_median$/, " slope (median)").replace(/^trend_class_/, "Trend class ")
  .replace(/sma(\d+)/g, "SMA$1").replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
const HOURLY_LABELS: Record<string, string> = {
  above_sma20_share: "Above SMA20", above_sma50_share: "Above SMA50", above_sma200_share: "Above SMA200",
  efficiency_ratio_20_median: "Efficiency ratio (median)",
};
const ANOMALY_DEFINITIONS: Array<[string, string, string]> = [
  ["dictionary_rvol_1h_high", "High 1h relative volume", "Current completed-hour quote turnover ≥2× the median of the prior 20 disjoint completed hours."],
  ["bollinger_inside_ema_atr_compression_1h", "Bollinger / EMA-ATR compression", "The current Bollinger SMA20 ±2 population SD band lies strictly inside EMA20 ±1.5 Wilder ATR20; requires 60 completed hours."],
  ["extreme_realized_volatility_1h_95p", "Extreme 24h realized volatility", "Current sample volatility of 24 hourly log returns exceeds the linear 95th percentile of the prior 720 hourly observations; requires 745 closes."],
];

/**
 * Owner-computed internals as small visuals: cohort returns by horizon, one-basis-point breadth by
 * horizon, hourly cohort internals and candle tags. Only qualified values are drawn; everything
 * missing is named once in the availability line. Exact owner rows stay in the table below.
 */
function BreadthContextPanelView({ frame, select }: { frame: DisplayFrame; select?: (id: string) => void }) {
  const contributions = ["5", "15", "60", "240", "1440"].map(h => frame.contributions[h]).filter(Boolean);
  const returnRows = contributions.map(row => ({ label: shortHorizon(row.horizon), equal: row.equalReturn.value, median: row.medianReturn.value, capped: row.cappedReturn.value }));
  const returnBars = ([["equal", "Equal-weight", CHART.blue], ["median", "Median", CHART.positive], ["capped", "Liquidity-capped", CHART.violet]] as const)
    .filter(([key]) => returnRows.some(row => row[key] != null)).map(([id, label, color]) => ({ id, label, color }));
  const normalized = Object.values(frame.normalizedBreadth).sort((x, y) => x.horizon - y.horizon);
  const breadthRows = normalized.filter(row => row.pressure.value != null).map(row => ({
    label: shortHorizon(row.horizon), pressure: row.pressure.value, advances: row.advances.value, declines: row.declines.value,
  }));
  // Hourly SMA shares are drawn as participation rings; the remaining hourly measures are listed here.
  const hourly = Object.entries(frame.hourlyInternals?.metrics ?? {}).filter(([, metric]) => metric.value != null && metric.unit !== "share_fraction");
  const anomalies = frame.candleAnomalies ? ANOMALY_DEFINITIONS.flatMap(([key, label, definition]) => {
    const metric = frame.candleAnomalies!.metrics[key];
    if (!metric || metric.valid === 0) return [];
    const tagged = frame.assets.filter(asset => metric.values[asset.instrument_id] === 1);
    return [{ key, label, definition, metric, tagged }];
  }) : [];
  const trajectory = frame.breadthTrajectory.filter(row => [row.level, row.change, row.velocity, row.acceleration, row.shareChange].some(metric => metric?.value != null));
  if (!returnBars.length && !breadthRows.length && !hourly.length && !anomalies.length && !trajectory.length) return null;
  const pct = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
  return (
    <Panel id="mp-breadth-context" title="Market internals" detail={`Owner-computed cohort measures · ${frame.valid}/${frame.expected} instruments`}>
      <div className="mp-internals">
        {returnBars.length > 0 && <article className="mp-visual-card">
          <header><h3>Cohort returns by horizon</h3><span className="mp-kicker">Full start cohort</span></header>
          <div className="mp-visual-legend">{returnBars.map(bar => <span key={bar.id}><i className="mp-swatch" style={{ background: bar.color }} />{bar.label}</span>)}</div>
          <BarsChart rows={returnRows} bars={returnBars} height={230} format={pct} tickFormat={(value, step, ticks) => axisScale(step, true, ticks).format(value)} unit="" ariaLabel="Equal-weight and median start-cohort returns by horizon, percent" />
        </article>}
        {breadthRows.length > 0 && <article className="mp-visual-card">
          <header><h3>One-basis-point breadth</h3><span className="mp-kicker">Each instrument one vote</span></header>
          <p className="mp-visual-unit">Pressure −1…+1 · (advances − declines) ÷ valid, moves under 1 bp count as unchanged</p>
          <BarsChart rows={breadthRows} bars={[{ id: "pressure", label: "Pressure", color: CHART.positive, signColors: true }]} height={230} format={value => `${value > 0 ? "+" : ""}${value.toFixed(2)}`} ariaLabel="One-basis-point breadth pressure by horizon" />
        </article>}
        {(hourly.length > 0 || anomalies.length > 0) && <article className="mp-visual-card">
          <header><h3>Hourly internals</h3><span className="mp-kicker">Completed hour {frame.hourlyInternals ? new Date(frame.hourlyInternals.cutoff).toISOString().slice(11, 16) : ""} UTC</span></header>
          {hourly.length > 0 && <dl className="mp-stat-list">{hourly.map(([key, metric]) => <div key={key} title={metricTitle(metric)}>
            <dt>{hourlyLabel(key)}</dt>
            <dd>{metric.unit === "share_fraction" ? <><span className="mp-stat-bar" aria-hidden="true"><i style={{ width: `${Math.round(metric.value! * 100)}%` }} /></span>{Math.round(metric.value! * 100)}%</>
              : key.endsWith("_slope_pct_per_hour_median") ? `${numberText(metric.value, 3, true)}%/hour`
              : metric.unit === "instruments" ? `${metricText(metric, 0)} of ${metric.valid}` : metricText(metric, 3, metric.unit !== "ratio")}</dd>
          </div>)}</dl>}
          {anomalies.length > 0 && <div className="mp-tag-list" aria-label="Hourly candle tags">{anomalies.map(item => <span key={item.key} className="mp-tag" data-on={item.tagged.length ? "" : undefined} title={`${item.definition} · ${item.metric.valid}/${item.metric.expected} valid${item.metric.reasons.length ? ` · ${item.metric.reasons.join(", ")}` : ""}`}>
            {item.label} <b>{item.metric.high ?? 0}/{item.metric.valid}</b>
            {item.tagged.map(asset => select
              ? <button type="button" key={asset.instrument_id} onClick={() => select(asset.instrument_id)}>{asset.symbol}</button>
              : <em key={asset.instrument_id}>{asset.symbol}</em>)}
          </span>)}</div>}
        </article>}
      </div>
      <details className="mp-pulse-data">
        <summary>Owner rows · contributions, breadth{trajectory.length ? ", trajectory" : ""}{frame.hourlyInternals ? ", hourly internals" : ""}</summary>
        <>
          {contributions.length > 0 && <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-return-contribution-caption">
            <table className="mp-table mp-trajectory-table">
              <caption id="mp-return-contribution-caption">Full start-cohort returns and absolute top-five contribution concentration</caption>
              <thead><tr><th>Horizon</th><th>Equal-weight return</th><th>Full-cohort median</th><th>Liquidity-capped return</th><th>Top-five share · equal</th><th>Top-five share · capped</th><th>Cohort</th></tr></thead>
              <tbody>{contributions.map(row => <tr key={row.horizon}>
                <th scope="row">{shortHorizon(row.horizon)}</th>
                <td title={metricTitle(row.equalReturn)}>{metricText(row.equalReturn, 2, true)}</td>
                <td title={metricTitle(row.medianReturn)}>{metricText(row.medianReturn, 2, true)}</td>
                <td title={metricTitle(row.cappedReturn)}>{metricText(row.cappedReturn, 2, true)}</td>
                <td title={metricTitle(row.equalTop5)}>{metricText(row.equalTop5, 1)}</td>
                <td title={metricTitle(row.cappedTop5)}>{metricText(row.cappedTop5, 1)}</td>
                <td>{row.valid}/{row.expected} · {row.startCohortAvailable ? "start cohort evidenced" : "start cohort unavailable"}{row.priorWeightsAvailable ? " · prior weights available" : " · prior weights unavailable"}</td>
              </tr>)}</tbody>
            </table>
          </div>}
          {normalized.length > 0 && <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-normalized-breadth-caption">
            <table className="mp-table mp-trajectory-table">
              <caption id="mp-normalized-breadth-caption">One-basis-point breadth balance; each admitted instrument has one vote</caption>
              <thead><tr><th>Horizon</th><th>Advances</th><th>Declines</th><th>Unchanged</th><th>Pressure · −1…+1</th><th>Coverage</th></tr></thead>
              <tbody>{normalized.map(row => <tr key={row.horizon}>
                <th scope="row">{shortHorizon(row.horizon)}</th>
                <td title={metricTitle(row.advances)}>{metricText(row.advances, 0)}</td>
                <td title={metricTitle(row.declines)}>{metricText(row.declines, 0)}</td>
                <td title={metricTitle(row.unchanged)}>{metricText(row.unchanged, 0)}</td>
                <td title={metricTitle(row.pressure)}>{metricText(row.pressure, 3, true)}</td>
                <td>{row.valid}/{row.expected}</td>
              </tr>)}</tbody>
            </table>
          </div>}
          {trajectory.length > 0 && <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-breadth-trajectory-caption">
            <table className="mp-table mp-trajectory-table">
              <caption id="mp-breadth-trajectory-caption">Matched-universe pressure level and its change, velocity, and acceleration · rows with a qualified value</caption>
              <thead><tr><th>Horizon</th><th>Interval</th><th>Level</th><th>Pressure change</th><th>Advance-share change</th><th>Velocity</th><th>Acceleration</th><th>Matched cohort</th></tr></thead>
              <tbody>{trajectory.map(row => <tr key={`${row.horizon}/${row.interval}`}>
                <th scope="row">{shortHorizon(row.horizon)}</th><td>{row.interval}m</td>
                {[row.level, row.change, row.shareChange, row.velocity, row.acceleration].map((metric, index) => <td key={index} title={metric ? metricTitle(metric) : "Not supplied"}>{metric?.value == null ? "—" : metricText(metric, 3, true)}</td>)}
                <td title={row.membership ?? "No matched membership hash"}>{row.matched}/{row.expected}</td>
              </tr>)}</tbody>
            </table>
          </div>}
          {frame.hourlyInternals && <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-hourly-internals-caption">
            <table className="mp-table mp-trajectory-table">
              <caption id="mp-hourly-internals-caption">Owner-computed hourly cohort internals; no per-asset values are inferred · {frame.hourlyInternals.sourceCount}/{frame.hourlyInternals.expected} sources · digest {frame.hourlyInternals.sourceDigest.slice(0, 12)}…</caption>
              <thead><tr><th scope="col">Hourly metric</th><th scope="col">Value</th><th scope="col">Coverage / reason</th></tr></thead>
              <tbody>{Object.entries(frame.hourlyInternals.metrics).map(([key, metric]) => <tr key={key}>
                <th scope="row">{key.replaceAll("_", " ")}</th>
                <td title={metricTitle(metric)}>{key.endsWith("_slope_pct_per_hour_median") && metric.value != null ? `${numberText(metric.value, 3, true)}%/hour` : metricText(metric, metric.unit === "instruments" ? 0 : 3, true)}</td>
                <td>{metric.valid}/{metric.expected}{metric.reasons.length ? ` · ${metric.reasons.join(", ")}` : ""}</td>
              </tr>)}</tbody>
            </table>
          </div>}
          {frame.candleAnomalies && <p className="mp-panel-footnote">Candle tags · hour cutoff {new Date(frame.candleAnomalies.cutoff).toISOString()} · source coverage {frame.candleAnomalies.sourceCount}/{frame.candleAnomalies.expected} · {frame.candleAnomalies.sourceKind} · digest {frame.candleAnomalies.sourceHash.slice(0, 12)}… · null inputs are not negative observations.</p>}
        </>
      </details>
    </Panel>
  );
}
export const BreadthContextPanel = memo(BreadthContextPanelView);

/** One status cell: ▲/▼ for yes/no facts, signed %/day for slopes, arrows for crosses; tooltip carries the owner status. */
function DailyCell({ cell, quote, note }: { cell: DisplayFrame["dailyInternals"][number]["breaks"][string] | undefined; quote: string; note?: string | null }) {
  if (!cell || cell.metric.value == null)
    return <td className="mp-status-cell" data-tone="empty" title={cell ? `${cell.metric.status} · ${cell.metric.reasons.join(", ") || "no owner reason"} · ${cell.samples}/${cell.required} bars` : "Not supplied"}>·</td>;
  const id = cell.metricId, value = cell.metric.value;
  const title = `${dailyFeatureText(cell.metric, id, cell.label, quote)}${note && !/^daily_sma_(20|50|200)$/.test(id) ? ` · ${note}` : ""} · ${metricTitle(cell.metric)}`;
  if (id.endsWith("_slope_pct_per_day"))
    return <td className="mp-status-cell" data-tone={value > 0 ? "up" : value < 0 ? "down" : "flat"} title={title}>{numberText(value, 2, true)}%</td>;
  if (/^daily_sma_(20|50|200)$/.test(id))
    return <td className="mp-status-cell" data-tone="flat" title={title}>{dailyFeatureText(cell.metric, id, cell.label, quote)}</td>;
  if (id.endsWith("_cross"))
    return <td className="mp-status-cell" data-tone={cell.label === "cross_up" ? "up" : cell.label === "cross_down" ? "down" : "flat"} title={title}>{cell.label === "cross_up" ? "↗" : cell.label === "cross_down" ? "↘" : "–"}</td>;
  const bearish = id.includes("low");
  return <td className="mp-status-cell" data-tone={value === 1 ? (bearish ? "down" : "up") : "flat"} title={title}>{value === 1 ? "●" : "○"}</td>;
}

/** Previous completed daily bars as a compact status grid; columns with no qualified value are left out and named. */
function DailyInternalsPanelView({ frame, asOf = frame.available_at_ms, onSelectMetric, select }: { frame: DisplayFrame; asOf?: number; onSelectMetric?: (request: MetricCohortRequest) => void; select?: (id: string) => void }) {
  const rows = frame.dailyInternals;
  const columns = DAILY_COLUMNS.filter(column => dailyColumnQualified(column, rows));
  if (!rows.length || !columns.length) return null;
  const hidden = DAILY_COLUMNS.length - columns.length;
  return (
    <Panel id="mp-daily-internals" title="Daily trend & range" detail={`Previous completed daily bars · ${columns.length} of ${DAILY_COLUMNS.length} measures qualified${hidden ? " · others still building" : ""}`}>
      <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-daily-internals-caption">
        <table className="mp-table mp-status-grid">
          <caption id="mp-daily-internals-caption" className="sr-only">Daily moving-average and 20-day range status by instrument; ● yes, ○ no, · not yet qualified</caption>
          <thead><tr><th scope="col">Instrument</th>{columns.map(column => <th key={column.key} scope="col">
            {column.request && onSelectMetric ? (() => {
              const selection = selectMetricCohort(frame, column.request!, asOf);
              return <button type="button" onClick={() => onSelectMetric(column.request!)} title={`Filter instruments · ${selection.definition}`}>{column.label}{selection.status === "available" ? ` · ${selection.instrumentIds.length}` : ""}</button>;
            })() : column.label}
          </th>)}<th scope="col">Bars</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.instrumentId}>
            <th scope="row">{select ? <button type="button" onClick={() => select(row.instrumentId)}>{row.instrumentId.split(":").at(-1)?.split("-")[0]}</button> : row.instrumentId.split(":").at(-1)}</th>
            {columns.map(column => <DailyCell key={column.key} cell={column.cell(row)} quote={frame.quote} note={column.note?.(row, frame.quote)} />)}
            <td className="mp-status-cell" data-tone="flat" title={`${row.sourceCoverage.validBars}/${row.sourceCoverage.expectedBars} bars · ${row.contiguousBars} contiguous · ${row.sourceCoverage.gaps} gaps · ${row.sourceCoverageStatus} · ${row.source ? `${row.source.providerId} ${row.source.pair} · ${row.source.sourceKind} · daily cutoff ${row.cutoff} · expires ${row.source.expires}` : `${row.sourceReasons.join(", ")} · no daily source identity attached`}`}>
              {row.sourceCoverage.validBars}/{row.sourceCoverage.expectedBars}
            </td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="mp-panel-footnote">● yes · ○ no · · not yet qualified (hover for the owner reason) · a header filters the instrument table · descriptive, not a forecast.</p>
    </Panel>
  );
}
export const DailyInternalsPanel = memo(DailyInternalsPanelView);

export interface SummaryTile {
  key: string;
  label: string;
  value: string;
  hint: string;
  title: string;
  points: SeriesPoint[];
  format: (value: number) => string;
  delta: string | null;
  deltaTone: string;
  freshness: string;
  metric?: DisplayMetric;
  horizon?: Horizon;
  sourceReading?: SourceFamilyReading;
  asOf?: number;
}

function summaryMetricFreshness(frame: DisplayFrame, metric: DisplayMetric | undefined, asOf: number): string {
  if (!metric || metric.available == null || metric.expires == null) return "UNAVAILABLE";
  const state = rowTimeState(frame, { available: metric.available, expires: metric.expires }, asOf);
  return state === "CURRENT" ? ageState(frame, asOf, false).freshness : state;
}

const SNAPSHOT = [
  ["market_participation", "Participation", "Above EMA21 · 1m", "share"],
  ["trend_strength", "Trend strength", "Mean ADX14 · 0–100", "adx"],
  ["realized_volatility_24h", "Realized volatility", "Median · 24h annualized", "share"],
  // Hourly generation: last 60 closed minutes over the mean of the prior 24 hourly sums.
  ["relative_volume_1h", "Relative volume (1h)", "Median · last 60 min vs prior 24h hourly mean", "ratio"],
  // Stored single-minute generation; a frame carries exactly one of the two keys.
  ["relative_volume_24h", "Relative volume", "Median · vs prior 24h baseline", "ratio"],
] as const;

function summaryHistoryPoints(samples: HistoryPoint[], valueFor: (point: HistoryPoint) => number | null): SeriesPoint[] {
  return samples.flatMap((point, index) => {
    const observed = { time: point.time, value: valueFor(point) };
    // Use the hero's null break convention without changing either observation.
    return point.gapBefore && index > 0
      ? [{ time: point.time - 1, value: null }, observed]
      : [observed];
  });
}

/** Compact market-wide tiles that sit under the hero. Tiles without a value are not drawn. */
function MarketSnapshotTilesView({
  frame,
  history,
  window,
  onInspect,
  horizon = "15",
  asOf = frame?.available_at_ms ?? 0,
  historical = false,
}: {
  frame: DisplayFrame | null;
  history: HistoryPoint[];
  window: string;
  onInspect?: (tile: SummaryTile, samples: HistoryPoint[]) => void;
  horizon?: Horizon;
  asOf?: number;
  historical?: boolean;
}) {
  const samples = useMemo(() => pulseSeries(history, window, "15").samples, [history, window]);
  if (!frame) return null;
  const tiles = SNAPSHOT.flatMap<SummaryTile>(([key, label, hint, kind]) => {
    const metric = frame.summary[key];
    if (!metric || metric.value == null) return [];
    // A single 1-minute bar against a longer mean reads far below 1x on thin books; see pulse.mjs.
    if (key === "relative_volume_24h" && isSingleBarRelativeVolume(metric)) return [];
    const points = summaryHistoryPoints(samples, (p) => p.summary[key] ?? null);
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
        freshness: summaryMetricFreshness(frame, metric, asOf),
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
      points: summaryHistoryPoints(samples, (p) => {
        const high = p.summary.new_highs_24h, low = p.summary.new_lows_24h;
        return high == null || low == null ? null : high - low;
      }),
      format: (v: number) => `net ${signed(v, 0)}`,
      delta: null,
      deltaTone: "",
      freshness: breaks.map(metric => summaryMetricFreshness(frame, metric, asOf)).filter((value, index, states) => states.indexOf(value) === index).join(" / "),
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
    freshness: ageState(frame, asOf, false).freshness,
  });
  const pressure = frame.pressure?.[horizon];
  if (pressure?.value != null)
    tiles.push({
      key: "breadth_pressure", label: `Breadth pressure (${horizonLabel(horizon)})`,
      value: metricText(pressure, 2, true),
      hint: `3 × (advancing − declining) ÷ valid · −3…+3`,
      title: metricTitle(pressure),
      metric: pressure, horizon,
      points: summaryHistoryPoints(samples, (p) => p.breadth?.[horizon]?.pressure ?? null),
      format: (v: number) => signed(v), delta: null, deltaTone: "",
      freshness: summaryMetricFreshness(frame, pressure, asOf),
    });
  const contribution = frame.contributions?.[horizon];
  const equalReturn = contribution?.equalReturn;
  const returnFreshness = summaryMetricFreshness(frame, equalReturn, asOf);
  // An unavailable return is listed once in the availability line instead of as a tile.
  if (equalReturn?.value != null && returnFreshness !== "FUTURE")
    tiles.push({
      key: "equal_weight_return", label: `Equal-weight return (${horizonLabel(horizon)})`,
      value: metricText(equalReturn, 2, true),
      hint: `Full start cohort ${contribution ? `${contribution.valid}/${contribution.expected}` : "unavailable"} · rolling, not cumulative`,
      title: metricTitle(equalReturn),
      metric: equalReturn, horizon, freshness: returnFreshness,
      points: summaryHistoryPoints(samples, (p) => p.contributions?.[horizon]?.equalReturn ?? null),
      format: value => `${numberText(value, 2, true)}%`, delta: null, deltaTone: "",
    });
  // Independent source families appear as tiles only when the owner qualifies a current observation.
  for (const reading of sourceFamilyReadings(frame, asOf).filter(row => row.qualified && ["spot_flow", "spot_liquidity", "derivatives"].includes(row.key))) {
    tiles.push({
      key: reading.key, label: reading.key === "derivatives" ? "Derivatives stress" : reading.family,
      value: "Observed", hint: `${reading.scope} · ${reading.state}`,
      title: reading.evidence, sourceReading: reading, asOf, freshness: reading.freshness,
      points: [], format: String, delta: null, deltaTone: "",
    });
  }
  return (
    <TileGrid min={170} label="Market summary" className="mp-tiles">
      {tiles.map((tile) => {
        const observation = <>
          <strong id={`mp-summary-${tile.key}-value`}>{tile.value}</strong>
          <small>{tile.hint}</small>
          {tile.delta && <small className={tile.deltaTone}>{tile.delta}</small>}
          {/* Fresh current values share the page's observation time; only exceptions are spelled out. */}
          <small id={`mp-summary-${tile.key}-freshness`} className="mp-tile__freshness" data-fresh={tile.freshness === "FRESH" && !historical ? "" : undefined}>{historical ? "Recorded · " : ""}{tile.freshness} · Frame observed at {Number.isFinite(frame.cutoff_ms) ? new Date(frame.cutoff_ms).toISOString() : "Unavailable"}</small>
        </>;
        return (
        <article className="mp-tile" key={tile.key} title={tile.title}>
          <h3>{tile.label}</h3>
          {onInspect ? <button type="button" className="mp-tile__inspect"
            aria-label={`Inspect ${tile.label} evidence`} aria-haspopup="dialog"
            aria-describedby={`mp-summary-${tile.key}-value mp-summary-${tile.key}-freshness`}
            onClick={() => onInspect(tile, samples)}>
            {observation}<small className="mp-tile__action">View evidence</small>
          </button> : observation}
          {tile.points.filter((p) => p.value != null).length >= 2 && (
            // Leading time before the first retained value is not drawn as an empty band; inner gaps stay.
            <SparkChart points={tile.points.slice(Math.max(0, tile.points.findIndex((p) => p.value != null)))} height={34} format={tile.format} ariaLabel={`${tile.label} over ${window}`} color={CHART.blue} />
          )}
        </article>
        );
      })}
    </TileGrid>
  );
}
export const MarketSnapshotTiles = memo(MarketSnapshotTilesView);
