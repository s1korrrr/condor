import { useMemo, useState } from "react";
import { TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { SparkChart } from "@/features/quant-ops/kit/charts";
import { TileGrid } from "@/features/quant-ops/kit/grid";
import { CHART, type ChartSeries, type SeriesPoint } from "@/features/quant-ops/kit/series";
import { useElementWidth } from "@/features/quant-ops/kit/useElementWidth";
import { HORIZONS, HORIZON_LABELS, marketPulseWindow } from "./model.mjs";
import {
  breadthLadder,
  horizonLabel,
  isSingleBarRelativeVolume,
  marketVerdict,
  pulseSeries,
  SMOOTHING_MINUTES,
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
function VerdictCard({
  frame,
  horizon,
  history,
  smooth,
}: {
  frame: DisplayFrame | null;
  horizon: Horizon;
  history: HistoryPoint[];
  smooth: boolean;
}) {
  const verdict = useMemo(
    () => marketVerdict(frame, horizon, { history, smooth }),
    [frame, horizon, history, smooth],
  );
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
        <small className="mp-verdict__basis" role="status">
          {verdict.smoothed
            ? `Breadth components: ${verdict.smoothingMinutes}-min mean of ${verdict.smoothedFrames} frames · latest-frame score ${signed(verdict.instantScore)}`
            : "Latest frame only"}
          {verdict.held
            ? ` · ${verdict.label} held until the score is inside ±${VERDICT_HOLD.toFixed(2)}`
            : ""}
        </small>
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
  const [smooth, setSmooth] = useState(true);
  const pulse = useMemo(() => pulseSeries(history, window, horizon), [history, window, horizon]);
  const lastSmoothed = useMemo(
    () => [...pulse.smoothed].reverse().find((p) => p.value !== null)?.value ?? null,
    [pulse],
  );
  const markers = useMemo(
    () => coverageChangePoints(pulse.samples).map((p) => ({ time: p.time, label: "Coverage changed" })),
    [pulse.samples],
  );
  const series = useMemo<ChartSeries[]>(
    () => [
      smooth
        ? {
            id: "pressure",
            label: `Breadth pressure · ${SMOOTHING_MINUTES}-min mean`,
            color: CHART.violet,
            points: pulse.smoothed,
            area: true,
            signSplit: { positive: CHART.positive, negative: CHART.negative },
            fillOpacity: 0.7,
            format: (v: number) => signed(v),
          }
        : {
            id: "pressure",
            label: "Breadth pressure · raw",
            color: CHART.violet,
            points: pulse.pressure,
            area: true,
            signSplit: { positive: CHART.positive, negative: CHART.negative },
            fillOpacity: 0.7,
            format: (v: number) => signed(v),
          },
      ...(smooth
        ? [{ id: "pressure-raw", label: "Breadth pressure · raw", color: CHART.muted, points: pulse.pressure, format: (v: number) => signed(v) } satisfies ChartSeries]
        : []),
      { id: "advancing", label: "Advancing share · raw", color: CHART.blue, points: pulse.advancing, axis: "secondary", tooltipOnly: true, format: percent },
      { id: "declining", label: "Declining share · raw", color: CHART.negative, points: pulse.declining, axis: "secondary", tooltipOnly: true, format: percent },
    ],
    [pulse, smooth],
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
          <VerdictCard frame={frame} horizon={horizon} history={history} smooth={smooth} />
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
              ● Breadth pressure raw{" "}
              <Metric metric={frame?.pressure[horizon]} digits={2} signed />
              {smooth && lastSmoothed !== null && <> · {SMOOTHING_MINUTES}-min mean {signed(lastSmoothed)}</>} · −3…+3
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
            <span className="mp-panel-detail" role="status">
              {pulse.label}
              {smooth ? ` · pressure line is a ${SMOOTHING_MINUTES}-minute rolling mean, raw grey` : " · raw one-minute pressure"}
            </span>
            <div className="mp-segment" role="group" aria-label="Pressure smoothing">
              <button aria-pressed={smooth} onClick={() => setSmooth(true)} title={`Trailing ${SMOOTHING_MINUTES}-minute mean of the stored one-minute pressure; raw values stay in the tooltip`}>
                {SMOOTHING_MINUTES}m mean
              </button>
              <button aria-pressed={!smooth} onClick={() => setSmooth(false)} title="Unsmoothed one-minute breadth pressure">
                Raw
              </button>
            </div>
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
  const validBreadth = breadth?.positive.status === "VALID" && pressure?.status === "VALID";
  const completeBreadth = validBreadth && breadth.positive.valid === breadth.positive.expected &&
    pressure.valid === pressure.expected;
  const pressureValue = pressure?.value;
  const sourceReference = frame.flow ?? { status: "unavailable", reasons: ["SOURCE_UNAVAILABLE"] };
  const capabilityFor = (families: string[]) => {
    const capabilities = frame.sourceCapabilities.filter(capability => families.includes(capability.family));
    if (!capabilities.length) return { state: "NOT PROBED", detail: "No owner source-capability receipt is attached." };
    const states = capabilities.map(capability => {
      const qualification = capability.qualification.replaceAll("_", " ").toUpperCase();
      const operational = capability.operational.replaceAll("_", " ").toUpperCase();
      const usable = capability.qualification === "qualified" && capability.operational === "healthy";
      return {
        state: usable ? "QUALIFIED · HEALTHY" : `${qualification} · ${operational}`,
        detail: `${capability.sourceId}: ${qualification}; operational ${operational}${capability.reasons.length ? ` · ${capability.reasons.join(", ")}` : ""}. Source status alone does not qualify a frame metric.`,
      };
    });
    return {
      state: states.map(item => item.state).join("; "),
      detail: states.map(item => item.detail).join(" "),
    };
  };
  const spotFlow = capabilityFor(["spot_flow"]);
  const spotLiquidity = capabilityFor(["spot_liquidity"]);
  const observedFlows = frame.microstructure?.flows ?? [];
  const observedBooks = frame.microstructure?.liquidity ?? [];
  const flowQualified = observedFlows.some(row => row.capabilityUsable && row.complete && !row.reasons.length && row.expires > asOf);
  const bookQualified = observedBooks.some(row => row.capabilityUsable && !row.reasons.length && row.expires > asOf);
  const flowExpired = observedFlows.length > 0 && observedFlows.every(row => row.expires <= asOf);
  const bookExpired = observedBooks.length > 0 && observedBooks.every(row => row.expires <= asOf);
  const derivatives = capabilityFor(["derivatives", "liquidations"]);
  const options = capabilityFor(["options"]);
  const external = capabilityFor(["external_context"]);
  const privateExposure = capabilityFor(["private_exposure"]);
  const research = capabilityFor(["conditional_outcomes"]);
  const familyRows = [
    {
      family: "Price & participation",
      state: !validBreadth ? "UNAVAILABLE" : completeBreadth ? "OBSERVED" : "PARTIAL",
      evidence: validBreadth
        ? `${metricText(breadth.positive, 0)} advancing · pressure ${metricText(pressure, 2, true)} · ${horizonLabel(horizon)}`
        : "Breadth or pressure is unavailable for this horizon.",
    },
    {
      family: "Executed spot flow",
      state: flowQualified ? "OBSERVED · QUALIFIED" : flowExpired ? "OBSERVED · EXPIRED" : spotFlow.state,
      evidence: `${spotFlow.detail} ${observedFlows.length ? `${observedFlows.length} stored flow rows; ${observedFlows.filter(row => row.complete && !row.reasons.length && row.expires > asOf).length} complete, reason-free, unexpired at ${new Date(asOf).toISOString()}.` : "No executed-flow component is attached."} Status-only pointer: ${sourceReference.status}${sourceReference.reasons.length ? ` · ${sourceReference.reasons.join(", ")}` : ""}.`,
    },
    { family: "Displayed liquidity", state: bookQualified ? "OBSERVED · QUALIFIED" : bookExpired ? "OBSERVED · EXPIRED" : spotLiquidity.state, evidence: `${spotLiquidity.detail} ${observedBooks.length ? `${observedBooks.length} stored order-size scenarios; partial coverage stays visibly partial.` : "No visible-book component is attached."}` },
    { family: "Derivatives positioning", state: derivatives.state, evidence: `${derivatives.detail} No qualified derivatives metric is attached.` },
    { family: "Options", state: options.state, evidence: `${options.detail} Options remain outside the qualified evidence set.` },
    { family: "External context", state: external.state, evidence: `${external.detail} External observations remain outside the qualified evidence set.` },
    { family: "Private exposure", state: privateExposure.state, evidence: `${privateExposure.detail} No private owner data is read or projected here.` },
    { family: "Conditional outcomes", state: research.state === "NOT PROBED" ? "UNQUALIFIED" : research.state, evidence: `${research.detail} Deferred pending separately approved research and after-cost evidence.` },
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
    </Panel>
  );
}

function displayDecimal(value: string | null, digits = 4, signed = false) {
  if (value == null) return "Unavailable";
  const number = Number(value);
  if (!Number.isFinite(number)) return "Invalid";
  return `${signed && number > 0 ? "+" : ""}${number.toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

function rowFresh(expires: number, asOf: number) {
  return expires > asOf;
}

/** Owner-recorded spot-flow and displayed-book observations. Never estimates depth or actionability. */
export function MicrostructurePanel({ frame, asOf = frame.available_at_ms }: { frame: DisplayFrame; asOf?: number }) {
  const component = frame.microstructure;
  if (!component) return (
    <Panel id="mp-microstructure" title="Executed flow &amp; displayed liquidity" detail="Owner-recorded observations only; no frontend flow or book calculation">
      <p className="mp-panel-footnote">Source held · this frame contains no microstructure component. The status-only flow pointer is not an observation.</p>
    </Panel>
  );
  const flows = component.flows, books = component.liquidity;
  return (
    <Panel id="mp-microstructure" title="Executed flow &amp; displayed liquidity" detail="Observed quantities from the owner component; price participation remains a separate correlated family">
      <p className="mp-panel-footnote">{component.sourceKind.toUpperCase()} · {component.replayClass.replaceAll("_", " ")} · assessed as of {new Date(asOf).toISOString()} · raw trades/books not retained · digest {component.componentId.slice(0, 12)}…</p>
      {flows.length ? <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-flow-observations-caption">
        <table className="mp-table mp-trajectory-table">
          <caption id="mp-flow-observations-caption">Executed spot notional by aggressor side · quote {frame.quote}</caption>
          <thead><tr><th>Instrument</th><th>Buy quote</th><th>Sell quote</th><th>Unknown quote</th><th>Unknown share</th><th>Known imbalance</th><th>Confirmation</th><th>Cumulative delta · before → after</th><th>Coverage / source</th></tr></thead>
          <tbody>{flows.map(row => {
            const valid = row.capabilityUsable && row.complete && !row.reasons.length && rowFresh(row.expires, asOf);
            const state = !row.capabilityUsable ? "SOURCE NOT QUALIFIED" : !rowFresh(row.expires, asOf) ? "EXPIRED" : row.reasons.length ? row.reasons.join(", ") : row.complete ? "COMPLETE" : "PARTIAL";
            const gapSummary = row.gaps.length ? row.gaps.map(([start, end]) => `${start}–${end}`).join(", ") : "none";
            return <tr key={`${row.instrumentId}/${row.sourceId}`}>
              <th scope="row">{row.instrumentId.split(":").at(-1)}</th>
              <td>{row.quoteAsset} {displayDecimal(row.buyQuote)}</td><td>{row.quoteAsset} {displayDecimal(row.sellQuote)}</td>
              <td>{row.quoteAsset} {displayDecimal(row.unknownQuote)}</td>
              <td>{displayDecimal(row.unknownShare, 3)}</td>
              <td>{displayDecimal(row.knownImbalance, 3, true)}</td>
              <td>{valid ? displayDecimal(row.confirmationImbalance, 3, true) : "Unavailable"}</td>
              <td>{row.cumulativeBefore == null && row.cumulativeAfter == null ? "Unavailable" : `${row.quoteAsset} ${row.cumulativeBefore == null ? "Unavailable" : displayDecimal(row.cumulativeBefore, 2, true)} → ${row.cumulativeAfter == null ? "Unavailable" : displayDecimal(row.cumulativeAfter, 2, true)}`}</td>
              <td title={`${row.sourceId} · ${row.channel} · input ${row.inputDigest} · window ${row.windowStart}–${row.windowEnd} · coverage ${row.coverageStart}–${row.coverageEnd} · reset ${row.resetId} at ${row.resetAt} · gaps ${gapSummary} · ${row.reasons.join(", ")}`}>
                {state} · {row.trades} trades · {row.duplicates} duplicates · reset {row.resetId} · {row.gaps.length} gap{row.gaps.length === 1 ? "" : "s"}
              </td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <p className="mp-panel-footnote">No executed-flow rows in this owner snapshot.</p>}
      {books.length ? <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-book-observations-caption">
        <table className="mp-table mp-trajectory-table">
          <caption id="mp-book-observations-caption">Visible-book walk for recorded order sizes; no orders are sent</caption>
          <thead><tr><th>Instrument</th><th>Side / size</th><th>Covered / uncovered</th><th>Covered VWAP</th><th>Full-size VWAP</th><th>Book cost</th><th>Prior 7d cost percentile · midrank</th><th>Fee / total</th><th>Spread / band</th><th>State</th></tr></thead>
          <tbody>{books.map((row, index) => {
            const valid = row.capabilityUsable && !row.reasons.length && rowFresh(row.expires, asOf);
            const partial = Number(row.uncovered) > 0;
            const bookEstimateValid = row.capabilityUsable && row.access !== "unknown" &&
              rowFresh(row.expires, asOf) && !partial &&
              row.vwap != null && row.costBps != null;
            const percentileReasons = row.costPercentileReasons ?? ["INSUFFICIENT_HISTORY"];
            const state = !row.capabilityUsable ? "SOURCE NOT QUALIFIED" : !rowFresh(row.expires, asOf) ? "EXPIRED" : partial ? `PARTIAL DEPTH${row.reasons.length ? ` · ${row.reasons.join(", ")}` : ""}` : row.reasons.length ? row.reasons.join(", ") : "COVERED";
            return <tr key={`${row.instrumentId}/${row.sourceId}/${row.side}/${row.sizeUnit}/${row.requestedSize}/${index}`}>
              <th scope="row">{row.instrumentId.split(":").at(-1)}</th>
              <td>{row.side} · {displayDecimal(row.requestedSize)} {row.sizeUnit}</td>
              <td>{displayDecimal(row.coveredBase)} base / {displayDecimal(row.coveredQuote, 2)} quote · {displayDecimal(row.uncovered)} uncovered</td>
              <td>{row.coveredVwap == null ? "Unavailable" : `${frame.quote} ${displayDecimal(row.coveredVwap)}`}</td>
              <td>{bookEstimateValid ? `${frame.quote} ${displayDecimal(row.vwap)}` : "Unavailable"}</td>
              <td>{bookEstimateValid ? `${displayDecimal(row.costBps, 2, true)} bps` : "Unavailable"}</td>
              <td title={`${percentileReasons.join(", ") || "Qualified against prior seven completed days"}${row.costPercentileReferenceDigest ? ` · reference ${row.costPercentileReferenceDigest}` : ""}`}>
                {row.costPercentile7d == null
                  ? `Unavailable · ${percentileReasons.join(", ") || "no owner reason"}`
                  : `${displayDecimal(String(row.costPercentile7d * 100), 1)} percentile`}
                {` · ${row.costPercentileSampleCount ?? 0}/${row.costPercentileExpectedSamples ?? 10080} samples`}
                {row.costPercentileReferenceDigest ? ` · ref ${row.costPercentileReferenceDigest.slice(0, 12)}…` : ""}
              </td>
              <td>{row.feeBps == null ? "Fee unavailable" : `${displayDecimal(row.feeBps, 2)} bps · ${row.feeSource ?? "source unknown"}`} / {valid && row.totalCostBps != null ? `${displayDecimal(row.totalCostBps, 2)} bps` : "total unavailable"}</td>
              <td>{row.spreadBps == null ? "Spread unavailable" : `${displayDecimal(row.spreadBps, 2)} bps`} · ±{displayDecimal(row.bandBps, 1)} bps band · {row.bandComplete ? "complete" : "partial"}</td>
              <td title={`${row.sourceId} · ${row.channel} · sequence ${row.sequence} · ${row.access} · observed ${row.observed} · expires ${row.expires} · band bid ${row.bidCovered}, ask ${row.askCovered} · imbalance ${row.bandImbalance ?? "unavailable"} · ${row.reasons.join(", ")}`}>{state}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <p className="mp-panel-footnote">No displayed-liquidity rows in this owner snapshot.</p>}
      <p className="mp-panel-footnote">Values expire per row. Incomplete flow, unknown aggressor notional, partial book depth, missing fee provenance, and unsupported access remain unavailable; no candle color is used as trade flow.</p>
    </Panel>
  );
}

/** Stored one-minute owner aggregates; points are never summed across gaps or resets. */
export function FlowHistoryPanel({
  history, window, fault,
}: { history: HistoryPoint[]; window: string; fault: string | null }) {
  const { samples, label } = marketPulseWindow(history, window);
  const points = samples.slice(-300);
  const hasFlow = points.some(point => point.flowHistory != null);
  const rows = points.map((point, index) => {
    const flow = point.flowHistory;
    const previous = index > 0 ? points[index - 1] : null;
    const previousFlow = previous?.flowHistory ?? null;
    const breakReasons: string[] = [];
    if (index === 0) breakReasons.push("window start");
    if (point.gapBefore) breakReasons.push("stored history gap");
    if (!flow) breakReasons.push("flow unavailable");
    else if (flow.cumulativeDeltaQuote == null) breakReasons.push("CVD unavailable");
    if (previous && !previousFlow) breakReasons.push("previous flow unavailable");
    else if (previousFlow && previousFlow.cumulativeDeltaQuote == null) breakReasons.push("previous CVD unavailable");
    if (flow && previousFlow && flow.scopeHash !== previousFlow.scopeHash) breakReasons.push("scope changed");
    if (flow && previousFlow && flow.resetAt !== previousFlow.resetAt) breakReasons.push("reset changed");
    if (previous && point.time - previous.time !== 60_000) breakReasons.push("non-1m interval");
    return { point, flow, continuity: breakReasons.length ? `Break · ${breakReasons.join(", ")}` : "Continuous with prior stored point" };
  });
  return (
    <Panel id="mp-flow-history" title="Stored executed-flow history" detail="Owner-recorded one-minute totals; no raw tape or client aggregation">
      <p className="mp-panel-footnote" role="status">
        {fault ? `History read degraded · ${fault} · retained values remain tied to their stored times.` : "Stored history read validated."} {label} · showing {points.length} of {samples.length} retained points. Buy, sell and unknown totals are per stored point; they are never summed across gaps.
      </p>
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

/** Owner-computed multi-window breadth trajectory and frozen-cohort contribution context. */
export function BreadthContextPanel({ frame }: { frame: DisplayFrame }) {
  const rows = frame.breadthTrajectory;
  const normalized = Object.values(frame.normalizedBreadth);
  const diverged = frame.breadthDivergence.find(row => row.interval === 15);
  const contributions = ["5", "15", "60", "1440"].map(h => frame.contributions[h]).filter(Boolean);
  const hourlyText = (key: string, metric: DisplayMetric) =>
    key.endsWith("_slope_pct_per_hour_median") && metric.unit === "return_percent" && metric.value !== null
      ? `${numberText(metric.value, 3, true)}%/hour`
      : metricText(metric, metric.unit === "instruments" ? 0 : 3, true);
  const statusText = (metric: DisplayFrame["pressure"][string]) => metric.value == null
    ? `${metric.status}${metric.reasons.length ? ` · ${metric.reasons.join(", ")}` : ""}`
    : metricText(metric, 3, true);
  return (
    <Panel id="mp-breadth-context" title="Breadth trajectory &amp; concentration" detail="Owner-computed, matched cohorts; unavailable history is left blank">
      {normalized.length ? <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-normalized-breadth-caption">
        <table className="mp-table mp-trajectory-table">
          <caption id="mp-normalized-breadth-caption">One-basis-point breadth balance; each admitted instrument has one vote</caption>
          <thead><tr><th>Horizon</th><th>Advances</th><th>Declines</th><th>Unchanged</th><th>Pressure · −1…+1</th><th>Coverage</th></tr></thead>
          <tbody>{normalized.map(row => <tr key={row.horizon}>
            <th scope="row">{row.horizon}m</th>
            <td title={metricTitle(row.advances)}>{metricText(row.advances, 0)}</td>
            <td title={metricTitle(row.declines)}>{metricText(row.declines, 0)}</td>
            <td title={metricTitle(row.unchanged)}>{metricText(row.unchanged, 0)}</td>
            <td title={metricTitle(row.pressure)}>{metricText(row.pressure, 3, true)}</td>
            <td>{row.valid}/{row.expected}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="mp-panel-footnote">One-basis-point breadth is unavailable · owner metrics were not included in this frame.</p>}
      {rows.length ? (
        <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-breadth-trajectory-caption">
          <table className="mp-table mp-trajectory-table">
            <caption id="mp-breadth-trajectory-caption">Matched-universe pressure level and its change, velocity, and acceleration</caption>
            <thead><tr><th>Horizon</th><th>Interval</th><th>Level</th><th>Pressure change</th><th>Advance-share change</th><th>Velocity</th><th>Acceleration</th><th>Matched cohort</th></tr></thead>
            <tbody>{rows.map(row => <tr key={`${row.horizon}/${row.interval}`}>
              <th scope="row">{row.horizon}m</th><td>{row.interval}m</td>
              <td title={metricTitle(row.level)}>{statusText(row.level)}</td>
              <td title={metricTitle(row.change)}>{statusText(row.change)}</td>
              <td title={row.shareChange ? metricTitle(row.shareChange) : "Owner comparison not supplied"}>{row.shareChange ? statusText(row.shareChange) : "Unavailable · not supplied"}</td>
              <td title={metricTitle(row.velocity)}>{statusText(row.velocity)}</td>
              <td title={metricTitle(row.acceleration)}>{statusText(row.acceleration)}</td>
              <td title={row.membership ?? "No matched membership hash"}>{row.matched}/{row.expected}</td>
            </tr>)}</tbody>
          </table>
        </div>
      ) : <p className="mp-panel-footnote">Trajectory unavailable · no compatible prior candle frame was included.</p>}
      {frame.hourlyInternals ? <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-hourly-internals-caption">
        <table className="mp-table mp-trajectory-table">
          <caption id="mp-hourly-internals-caption">Owner-computed hourly cohort internals; no per-asset values are inferred</caption>
          <thead><tr><th scope="col">Hourly metric</th><th scope="col">Value</th><th scope="col">Coverage / reason</th></tr></thead>
          <tbody>{Object.entries(frame.hourlyInternals.metrics).map(([key, metric]) => <tr key={key}>
            <th scope="row">{key.replaceAll("_", " ")}</th>
            <td title={metricTitle(metric)}>{hourlyText(key, metric)}</td>
            <td>{metric.valid}/{metric.expected}{metric.reasons.length ? ` · ${metric.reasons.join(", ")}` : ""}</td>
          </tr>)}</tbody>
        </table>
        <p className="mp-panel-footnote">60m source cutoff {new Date(frame.hourlyInternals.cutoff).toISOString()} · {frame.hourlyInternals.sourceCount}/{frame.hourlyInternals.expected} contributing sources · {frame.hourlyInternals.sourceKind} · digest {frame.hourlyInternals.sourceDigest.slice(0, 12)}…</p>
      </div> : <p className="mp-panel-footnote">Hourly internals unavailable · this frame has no owner-computed hourly cohort projection.</p>}
      <section className="mp-candle-anomalies" aria-labelledby="mp-candle-anomalies-heading">
        <h3 id="mp-candle-anomalies-heading">Hourly candle anomaly tags</h3>
        {frame.candleAnomalies ? <>
          <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-candle-anomalies-caption">
            <table className="mp-table mp-trajectory-table">
              <caption id="mp-candle-anomalies-caption">Owner-computed binary tags from confirmed hourly candles; null inputs are not negative observations</caption>
              <thead><tr><th scope="col">Definition</th><th scope="col">High count</th><th scope="col">Share of valid</th><th scope="col">Coverage</th><th scope="col">Tagged instruments</th><th scope="col">Missing</th></tr></thead>
              <tbody>{[
                ["dictionary_rvol_1h_high", "High 1h relative volume", "Current completed-hour quote turnover ≥2× the median of the prior 20 disjoint completed hours."],
                ["bollinger_inside_ema_atr_compression_1h", "Bollinger / EMA-ATR compression", "The current Bollinger SMA20 ±2 population SD band lies strictly inside EMA20 ±1.5 Wilder ATR20; requires 60 completed hours."],
                ["extreme_realized_volatility_1h_95p", "Extreme 24h realized volatility", "Current sample volatility of 24 hourly log returns exceeds the linear 95th percentile of the prior 720 hourly observations; requires 745 closes."],
              ].map(([key, label, definition]) => {
                const metric = frame.candleAnomalies!.metrics[key];
                const tagged = frame.assets.filter(asset => metric.values[asset.instrument_id] === 1).map(asset => asset.symbol);
                const missing = frame.assets.filter(asset => metric.values[asset.instrument_id] === null).length;
                return <tr key={key}>
                  <th scope="row" title={`${metric.definitionId} · definition ${metric.definitionHash}`}>{label}<small>{definition}</small></th>
                  <td>{metric.high == null ? "Unavailable" : metric.high}</td>
                  <td>{metric.share == null ? "Unavailable" : `${(metric.share * 100).toFixed(1)}%`}</td>
                  <td>{metric.valid}/{metric.expected} valid</td>
                  <td>{tagged.length ? tagged.join(", ") : metric.valid === 0 ? "Unavailable" : "None"}</td>
                  <td>{missing ? `${missing} · ${metric.reasons.join(", ") || "reason unavailable"}` : "0"}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          <p className="mp-panel-footnote">Hour cutoff {new Date(frame.candleAnomalies.cutoff).toISOString()} · source coverage {frame.candleAnomalies.sourceCount}/{frame.candleAnomalies.expected} · {frame.candleAnomalies.sourceKind} · digest {frame.candleAnomalies.sourceHash.slice(0, 12)}…</p>
        </> : <p className="mp-panel-footnote">Unavailable · this frame has no owner-computed hourly candle anomaly projection.</p>}
      </section>
      <div className="mp-evidence-scenarios">
        <p><b>Price–breadth divergence</b> · {diverged?.metric.value == null
          ? `Unavailable${diverged?.metric.reasons.length ? ` · ${diverged.metric.reasons.join(", ")}` : " · no qualified matched comparison"}`
          : diverged.metric.value === 1
            ? `Observed for BTC over 15m / ${diverged.interval}m matched breadth change.`
            : `Not observed for BTC over 15m / ${diverged.interval}m matched breadth change.`}</p>
        <p><b>Definition</b> · Confirmed close breaks its prior 24h range while matched-cohort breadth pressure changes in the opposite direction; this is descriptive, not predictive.</p>
      </div>
      {contributions.length ? <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-return-contribution-caption">
        <table className="mp-table mp-trajectory-table">
          <caption id="mp-return-contribution-caption">Full start-cohort returns and absolute top-five contribution concentration</caption>
          <thead><tr><th>Horizon</th><th>Equal-weight return</th><th>Liquidity-capped return</th><th>Top-five share · equal</th><th>Top-five share · capped</th><th>Cohort</th></tr></thead>
          <tbody>{contributions.map(row => <tr key={row.horizon}>
            <th scope="row">{row.horizon}m</th>
            <td title={metricTitle(row.equalReturn)}>{metricText(row.equalReturn, 2, true)}</td>
            <td title={metricTitle(row.cappedReturn)}>{metricText(row.cappedReturn, 2, true)}</td>
            <td title={metricTitle(row.equalTop5)}>{metricText(row.equalTop5, 1)}</td>
            <td title={metricTitle(row.cappedTop5)}>{metricText(row.cappedTop5, 1)}</td>
            <td>{row.valid}/{row.expected} · {row.startCohortAvailable ? "start cohort evidenced" : "start cohort unavailable"}{row.priorWeightsAvailable ? " · prior weights available" : " · prior weights unavailable"}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="mp-panel-footnote">Return contribution unavailable · owner has not supplied a qualified frozen start cohort.</p>}
    </Panel>
  );
}

/** Previous completed daily bars only; missing or short history stays explicitly unavailable. */
export function DailyInternalsPanel({ frame }: { frame: DisplayFrame }) {
  if (!frame.dailyInternals.length) return (
    <Panel id="mp-daily-internals" title="Daily range &amp; moving averages" detail="Owner-confirmed daily candles; no intraday substitutions">
      <p className="mp-panel-footnote">Unavailable · this frame has no owner-qualified daily-internals projection.</p>
    </Panel>
  );
  return (
    <Panel id="mp-daily-internals" title="Daily range &amp; moving averages" detail="Previous completed daily bars only; each value carries its own sample coverage">
      <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-daily-internals-caption">
        <table className="mp-table mp-daily-internals-table">
          <caption id="mp-daily-internals-caption">Prior 20-day range breaks and 20/50/200-day simple moving averages</caption>
          <thead><tr>
            <th scope="col" rowSpan={2}>Instrument</th><th scope="col" colSpan={4}>Prior 20 days</th>
            {["20", "50", "200"].map(period => <th key={period} scope="colgroup" colSpan={4}>SMA {period}</th>)}
            <th scope="col" rowSpan={2}>Daily source</th>
          </tr><tr>
            <th>High</th><th>Low</th><th>Close &gt; high</th><th>Close &lt; low</th>
            {["20", "50", "200"].flatMap(period => ["Value", "Above", "Slope/day", "Cross"].map(label => <th key={`${period}-${label}`}>{label}</th>))}
          </tr></thead>
          <tbody>{frame.dailyInternals.map(row => <tr key={row.instrumentId}>
            <th scope="row">{row.instrumentId.split(":").at(-1)}</th>
            {["high_break", "low_break", "close_break_high", "close_break_low"].map(key => {
              const cell = row.breaks[key];
              return <td key={key} title={cell ? metricTitle(cell.metric) : "Unavailable"}>{cell ? dailyFeatureText(cell.metric, cell.metricId, cell.label, frame.quote) : "Unavailable"}</td>;
            })}
            {["20", "50", "200"].flatMap(period => ["sma", "above_close", "slope_percent_per_day", "cross"].map(key => {
              const cell = row.averages[period]?.[key];
              return <td key={`${period}-${key}`} title={cell ? `${cell.definitionId} · ${metricTitle(cell.metric)}` : "Unavailable"}>{cell ? dailyFeatureText(cell.metric, cell.metricId, cell.label, frame.quote) : "Unavailable"}</td>;
            }))}
            <td title={row.source ? `${row.source.providerId} ${row.source.pair} · ${row.source.sourceKind} · daily cutoff ${row.cutoff} · frame cutoff ${row.frameCutoff} · expires ${row.source.expires}` : `${row.sourceCoverageStatus} · ${row.sourceReasons.join(", ")} · no daily source identity attached`}>
              {row.sourceCoverage.validBars}/{row.sourceCoverage.expectedBars} bars · {row.contiguousBars} contiguous · {row.sourceCoverage.gaps} gaps · {row.sourceCoverageStatus}
            </td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="mp-panel-footnote">A value is shown only with its owner metric status and required-sample count; this descriptive panel is not a forecast.</p>
    </Panel>
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
  // Hourly generation: last 60 closed minutes over the mean of the prior 24 hourly sums.
  ["relative_volume_1h", "Relative volume (1h)", "Median · last 60 min vs prior 24h hourly mean", "ratio"],
  // Stored single-minute generation; a frame carries exactly one of the two keys.
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
    // A single 1-minute bar against a longer mean reads far below 1x on thin books; see pulse.mjs.
    if (key === "relative_volume_24h" && isSingleBarRelativeVolume(metric)) return [];
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
