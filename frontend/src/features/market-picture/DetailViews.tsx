import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { containDialogTab } from "@/lib/dialog-focus";
import {
  type DisplayAsset,
  type DisplayEvent,
  type DisplayFrame,
  dailyFeatureText,
  metricText,
  metricTitle,
} from "./presentation";
import { assetState, derivedRegime, isHourlyRelativeVolume, isShortBreadthCrossing, isSingleBarRelativeVolume, nullReasonLabel, REGIME_BASIS } from "./pulse.mjs";
import { Empty, Panel, Time } from "./Primitives";

function DerivedRegimeBlock({ asset }: { asset: DisplayAsset }) {
  const regime = derivedRegime(asset);
  const state = assetState(asset);
  if (!regime) return <p className="mp-muted">Indicators are still warming for this instrument.</p>;
  return (
    <dl className="mp-provenance-list">
      <dt>Regime</dt>
      <dd>{regime.label}{regime.tags.length ? ` · ${regime.tags.join(", ")}` : ""}</dd>
      <dt>Trend</dt>
      <dd>{state.trend ?? "—"}{state.adx != null ? ` · ADX14 ${state.adx.toFixed(1)}` : ""}</dd>
      <dt>Momentum</dt>
      <dd>{state.rsi != null ? `RSI14 ${state.rsi.toFixed(1)} · ${state.rsiZone}` : "—"}</dd>
      <dt>Basis</dt>
      <dd>{REGIME_BASIS}</dd>
    </dl>
  );
}

