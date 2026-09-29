import { useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/auth-token";
import {
  canonicalContextExpiry,
  mergeCanonicalContext,
  parseCanonicalContext,
} from "./canonical-context.mjs";
import type {
  CanonicalContextAsset,
  CanonicalContextResponse,
  CanonicalContextSnapshot,
  CanonicalNamedFeature,
} from "./canonical-context.mjs";

const POLL_MS = 10_000;

interface CanonicalContextProps {
  server: string | null;
  paused: boolean;
  now: number;
}

interface ViewState {
  server: string | null;
  response: CanonicalContextResponse | null;
  snapshot: CanonicalContextSnapshot | null;
  error: string | null;
  loading: boolean;
}

function displayNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  if (value === 0) return "0";
  return new Intl.NumberFormat(undefined, {
    maximumSignificantDigits: 7,
    useGrouping: false,
  }).format(value);
}

function displayTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return new Date(value).toLocaleString();
}

function displayCoverage(feature: CanonicalNamedFeature): string {
  const count = `${feature.valid_count}/${feature.expected_count}`;
  const weight =
    feature.valid_weight_fraction == null
      ? "weight unavailable"
      : `${displayNumber(feature.valid_weight_fraction * 100)}% weight`;
  return `${count} · ${weight}`;
}

function FeatureTable({
  title,
  features,
  caption,
}: {
  title: string;
  features: CanonicalNamedFeature[];
  caption: string;
}) {
  return (
    <details className="canonical-context__group market-context-details" open>
      <summary>
        <span>{title}</span>
        <span className="canonical-context__count">{features.length}</span>
      </summary>
      <div className="canonical-context__table-wrap market-table-scroll">
        <table className="canonical-context__table market-context-table">
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">Value</th>
              <th scope="col">Horizon</th>
              <th scope="col">Status</th>
              <th scope="col">Coverage</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {features.length ? (
              features.map((feature) => (
                <tr key={`${feature.name}:${feature.horizon_minutes}`}>
                  <th scope="row">{feature.name}</th>
                  <td>
                    {displayNumber(feature.value)}
                    <span className="canonical-context__unit">
                      {feature.unit}
                    </span>
                  </td>
                  <td>{feature.horizon_minutes} min</td>
                  <td>
                    <span
                      className="canonical-context__status"
                      data-status={feature.status.toLowerCase()}
                    >
                      {feature.status}
                    </span>
                  </td>
                  <td>{displayCoverage(feature)}</td>
                  <td>
                    {feature.reasons.length ? feature.reasons.join(", ") : "—"}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6}>
                  No features were published for this section.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function AssetFeatures({ asset }: { asset: CanonicalContextAsset }) {
  return (
    <details className="canonical-context__asset market-context-details">
      <summary>
        <span>{asset.instrument_id}</span>
        <span className="canonical-context__count">
          {asset.features.length} features
        </span>
      </summary>
      {asset.reasons.length > 0 && (
        <p className="canonical-context__reason">
          Asset status: {asset.reasons.join(", ")}
        </p>
      )}
      <FeatureTable
        title={`${asset.asset_id} feature values`}
        features={asset.features}
        caption={`All owner-published features for ${asset.instrument_id}.`}
      />
      <details className="canonical-context__fits market-context-details">
        <summary>Factor fit records ({asset.fits.length})</summary>
        <pre>{JSON.stringify(asset.fits, null, 2)}</pre>
      </details>
    </details>
  );
}

function sourceError(status: number): string {
  if (status === 401 || status === 403)
    return "Your Condor session cannot access this source.";
  if (status === 502)
    return "The configured market-context source returned an invalid or unavailable response.";
  return "Market context could not be refreshed. The last received snapshot is retained.";
}

function downloadSnapshot(snapshot: CanonicalContextSnapshot) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `market-context-${snapshot.snapshot_id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function CanonicalContext({
  server,
  paused,
  now,
}: CanonicalContextProps) {
  const [state, setState] = useState<ViewState>({
    server: null,
    response: null,
    snapshot: null,
    error: null,
    loading: false,
  });
  const visibleState = state.server === server ? state : null;
  const response = visibleState?.response ?? null;
  const snapshot = visibleState?.snapshot ?? null;
  const expiry = useMemo(
    () => canonicalContextExpiry(snapshot, now),
    [snapshot, now],
  );

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const isHidden = () => typeof document !== "undefined" && document.hidden;

    if (!server) {
      setState({ server: null, response: null, snapshot: null, error: null, loading: false });
      return () => {
        disposed = true;
      };
    }

    setState((current) =>
      current.server === server
        ? current
        : { server, response: null, snapshot: null, error: null, loading: false },
    );

    if (paused) {
      setState((current) =>
        current.server === server && current.loading
          ? { ...current, loading: false }
          : current,
      );
      return () => {
        disposed = true;
      };
    }

    const poll = async () => {
      if (disposed || paused || isHidden() || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      setState((current) =>
        current.server === server
          ? { ...current, loading: true, error: null }
          : { server, response: null, snapshot: null, error: null, loading: true },
      );
      try {
        const response = await authFetch(
          `/api/v1/servers/${encodeURIComponent(server)}/screener/context`,
          {
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
        if (!response.ok) {
          if (!disposed && !controller.signal.aborted) {
            setState((current) =>
              current.server === server
                ? {
                    ...current,
                    error: sourceError(response.status),
                    loading: false,
                  }
                : current,
            );
          }
        } else {
          const parsed = parseCanonicalContext(await response.json());
          if (!disposed && !controller.signal.aborted) {
            setState((current) => {
              const previous = current.server === server ? current.snapshot : null;
              return {
                server,
                ...mergeCanonicalContext(previous, parsed),
                error: null,
                loading: false,
              };
            });
          }
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted) {
          setState((current) =>
            current.server === server
              ? {
                  ...current,
                  error:
                    error instanceof TypeError
                      ? error.message
                      : "Market context could not be refreshed.",
                  loading: false,
                }
              : current,
          );
        }
      } finally {
        inFlight = false;
        if (!disposed && !paused && !isHidden())
          timer = setTimeout(poll, POLL_MS);
      }
    };

    const onVisibilityChange = () => {
      if (isHidden()) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        controller?.abort();
      } else {
        void poll();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [server, paused]);

  return (
    <section
      className="canonical-context market-overview"
      aria-labelledby="canonical-context-title"
    >
      <header className="canonical-context__header market-overview-head">
        <div>
          <p className="canonical-context__eyebrow">Separate owner snapshot</p>
          <h2 id="canonical-context-title">Canonical market context</h2>
          <p>
            This source keeps its own universe, cutoff, and provenance. It does
            not expand the screener cohort or change trading behavior.
          </p>
        </div>
        {snapshot && (
          <button type="button" onClick={() => downloadSnapshot(snapshot)}>
            Download snapshot JSON
          </button>
        )}
      </header>

      {paused && (
        <p className="canonical-context__notice market-context-note">
          Updates are paused. The displayed snapshot and its expiry time are
          retained.
        </p>
      )}
      {visibleState?.loading && (
        <p role="status">Refreshing canonical market context…</p>
      )}
      {visibleState?.error && (
        <p
          className="canonical-context__error market-context-warning"
          role="alert"
        >
          {visibleState.error}
        </p>
      )}

      {!server && (
        <p className="canonical-context__notice market-context-note">
          Select a server to check for a canonical context provider.
        </p>
      )}
      {server &&
        !response &&
        !visibleState?.loading &&
        !visibleState?.error && (
          <p className="canonical-context__notice market-context-note">
            Canonical context is unavailable until the server has the context
            reader configured and its owner store mounted.
          </p>
        )}
      {response?.availability === "unavailable" && (
        <p
          className="canonical-context__notice market-context-note"
          role="status"
        >
            Canonical context refresh is unavailable:{" "}
            {response.reason.replaceAll("_", " ").toLowerCase()}.
            {snapshot
              ? " The last received snapshot remains displayed; its expiry is shown below."
              : ""}
        </p>
      )}

      {snapshot && (
        <>
          <dl className="canonical-context__identity market-definition">
            <div>
              <dt>Owner status</dt>
              <dd>{snapshot.status}</dd>
            </div>
            <div>
              <dt>Freshness</dt>
              <dd>
                {expiry === "expired"
                  ? "Expired"
                  : expiry === "future"
                    ? "Not available yet"
                    : expiry === "current"
                      ? "Within owner expiry"
                      : "Unknown"}
              </dd>
            </div>
            <div>
              <dt>Source kind</dt>
              <dd>{snapshot.source_kind}</dd>
            </div>
            <div>
              <dt>Venue / quote</dt>
              <dd>
                {snapshot.venue} · {snapshot.numeraire}
              </dd>
            </div>
            <div>
              <dt>Universe</dt>
              <dd>
                {snapshot.coverage.valid_count}/
                {snapshot.coverage.expected_count} valid ·{" "}
                {displayNumber(snapshot.coverage.valid_weight_fraction * 100)}%
                weight
              </dd>
            </div>
            <div>
              <dt>Stream / sequence</dt>
              <dd>
                {snapshot.stream_id} · {snapshot.sequence}
              </dd>
            </div>
            <div>
              <dt>Cutoff</dt>
              <dd>{displayTime(snapshot.cutoff_ms)}</dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>{displayTime(snapshot.available_at_ms)}</dd>
            </div>
            <div>
              <dt>Inputs available through</dt>
              <dd>{displayTime(snapshot.max_input_available_at_ms)}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{displayTime(snapshot.expires_at_ms)}</dd>
            </div>
            <div>
              <dt>Snapshot</dt>
              <dd>
                <code>{snapshot.snapshot_id}</code>
              </dd>
            </div>
          </dl>
          {snapshot.reasons.length > 0 && (
            <p className="canonical-context__reason market-context-warning">
              Owner reasons: {snapshot.reasons.join(", ")}
            </p>
          )}
          <FeatureTable
            title="Market features"
            features={snapshot.market}
            caption="All market-level features in this canonical snapshot."
          />
          <details className="canonical-context__group market-context-details">
            <summary>
              <span>Per-asset features</span>
              <span className="canonical-context__count">
                {snapshot.assets.length} assets
              </span>
            </summary>
            {snapshot.assets.length ? (
              snapshot.assets.map((asset) => (
                <AssetFeatures key={asset.asset_id} asset={asset} />
              ))
            ) : (
              <p>No per-asset features were published.</p>
            )}
          </details>
          <details className="canonical-context__group market-context-details">
            <summary>Snapshot provenance</summary>
            <dl className="canonical-context__provenance market-provider-list">
              {Object.entries(snapshot.provenance).map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replaceAll("_", " ")}</dt>
                  <dd>
                    {Array.isArray(value) ? value.join(", ") : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </section>
  );
}
