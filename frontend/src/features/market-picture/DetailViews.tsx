import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { containDialogTab } from "@/lib/dialog-focus";
import {
  type DisplayAsset,
  type DisplayEvent,
  type DisplayFrame,
  metricText,
  metricTitle,
} from "./presentation";
import { Empty, Panel, Time } from "./Primitives";

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
  const visible = events.filter(
    (e) => filter === "ALL" || eventCategory(e.type) === filter,
  );
  return (
    <Panel
      id="mp-feed"
      title="Live feed"
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
      {frame && frame.flow?.status !== "available" && (
        <p className="mp-muted" title={(frame.flow?.reasons ?? ["SOURCE_UNAVAILABLE"]).join(", ")}>
          Taker flow unavailable · no qualified trade source
        </p>
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
              ? `Event history unavailable · ${fault}`
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
  watched,
  toggleWatch,
  note,
  saveNote,
  openNativeTools,
}: {
  asset: DisplayAsset;
  frame: DisplayFrame;
  watched: boolean;
  toggleWatch: () => void;
  note: string;
  saveNote: (value: string) => void;
  openNativeTools: () => void;
}) {
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
        {asset.sector} · observation at{" "}
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
              {r.confidence ?? "Unavailable"} ·{" "}
              {r.confidenceKind ?? "Kind unavailable"} · {r.calibration}
            </dd>
            <dt>Model</dt>
            <dd>{r.model ?? "Unavailable"}</dd>
            <dt>Trend / context</dt>
            <dd>
              {r.trend ?? "Unavailable"} / {r.context ?? "Unavailable"}
            </dd>
            <dt>Available</dt>
            <dd>{new Date(r.available).toISOString()}</dd>
          </dl>
        ))
      ) : (
        <p className="mp-muted">
          No qualified same-bar regime record is attached to this instrument.
        </p>
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
              <th scope="row">{name.replaceAll("_", " ")}</th>
              <td title={metricTitle(metric)}>{metricText(metric, 4)}</td>
              <td>
                {metric.status} · {metric.valid}/{metric.expected}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