function formatStoredNumber(value: string | null, digits = 4, signed = false) {
  if (value == null) return "Unavailable";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "Invalid";
  return `${signed && numeric > 0 ? "+" : ""}${numeric.toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

export function Drawer({
  title,
  close,
  wide = false,
  children,
}: {
  title: string;
  close: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`mp-drawer${wide ? " mp-drawer-wide" : ""}`}
      aria-labelledby="mp-drawer-title"
      onKeyDown={containDialogTab}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="mp-drawer-body">
        <header>
          <h2 id="mp-drawer-title">{title}</h2>
          <button onClick={close} aria-label="Close details" autoFocus>
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

function eventCategory(type: string) {
  if (/regime/.test(type)) return "REGIME";
  if (/volume|rvol|flow/.test(type)) return "VOLUME";
  if (/high|low|breakout/.test(type)) return "BREAKOUT";
  return "ALERTS";
}
export function MarketEventFeed({
  events,
  frame,
  select,
  nextPage,
  hasMore,
  fault,
}: {
  events: DisplayEvent[];
  frame: DisplayFrame | null;
  select: (id: string) => void;
  nextPage: () => void;
  hasMore: boolean;
  fault?: string;
}) {
  const [filter, setFilter] = useState("ALL");
  const [showShort, setShowShort] = useState(false);
  const short = events.filter(isShortBreadthCrossing).length;
  const visible = events.filter(
    (e) =>
      (filter === "ALL" || eventCategory(e.type) === filter) &&
      (showShort || !isShortBreadthCrossing(e)),
  );
  return (
    <Panel
      id="mp-feed"
      title="Market alerts"
      detail={
        frame?.source_kind === "reconstructed"
          ? "Reconstructed"
          : "Stored events"
      }
      className="mp-feed"
    >
      <div className="mp-segment mp-feed-filters">
        {["ALL", "ALERTS", "REGIME", "VOLUME", "BREAKOUT"].map((f) => (
          <button
            key={f}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      {short > 0 && (
        <button className="mp-text-button" aria-pressed={showShort} onClick={() => setShowShort(!showShort)}>
          {showShort
            ? `Hide 1m/5m breadth crossings (${short})`
            : `${short} one- and five-minute breadth crossings folded · show`}
        </button>
      )}
      <div className="mp-feed-scroll">
        <table className="mp-table">
          <caption className="sr-only">
            Persisted market events, including correction and reconstruction
            state.
          </caption>
          <thead className="sr-only">
            <tr>
              <th>Time</th>
              <th>Asset</th>
              <th>Event</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((event) => (
              <tr key={event.event_id} data-severity={event.severity}>
                <td>
                  <Time value={event.observed} />
                </td>
                <th scope="row">
                  {event.instrument_id ? (
                    <button onClick={() => select(event.instrument_id!)}>
                      {frame?.assets.find(
                        (a) => a.instrument_id === event.instrument_id,
                      )?.symbol ?? event.instrument_id.split(":").at(-1)}
                    </button>
                  ) : (
                    "Market"
                  )}
                </th>
                <td>
                  <span>{event.type.replaceAll("_", " ")}</span>
                  {event.status !== "original" && (
                    <small className="mp-warning">{event.status}</small>
                  )}
                  {event.reconstructed && <small>Reconstructed</small>}
                </td>
                <td title={event.value}>{event.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && (
          <Empty>
            {fault
              ? `Event history could not be read · ${fault}`
              : "No stored events match this filter."}
          </Empty>
        )}
      </div>
      {hasMore && (
        <button className="mp-load-more" onClick={nextPage}>
          Load earlier events
        </button>
      )}
      <footer className="mp-panel-footnote">
        Original source times · corrections retained · no notification delivery
      </footer>
    </Panel>
  );
}

export function AssetInspector({
  asset,
  frame,
  asOf = frame.available_at_ms,
  watched,
  toggleWatch,
  note,
  saveNote,
  openNativeTools,
}: {
  asset: DisplayAsset;
  frame: DisplayFrame;
  asOf?: number;
  watched: boolean;
  toggleWatch: () => void;
  note: string;
  saveNote: (value: string) => void;
  openNativeTools: () => void;
}) {
  const daily = frame.dailyInternals.find(row => row.instrumentId === asset.instrument_id) ?? null;
  const flows = frame.microstructure?.flows.filter(row => row.instrumentId === asset.instrument_id) ?? [];
  const books = frame.microstructure?.liquidity.filter(row => row.instrumentId === asset.instrument_id) ?? [];
  const dailyCells = daily ? [
    ...Object.entries(daily.breaks).map(([key, cell]) => [`Prior 20d ${key.replaceAll("_", " ")}`, cell] as const),
    ...Object.entries(daily.averages).flatMap(([period, values]) =>
      Object.entries(values).map(([key, cell]) => [`SMA ${period} ${key.replaceAll("_", " ")}`, cell] as const)),
  ] : [];
  return (
    <div className="mp-inspector">
      <div className="mp-inspector-price">
        <div>
          <span>{asset.instrument_id}</span>
          <strong>
            {metricText(
              asset.price,
              asset.price.value !== null && asset.price.value < 1 ? 6 : 2,
            )}{" "}
            <small>{asset.quote}</small>
          </strong>
        </div>
        <button onClick={toggleWatch} aria-pressed={watched}>
          {watched ? "★ Watching" : "☆ Watch symbol"}
        </button>
      </div>
      <p className="mp-muted">
        {asset.sector === "Unknown" ? "" : `${asset.sector} · `}Observation at{" "}
        {new Date(frame.cutoff_ms).toISOString()} · {frame.source_kind}
      </p>
      <button onClick={openNativeTools}>Inspect recorded candles in native tools</button>
      <p className="mp-muted">Candles use a separate native source snapshot, when this exact instrument is available there.</p>
      <h3>Returns</h3>
      <div className="mp-inspector-returns">
        {Object.entries(asset.returns).map(([h, metric]) => (
          <div key={h}>
            <span>
              {h === "10080"
                ? "7d"
                : Number(h) >= 60
                  ? `${Number(h) / 60}h`
                  : `${h}m`}
            </span>
            <strong title={metricTitle(metric)}>
              {metricText(metric, 2, true)}
            </strong>
            <small>{metric.status}</small>
          </div>
        ))}
      </div>
      <h3>Regime & context</h3>
      {asset.regimes.length ? (
        asset.regimes.map((r, i) => (
          <dl className="mp-provenance-list" key={i}>
            <dt>Regime</dt>
            <dd>{r.label}</dd>
            <dt>Origin</dt>
            <dd>{r.origin}</dd>
            <dt>Confidence</dt>
            <dd>
              {r.confidence ?? "—"} ·{" "}
              {r.confidenceKind ?? "—"} · {r.calibration}
            </dd>
            <dt>Model</dt>
            <dd>{r.model ?? "—"}</dd>
            <dt>Trend / context</dt>
            <dd>
              {r.trend ?? "—"} / {r.context ?? "—"}
            </dd>
            <dt>Available</dt>
            <dd>{new Date(r.available).toISOString()}</dd>
          </dl>
        ))
      ) : (
        <DerivedRegimeBlock asset={asset} />
      )}
      <h3>Owner observations</h3>
      <table className="mp-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Value</th>
            <th>Status / coverage</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(asset.indicators).map(([name, metric]) => (
            <tr key={name}>
              <th scope="row">
                {isSingleBarRelativeVolume(metric)
                  ? `${name.replaceAll("_", " ")} · latest 1-min bar vs ${name === "rvol20" ? "prior 20-bar" : "prior 24h"} mean`
                  : isHourlyRelativeVolume(metric)
                    ? "Relative volume (1h) · last 60 min vs prior 24h hourly mean"
                    : name.replaceAll("_", " ")}
              </th>
              <td title={metricTitle(metric)}>{metricText(metric, 4)}</td>
              <td>
                {(isHourlyRelativeVolume(metric) && nullReasonLabel(metric)) || metric.status} · {metric.valid}/{metric.expected}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Daily internals</h3>
      {daily ? <>
        <p className="mp-muted">Previous completed daily bars · cutoff {new Date(daily.cutoff).toISOString()} · {daily.sourceCoverage.validBars}/{daily.sourceCoverage.expectedBars} bars · {daily.contiguousBars} contiguous · {daily.sourceCoverage.gaps} gaps · {daily.sourceCoverageStatus}{daily.sourceReasons.length ? ` · ${daily.sourceReasons.join(", ")}` : ""}</p>
        {daily.source && <p className="mp-muted">{daily.source.providerId} · {daily.source.pair} · {daily.source.sourceKind} · available {new Date(daily.source.available).toISOString()} · expires {new Date(daily.source.expires).toISOString()}</p>}
        <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-drawer-daily-caption">
          <table className="mp-table">
            <caption id="mp-drawer-daily-caption">Selected instrument daily features</caption>
            <thead><tr><th scope="col">Owner feature</th><th scope="col">Value</th><th scope="col">Status / samples</th></tr></thead>
            <tbody>{dailyCells.map(([name, cell]) => <tr key={name}>
              <th scope="row">{name}</th>
              <td title={metricTitle(cell.metric)}>{dailyFeatureText(cell.metric, cell.metricId, cell.label, asset.quote)}</td>
              <td>{cell.metric.status}{cell.metric.reasons.length ? ` · ${cell.metric.reasons.join(", ")}` : ""} · {cell.samples}/{cell.required}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </> : <p className="mp-muted">Unavailable · this frame has no daily-internals projection for the selected instrument.</p>}
      <h3>Executed flow &amp; displayed book</h3>
      {flows.length ? <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-drawer-flow-caption">
        <table className="mp-table">
          <caption id="mp-drawer-flow-caption">Selected instrument executed flow</caption>
          <thead><tr><th scope="col">Flow window</th><th scope="col">Buy / sell / unknown</th><th scope="col">Cumulative delta</th><th scope="col">Evidence</th></tr></thead>
          <tbody>{flows.map(row => {
            const usable = row.capabilityUsable && row.complete && !row.reasons.length && row.expires > asOf;
            return <tr key={`${row.sourceId}/${row.windowEnd}`}>
              <th scope="row">1m · {new Date(row.windowStart).toISOString()}–{new Date(row.windowEnd).toISOString()}</th>
              <td>{row.quoteAsset} {formatStoredNumber(row.buyQuote, 2)} / {formatStoredNumber(row.sellQuote, 2)} / {formatStoredNumber(row.unknownQuote, 2)}</td>
              <td>{usable && row.cumulativeAfter != null ? `${row.quoteAsset} ${formatStoredNumber(row.cumulativeAfter, 2, true)}` : `Unavailable${row.reasons.length ? ` · ${row.reasons.join(", ")}` : ""}`}</td>
              <td title={`${row.sourceId} · ${row.inputDigest} · ${row.reasons.join(", ")}`}>{usable ? "Qualified stored observation" : `UNAVAILABLE · ${row.reasons.join(", ") || "source, completeness, or freshness not qualified"}`} · {row.trades} trades · {row.duplicates} duplicates · {row.gaps.length} gaps</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <p className="mp-muted">Unavailable · no executed-flow row is attached for this instrument.</p>}
      {books.length ? <div className="mp-table-scroll" tabIndex={0} role="region" aria-labelledby="mp-drawer-book-caption">
        <table className="mp-table">
          <caption id="mp-drawer-book-caption">Selected instrument displayed-book scenarios</caption>
          <thead><tr><th scope="col">Recorded order size</th><th scope="col">Covered / uncovered</th><th scope="col">Full-size VWAP / book cost</th><th scope="col">Prior 7d percentile</th><th scope="col">Fee / total</th><th scope="col">Spread / band</th><th scope="col">Evidence</th></tr></thead>
          <tbody>{books.map((row, index) => {
            const partial = Number(row.uncovered) > 0;
            const fresh = row.expires > asOf;
            const valid = row.capabilityUsable && !row.reasons.length && fresh;
            const bookUsable = row.capabilityUsable && row.access !== "unknown" && fresh && !partial &&
              row.vwap != null && row.costBps != null;
            const reasons = row.costPercentileReasons ?? ["INSUFFICIENT_HISTORY"];
            return <tr key={`${row.sourceId}/${row.side}/${row.sizeUnit}/${row.requestedSize}/${index}`}>
              <th scope="row">{row.side} · {row.requestedSize} {row.sizeUnit}</th>
              <td>{row.coveredBase} base / {row.coveredQuote} quote · {row.uncovered} uncovered</td>
              <td>{bookUsable ? `${frame.quote} ${formatStoredNumber(row.vwap)} · ${formatStoredNumber(row.costBps, 2, true)} bps` : `Unavailable · ${partial ? "partial depth" : !fresh ? "expired" : row.reasons.join(", ") || "source or access not qualified"}`}</td>
              <td>{row.costPercentile7d == null ? `Unavailable · ${reasons.join(", ")}` : `${(row.costPercentile7d * 100).toFixed(1)} percentile`} · {row.costPercentileSampleCount ?? 0}/{row.costPercentileExpectedSamples ?? 10080}{row.costPercentileReferenceDigest ? ` · ref ${row.costPercentileReferenceDigest.slice(0, 12)}…` : ""}</td>
              <td>{row.feeBps == null ? "Fee unavailable" : `${formatStoredNumber(row.feeBps, 2)} bps · ${row.feeSource ?? "source unknown"}`} / {valid && row.totalCostBps != null ? `${formatStoredNumber(row.totalCostBps, 2, true)} bps total` : "total unavailable"}</td>
              <td>{row.spreadBps == null ? "Spread unavailable" : `${formatStoredNumber(row.spreadBps, 2)} bps`} · ±{formatStoredNumber(row.bandBps, 1)} bps band · {row.bandComplete ? "complete" : "partial"}</td>
              <td title={`${row.sourceId} · ${row.channel} · ${row.access} · observed ${row.observed} · available ${row.available} · expires ${row.expires} · ${row.reasons.join(", ")}`}>{!row.capabilityUsable ? "SOURCE NOT QUALIFIED" : !fresh ? "EXPIRED" : partial ? "PARTIAL DEPTH" : row.reasons.join(", ") || "COVERED"}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <p className="mp-muted">Unavailable · no displayed-book row is attached for this instrument.</p>}
      <p className="mp-muted">These are read-only observations assessed as of {new Date(asOf).toISOString()}. Frozen or replayed views use the frame decision time. Partial depth cannot describe full-size cost, and fee absence does not hide a complete book-only estimate.</p>
      <h3>Derivative &amp; option context</h3>
      <p className="mp-muted">Unavailable · no typed derivatives, liquidation, or options observation is attached for this instrument. This drawer does not infer positioning from price, flow, or displayed book.</p>
      <label className="mp-notes">
        Private source-scoped note
        <textarea
          value={note}
          onChange={(e) => saveNote(e.target.value.slice(0, 2000))}
          maxLength={2000}
          placeholder="Add your observation…"
        />
      </label>
      <p className="mp-muted">
        Notes and watchlists stay in this browser, scoped to your account and
        this source.
      </p>
    </div>
  );
}

export function CoverageProvenance({
  frame,
  faults,
  now,
}: {
  frame: DisplayFrame | null;
  faults: Record<string, string>;
  now: number;
}) {
  if (!frame)
    return (
      <Empty>
        No validated source frame is available. Enable and qualify the existing
        observation owner before treating this page as a market-wide view.
      </Empty>
    );
  const providers = frame.raw.providers as Record<string, unknown>;
  return (
    <>
      <dl className="mp-provenance-list">
        <dt>Universe</dt>
        <dd>
          {frame.universeId} · revision {frame.universeRevision}
        </dd>
        <dt>Coverage</dt>
        <dd>
          {frame.valid}/{frame.expected} valid observations
        </dd>
        <dt>Membership digest</dt>
        <dd>{frame.membershipHash}</dd>
        <dt>Snapshot</dt>
        <dd>{frame.snapshot_id}</dd>
        <dt>Source</dt>
        <dd>
          {frame.stream_id} · {frame.epoch} · sequence {frame.sequence}
        </dd>
        <dt>Observation cutoff</dt>
        <dd>{new Date(frame.cutoff_ms).toISOString()}</dd>
        <dt>Available / expires</dt>
        <dd>
          {new Date(frame.available_at_ms).toISOString()} /{" "}
          {new Date(frame.expires_at_ms).toISOString()}
        </dd>
        <dt>Read age</dt>
        <dd>
          {Math.max(0, Math.floor((now - frame.cutoff_ms) / 1000))} seconds ·{" "}
          {now >= frame.expires_at_ms ? "Stale" : "Within expiry"}
        </dd>
        <dt>Source kind</dt>
        <dd>
          {frame.fixture_marker
            ? "Synthetic test fixture; no production observations"
            : frame.source_kind}
        </dd>
        <dt>Content digest</dt>
        <dd>{frame.payload_digest}</dd>
      </dl>
      <h3>Provider capabilities</h3>
      {Object.entries(providers).map(([name, provider]) => (
        <details key={name}>
          <summary>{name.replaceAll("_", " ")}</summary>
          <pre>{JSON.stringify(provider, null, 2)}</pre>
        </details>
      ))}
      {Object.keys(faults).length > 0 && (
        <>
          <h3>Stored component availability</h3>
          {Object.entries(faults).map(([key, reason]) => (
            <p key={key} className="mp-warning">
              {key}: {reason}
            </p>
          ))}
        </>
      )}
      <h3>Definitions & evidence</h3>
      <p className="mp-muted">
        Canonical context, hourly relationships and complete UTC daily extremes
        retain their own timestamps. Display filters do not change the admitted
        observation universe. This surface does not change execution policy.
      </p>
      <details>
        <summary>Complete immutable frame</summary>
        <pre>{JSON.stringify(frame.raw, null, 2)}</pre>
      </details>
    </>
  );
}
