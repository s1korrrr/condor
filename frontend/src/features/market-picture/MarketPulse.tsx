import { memo, useMemo, useState } from "react";
import { TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { SparkChart } from "@/features/quant-ops/kit/charts";
import { TileGrid } from "@/features/quant-ops/kit/grid";
import { CHART, type ChartSeries, type SeriesPoint } from "@/features/quant-ops/kit/series";
import { useElementWidth } from "@/features/quant-ops/kit/useElementWidth";
import { ageState, HORIZONS, HORIZON_LABELS, marketPulseWindow } from "./model.mjs";
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
import { selectMetricCohort, type MetricCohortRequest } from "./metric-cohort.mjs";
import { HistoryRangeSelector } from "./HistoryRangeSelector";
import { historyRangeTimes, normalizeHistoryRange, selectHistoryPoints, type HistoryRange } from "./history-range.mjs";

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
  asOf = frame?.available_at_ms ?? Date.now(),
  historical = false,
}: {
  frame: DisplayFrame | null;
  horizon: Horizon;
  history: HistoryPoint[];
  smooth: boolean;
  asOf?: number;
  historical?: boolean;
}) {
  const verdict = useMemo(
    () => marketVerdict(frame, horizon, { history, smooth }),
    [frame, horizon, history, smooth],
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

type PulseDataRow = {
  time: number;
  gap: boolean;
  advancing: number | null;
  declining: number | null;
  pressure: number | null;
  rawPressure: number | null;
};

/** Align the table to the exact plotted arrays; a non-sample null is the chart's gap sentinel. */
function pulseDataRows(
  samples: HistoryPoint[],
  plottedPressure: SeriesPoint[],
  advancing: SeriesPoint[],
  declining: SeriesPoint[],
  rawPressure?: SeriesPoint[],
): PulseDataRow[] {
  const sampleTimes = new Set(samples.map((sample) => sample.time));
  return plottedPressure.map((point, index) => {
    const up = advancing[index]?.value ?? null;
    const down = declining[index]?.value ?? null;
    const raw = rawPressure?.[index]?.value ?? null;
    return {
      time: point.time,
      gap: !sampleTimes.has(point.time) && [point.value, up, down, raw].every((value) => value === null),
      advancing: up,
      declining: down,
      pressure: point.value,
      rawPressure: raw,
    };
  });
}

function PulseDataTable({
  pulse,
  horizon,
  window,
  pressureSeries,
  rawPressureSeries,
  rangeLabel,
}: {
  pulse: ReturnType<typeof pulseSeries>;
  horizon: Horizon;
  window: string;
  pressureSeries: ChartSeries;
  rawPressureSeries?: ChartSeries;
  rangeLabel?: string;
}) {
  const rows = useMemo(
    () => pulseDataRows(
      pulse.samples,
      pressureSeries.points,
      pulse.advancing,
      pulse.declining,
      rawPressureSeries?.points,
    ),
    [pulse, pressureSeries, rawPressureSeries],
  );
  const shareText = (value: number | null) => value === null ? "—" : `${value.toFixed(2)}%`;
  const pressureText = (value: number | null) => value === null ? "—" : signed(value);

  return (
    <div className="mp-table-scroll mp-pulse-data__scroll" tabIndex={0} role="region" aria-labelledby="mp-pulse-data-caption">
      <table className="mp-table" id="mp-pulse-data-table">
        <caption id="mp-pulse-data-caption">
          {horizonLabel(horizon)} breadth · requested {window} · {pulse.label} · {pulse.bucketMinutes}-minute buckets · {pressureSeries.label} selected
          {rawPressureSeries ? " · raw pressure also shown" : ""}
          {rangeLabel ? ` · ${rangeLabel}` : ""}
        </caption>
        <thead>
          <tr>
            <th scope="col">UTC time / coverage</th>
            <th scope="col">Advancing share</th>
            <th scope="col">Declining share</th>
            <th scope="col">{pressureSeries.label} (−3…+3)</th>
            {rawPressureSeries && <th scope="col">Raw pressure (−3…+3)</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const time = new Date(row.time).toISOString();
            const gapStart = new Date(row.time + 1).toISOString();
            return (
              <tr key={`${row.time}-${index}`} data-gap={row.gap || undefined}>
                <th scope="row">
                  {row.gap ? <>Coverage gap before <time dateTime={gapStart}>{gapStart}</time></> : <time dateTime={time}>{time}</time>}
                </th>
                <td>{row.gap ? "—" : shareText(row.advancing)}</td>
                <td>{row.gap ? "—" : shareText(row.declining)}</td>
                <td>{row.gap ? "—" : pressureText(row.pressure)}</td>
                {rawPressureSeries && <td>{row.gap ? "—" : pressureText(row.rawPressure)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
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
  asOf,
  historical = false,
  onSelectMetric,
}: {
  frame: DisplayFrame | null;
  history: HistoryPoint[];
  horizon: Horizon;
  window: string;
  setHorizon: (h: Horizon) => void;
  setWindow: (w: string) => void;
  replay: (id: string) => void;
  asOf?: number;
  historical?: boolean;
  onSelectMetric?: (request: MetricCohortRequest) => void;
}) {
  const [smooth, setSmooth] = useState(true);
  const [dataTableOpen, setDataTableOpen] = useState(false);
  const [rangeSelection, setRangeSelection] = useState<{
    history: HistoryPoint[]; horizon: Horizon; window: string; range: HistoryRange;
  } | null>(null);
  // Indexes only apply to the exact retained history and H/W that supplied them.
  const selectedRange = rangeSelection?.history === history && rangeSelection.horizon === horizon && rangeSelection.window === window
    ? rangeSelection.range : null;
  if (rangeSelection && selectedRange === null) {
    // Clear the old binding so returning to an earlier H/W cannot revive it.
    // The conditional update settles on the next render and releases old history.
    setRangeSelection(null);
  }
  const pulse = useMemo(() => pulseSeries(history, window, horizon), [history, window, horizon]);
  const rangeTimes = useMemo(() => historyRangeTimes([
    { points: pulse.advancing }, { points: pulse.declining },
    { points: pulse.pressure }, { points: pulse.smoothed },
  ]), [pulse]);
  const normalizedRange = normalizeHistoryRange(rangeTimes, selectedRange);
  const rangeStart = normalizedRange ? rangeTimes[normalizedRange.start] : null;
  const rangeEnd = normalizedRange ? rangeTimes[normalizedRange.end] : null;
  const rangeLabel = rangeStart !== null && rangeEnd !== null
    ? `Chart view ${new Date(rangeStart).toISOString()} to ${new Date(rangeEnd).toISOString()} UTC`
    : "Full retained chart view";
  const chartPulse = useMemo(() => selectedRange ? {
    ...pulse,
    advancing: selectHistoryPoints(pulse.advancing, rangeTimes, selectedRange),
    declining: selectHistoryPoints(pulse.declining, rangeTimes, selectedRange),
    pressure: selectHistoryPoints(pulse.pressure, rangeTimes, selectedRange),
    smoothed: selectHistoryPoints(pulse.smoothed, rangeTimes, selectedRange),
    // Keep full sample metadata so a selected gap sentinel retains its identity
    // even when the first post-gap observation falls outside the selected view.
  } : pulse, [pulse, rangeTimes, selectedRange]);
  const lastSmoothed = useMemo(
    () => [...pulse.smoothed].reverse().find((p) => p.value !== null)?.value ?? null,
    [pulse],
  );
  const markers = useMemo(
    () => selectHistoryPoints(coverageChangePoints(pulse.samples), rangeTimes, selectedRange)
      .map((p) => ({ time: p.time, label: "Coverage changed" })),
    [pulse.samples, rangeTimes, selectedRange],
  );
  const series = useMemo<ChartSeries[]>(
    () => [
      smooth
        ? {
            id: "pressure",
            label: `Breadth pressure · ${SMOOTHING_MINUTES}-min mean`,
            color: CHART.violet,
            points: chartPulse.smoothed,
            area: true,
            signSplit: { positive: CHART.positive, negative: CHART.negative },
            fillOpacity: 0.7,
            format: (v: number) => signed(v),
          }
        : {
            id: "pressure",
            label: "Breadth pressure · raw",
            color: CHART.violet,
            points: chartPulse.pressure,
            area: true,
            signSplit: { positive: CHART.positive, negative: CHART.negative },
            fillOpacity: 0.7,
            format: (v: number) => signed(v),
          },
      ...(smooth
        ? [{ id: "pressure-raw", label: "Breadth pressure · raw", color: CHART.muted, points: chartPulse.pressure, format: (v: number) => signed(v) } satisfies ChartSeries]
        : []),
      { id: "advancing", label: "Advancing share · raw", color: CHART.blue, points: chartPulse.advancing, axis: "secondary", tooltipOnly: true, format: percent },
      { id: "declining", label: "Declining share · raw", color: CHART.negative, points: chartPulse.declining, axis: "secondary", tooltipOnly: true, format: percent },
    ],
    [chartPulse, smooth],
  );
  const pressureSeries = series[0];
  const rawPressureSeries = smooth ? series.find((item) => item.id === "pressure-raw") : undefined;
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
          <VerdictCard frame={frame} horizon={horizon} history={history} smooth={smooth} asOf={asOf} historical={historical} />
          <BreadthLadder frame={frame} horizon={horizon} setHorizon={setHorizon} />
        </aside>
        <div className="mp-hero__chart" ref={ref}>
          <div className="mp-chart-legend">
            <button type="button" className="mp-up" disabled={!onSelectMetric || !frame} aria-label={`Filter instruments: ${horizonLabel(horizon)} advancing`} onClick={() => onSelectMetric?.({ kind: "breadth", horizon, side: "advancing" })}>
              ▲ {breadth?.advancing ?? "—"} advancing <Metric metric={breadth?.positive} digits={0} />
            </button>
            <button type="button" className="mp-down" disabled={!onSelectMetric || !frame} aria-label={`Filter instruments: ${horizonLabel(horizon)} declining`} onClick={() => onSelectMetric?.({ kind: "breadth", horizon, side: "declining" })}>
              ▼ {breadth?.declining ?? "—"} declining <Metric metric={breadth?.negative} digits={0} />
            </button>
            <button type="button" disabled={!onSelectMetric || !frame} aria-label={`Filter instruments: ${horizonLabel(horizon)} unchanged`} onClick={() => onSelectMetric?.({ kind: "breadth", horizon, side: "unchanged" })}>
              {breadth?.unchanged ?? "—"} unchanged
            </button>
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
              ariaLabel={`Advancing and declining share with breadth pressure over ${window}, ${horizonLabel(horizon)} horizon · ${rangeLabel}`}
              emptyText="Recording market history. The chart fills as frames are stored."
            />
          ) : (
            <div className="mp-hero__recording" role="status">
              <span className="mp-skeleton" style={{ height: 220 }} />
              <p>Recording market history. The chart fills as frames are stored.</p>
            </div>
          )}
          <HistoryRangeSelector
            times={rangeTimes}
            range={selectedRange}
            onChange={(range) => setRangeSelection(range ? { history, horizon, window, range } : null)}
          />
          <p className="mp-panel-detail">The range changes this chart and its table only. New history or a different horizon or window restores the full view.</p>
          <div className="mp-pulse-tools">
            <span className="mp-panel-detail" role="status">
              {pulse.label}
              {smooth ? ` · pressure line is a ${SMOOTHING_MINUTES}-minute rolling mean, raw grey` : " · raw one-minute pressure"}
              {" · filled area shows breadth pressure from zero"}
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
          <details className="mp-pulse-data" onToggle={(event) => setDataTableOpen(event.currentTarget.open)}>
            <summary>Accessible breadth data table · {horizonLabel(horizon)} · {window}</summary>
            {dataTableOpen && hasHistory && (
              <PulseDataTable
                pulse={chartPulse}
                horizon={horizon}
                window={window}
                pressureSeries={pressureSeries}
                rawPressureSeries={rawPressureSeries}
                rangeLabel={rangeLabel}
              />
            )}
          </details>
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

export interface SourceFamilyReading {
  key: string; family: string; state: string; evidence: string;
  qualified: boolean; freshness: string; scope: string;
}

/** Shared source-family qualification for the summary and its evidence panel. */
function sourceFamilyReadings(frame: DisplayFrame, asOf: number): SourceFamilyReading[] {
  const sourceReference = frame.flow ?? { status: "unavailable", reasons: ["SOURCE_UNAVAILABLE"] };
  const capabilityFor = (families: string[]) => {
    const capabilities = (frame.sourceCapabilities ?? []).filter(capability => families.includes(capability.family));
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
  const currentFlows = observedFlows.filter(row => rowTimeState(frame, row, asOf) === "CURRENT");
  const flowQualified = currentFlows.some(row => row.capabilityUsable && row.complete && !row.reasons.length);
  const bookQualified = observedBooks.some(row => row.capabilityUsable && !row.reasons.length && rowTimeState(frame, row, asOf) === "CURRENT");
  const flowFuture = observedFlows.some(row => rowTimeState(frame, row, asOf) === "FUTURE");
  const bookFuture = observedBooks.some(row => rowTimeState(frame, row, asOf) === "FUTURE");
  const flowExpired = observedFlows.length > 0 && observedFlows.every(row => rowTimeState(frame, row, asOf) === "EXPIRED");
  const bookExpired = observedBooks.length > 0 && observedBooks.every(row => rowTimeState(frame, row, asOf) === "EXPIRED");
  const derivatives = capabilityFor(["derivatives", "liquidations"]);
  const options = capabilityFor(["options"]);
  const external = capabilityFor(["external_context"]);
  const privateExposure = capabilityFor(["private_exposure"]);
  const research = capabilityFor(["conditional_outcomes"]);
  return [
    {
      key: "spot_flow", family: "Executed spot flow", qualified: flowQualified,
      freshness: flowFuture && !flowQualified ? "FUTURE" : flowExpired ? "EXPIRED" : currentFlows.length ? "CURRENT" : "UNAVAILABLE",
      scope: `${currentFlows.filter(row => row.capabilityUsable && row.complete && !row.reasons.length).length}/${observedFlows.length} complete qualified flow rows`,
      state: flowQualified ? "OBSERVED · QUALIFIED" : flowFuture ? "OBSERVED · FUTURE" : flowExpired ? "OBSERVED · EXPIRED" : spotFlow.state,
      evidence: `${spotFlow.detail} ${observedFlows.length ? `${observedFlows.length} stored flow rows; ${currentFlows.filter(row => row.complete && !row.reasons.length).length} complete, reason-free, available and unexpired at ${new Date(asOf).toISOString()}.` : "No executed-flow component is attached."} Status-only pointer: ${sourceReference.status}${sourceReference.reasons.length ? ` · ${sourceReference.reasons.join(", ")}` : ""}.`,
    },
    { key: "spot_liquidity", family: "Displayed liquidity", qualified: bookQualified, freshness: bookFuture && !bookQualified ? "FUTURE" : bookExpired ? "EXPIRED" : observedBooks.some(row => rowTimeState(frame, row, asOf) === "CURRENT") ? "CURRENT" : "UNAVAILABLE", scope: `${observedBooks.filter(row => row.capabilityUsable && !row.reasons.length && rowTimeState(frame, row, asOf) === "CURRENT").length}/${observedBooks.length} qualified size scenarios`, state: bookQualified ? "OBSERVED · QUALIFIED" : bookFuture ? "OBSERVED · FUTURE" : bookExpired ? "OBSERVED · EXPIRED" : spotLiquidity.state, evidence: `${spotLiquidity.detail} ${observedBooks.length ? `${observedBooks.length} stored order-size scenarios; partial coverage stays visibly partial.` : "No visible-book component is attached."}` },
    { key: "derivatives", family: "Derivatives positioning", qualified: false, freshness: "UNAVAILABLE", scope: "No qualified derivatives metric", state: derivatives.state, evidence: `${derivatives.detail} No qualified derivatives metric is attached.` },
    { key: "options", family: "Options", qualified: false, freshness: "UNAVAILABLE", scope: "No qualified observation", state: options.state, evidence: `${options.detail} Options remain outside the qualified evidence set.` },
    { key: "external_context", family: "External context", qualified: false, freshness: "UNAVAILABLE", scope: "No qualified observation", state: external.state, evidence: `${external.detail} External observations remain outside the qualified evidence set.` },
    { key: "private_exposure", family: "Private exposure", qualified: false, freshness: "UNAVAILABLE", scope: "No qualified observation", state: privateExposure.state, evidence: `${privateExposure.detail} No private owner data is read or projected here.` },
    { key: "conditional_outcomes", family: "Conditional outcomes", qualified: false, freshness: "UNAVAILABLE", scope: "No qualified observation", state: research.state === "NOT PROBED" ? "UNQUALIFIED" : research.state, evidence: `${research.detail} Deferred pending separately approved research and after-cost evidence.` },
  ];
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

function rowTimeState(frame: DisplayFrame, row: { available: number; expires: number }, asOf: number) {
  if (asOf < Math.max(frame.available_at_ms, row.available)) return "FUTURE";
  if (asOf >= Math.min(frame.expires_at_ms, row.expires)) return "EXPIRED";
  return "CURRENT";
}

/** Owner-recorded spot-flow and displayed-book observations. Never estimates depth or actionability. */
function MicrostructurePanelView({ frame, asOf = frame.available_at_ms, only, idPrefix = "mp" }: { frame: DisplayFrame; asOf?: number; only?: "flow" | "liquidity"; idPrefix?: string }) {
  const component = frame.microstructure;
  if (!component) return (
    <Panel id={`${idPrefix}-microstructure`} title="Executed flow &amp; displayed liquidity" detail="Owner-recorded observations only; no frontend flow or book calculation">
      <p className="mp-panel-footnote">Source held · this frame contains no microstructure component. The status-only flow pointer is not an observation.</p>
    </Panel>
  );
  const flows = only === "liquidity" ? [] : component.flows;
  const books = only === "flow" ? [] : component.liquidity;
  return (
    <Panel id={`${idPrefix}-microstructure`} title="Executed flow &amp; displayed liquidity" detail="Observed quantities from the owner component; price participation remains a separate correlated family">
      <p className="mp-panel-footnote">{component.sourceKind.toUpperCase()} · {component.replayClass.replaceAll("_", " ")} · assessed as of {new Date(asOf).toISOString()} · raw trades/books not retained · digest {component.componentId.slice(0, 12)}…</p>
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
export const FlowHistoryPanel = memo(FlowHistoryPanelView);

/** Owner-computed multi-window breadth trajectory and frozen-cohort contribution context. */
function BreadthContextPanelView({ frame }: { frame: DisplayFrame }) {
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
export const BreadthContextPanel = memo(BreadthContextPanelView);

/** Previous completed daily bars only; missing or short history stays explicitly unavailable. */
function DailyInternalsPanelView({ frame, asOf = frame.available_at_ms, onSelectMetric }: { frame: DisplayFrame; asOf?: number; onSelectMetric?: (request: MetricCohortRequest) => void }) {
  if (!frame.dailyInternals.length) return (
    <Panel id="mp-daily-internals" title="Daily range &amp; moving averages" detail="Owner-confirmed daily candles; no intraday substitutions">
      <p className="mp-panel-footnote">Unavailable · this frame has no owner-qualified daily-internals projection.</p>
    </Panel>
  );
  return (
    <Panel id="mp-daily-internals" title="Daily range &amp; moving averages" detail="Previous completed daily bars only; each value carries its own sample coverage">
      {onSelectMetric && <div className="mp-daily-filters" role="group" aria-label="Filter instruments by daily metric">
        {([
          ...(["20", "50", "200"] as const).map(period => ({ kind: "daily-above" as const, period })),
          ...(["high_break", "low_break", "close_break_high", "close_break_low"] as const).map(key => ({ kind: "daily-break" as const, key })),
        ] satisfies MetricCohortRequest[]).map(request => {
          const selection = selectMetricCohort(frame, request, asOf);
          return <button type="button" key={selection.label} onClick={() => onSelectMetric(request)} title={`${selection.definition} · ${selection.reasons.join(", ")}`}>
            {selection.label} · {selection.status === "available" ? `${selection.instrumentIds.length} matches · ${selection.valid}/${selection.expected} valid` : "Unavailable"}
          </button>;
        })}
      </div>}
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
  const contribution = frame.contributions?.[horizon];
  const equalReturn = contribution?.equalReturn;
  const returnFreshness = summaryMetricFreshness(frame, equalReturn, asOf);
  tiles.push({
    key: "equal_weight_return", label: "Equal-weight return",
    value: equalReturn?.value == null || returnFreshness === "FUTURE" ? "Unavailable" : metricText(equalReturn, 2, true),
    hint: `${horizonLabel(horizon)} · full start cohort ${contribution ? `${contribution.valid}/${contribution.expected}` : "unavailable"} · change unavailable`,
    title: equalReturn ? metricTitle(equalReturn) : "No owner-computed frozen start-cohort return is attached.",
    metric: equalReturn, horizon, freshness: returnFreshness,
    points: [], format: value => `${numberText(value, 2, true)}%`, delta: null, deltaTone: "",
  });
  for (const reading of sourceFamilyReadings(frame, asOf).filter(row => ["spot_flow", "spot_liquidity", "derivatives"].includes(row.key))) {
    tiles.push({
      key: reading.key, label: reading.key === "derivatives" ? "Derivatives stress" : reading.family,
      value: reading.qualified ? "Observed" : "Unavailable", hint: `${reading.scope} · ${reading.state}`,
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
          <small id={`mp-summary-${tile.key}-freshness`} className="mp-tile__freshness">{historical ? "Recorded · " : ""}{tile.freshness} · Frame observed at {Number.isFinite(frame.cutoff_ms) ? new Date(frame.cutoff_ms).toISOString() : "Unavailable"}</small>
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
            <SparkChart points={tile.points} height={34} format={tile.format} ariaLabel={`${tile.label} over ${window}`} color={CHART.blue} />
          )}
        </article>
        );
      })}
    </TileGrid>
  );
}
export const MarketSnapshotTiles = memo(MarketSnapshotTilesView);
