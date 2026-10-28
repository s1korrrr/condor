import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { projectV5Advisory, type V5AdvisoryView } from "./v5-advisory-view.mjs";
import "./v5-advisory-panel.css";

async function read(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await api.getV5Advisory(path, signal);
  if (!response.ok) throw new Error("V5 advisory observation is unavailable");
  return response.json();
}

async function readProjection(signal: AbortSignal): Promise<V5AdvisoryView> {
  const paths = ["v1/context", "v1/advice/status", "v1/advice/latest", "v1/advice/history"];
  const results = await Promise.allSettled(paths.map((path) => read(path, signal)));
  const values = Object.fromEntries(
    paths.map((path, index) => [path, results[index].status === "fulfilled" ? results[index].value : null]),
  );
  if (results.every((result) => result.status === "rejected"))
    throw new Error("V5 advisory observation is unavailable");
  return projectV5Advisory(values, Date.now());
}

function formatTimestamp(timestamp: number | null): string {
  return timestamp === null ? "Unavailable" : new Date(timestamp).toISOString();
}

export function V5AdvisoryPanel() {
  const query = useQuery({
    queryKey: ["v5-advisory"],
    queryFn: ({ signal }) => readProjection(signal),
    refetchInterval: 30_000,
    staleTime: 5_000,
    retry: 1,
  });
  const view = query.data;
  return (
    <section className="v5-advisory" aria-labelledby="v5-advisory-title">
      <header className="v5-advisory__header">
        <div>
          <p className="v5-advisory__eyebrow">Observation only · no trading effect</p>
          <h2 id="v5-advisory-title">V5 market assessment</h2>
        </div>
        <span className="v5-advisory__status" data-state={query.isError || view?.freshness === "UNAVAILABLE" ? "unavailable" : view?.freshness.toLowerCase() ?? "loading"}>
          {query.isPending ? "Loading" : query.isError ? "Unavailable" : view?.freshness ?? "Unavailable"}
        </span>
      </header>
      {query.isError ? (
        <p className="v5-advisory__muted" role="status">No connected V5 observation source is available.</p>
      ) : (
        <>
          <div className="v5-advisory__readout">
            <div>
              <span>Assessment</span>
              <strong>{view?.assessment ?? "Unavailable"}</strong>
            </div>
            <div>
              <span>Mode / effect</span>
              <strong>{view?.mode ?? "Unavailable"} / NONE</strong>
            </div>
            <div>
              <span>Model / native V5 parity</span>
              <strong>{view?.model ?? "Unavailable"} / {view?.nativeV5Parity ?? "Unavailable"}</strong>
            </div>
            <div>
              <span>Context available at</span>
              <strong>{formatTimestamp(view?.availableAtMs ?? null)}</strong>
            </div>
            <div>
              <span>Expiry</span>
              <strong>{formatTimestamp(view?.expiresAtMs ?? null)}</strong>
            </div>
          </div>
          <p className="v5-advisory__summary">{view?.summary ?? "No current assessment is available."}</p>
          <div className="v5-advisory__columns">
            <div>
              <h3>Market context</h3>
              {view?.features.length ? <ul>{view.features.map((feature) => (
                <li key={feature.id}>
                  <span>{feature.id}</span>
                  <strong>{feature.value === null ? "Unavailable" : `${feature.value}${feature.unit ? ` ${feature.unit}` : ""}`}</strong>
                  <small>{feature.status}</small>
                </li>
              ))}</ul> : <p className="v5-advisory__muted">Feature values unavailable.</p>}
            </div>
            <div>
              <h3>Data quality</h3>
              {view?.quality.length ? <ul>{view.quality.map((item) => (
                <li key={item.id}><span>{item.id}</span><strong>{item.value ?? "Unavailable"}</strong></li>
              ))}</ul> : <p className="v5-advisory__muted">Quality details unavailable.</p>}
              <h3>Advisor use</h3>
              <ul>
                <li><span>Total settled spend</span><strong>{view?.spentUsd === null || view?.spentUsd === undefined ? "Unavailable" : `$${view.spentUsd.toFixed(4)}`}</strong></li>
                <li><span>Uncertain reserved</span><strong>{view?.reservedUsd === null || view?.reservedUsd === undefined ? "Unavailable" : `$${view.reservedUsd.toFixed(4)}`}</strong></li>
                <li><span>Calls today</span><strong>{view?.callsToday ?? "Unavailable"}</strong></li>
                <li><span>Advisor enabled</span><strong>{view?.enabled === null || view?.enabled === undefined ? "Unavailable" : view.enabled ? "Yes" : "No"}</strong></li>
                <li><span>Journal status</span><strong>{view?.journalStatus ?? "Unavailable"}</strong></li>
              </ul>
            </div>
          </div>
          {view?.reasons.length ? <p className="v5-advisory__reasons">Reasons: {view.reasons.join(" · ")}</p> : null}
          <details className="v5-advisory__history">
            <summary>Recent assessment history</summary>
            {view?.history.length ? <ul>{view.history.map((item) => (
              <li key={`${item.availableAtMs ?? "unknown"}-${item.assessment}`}>
                <span>{item.assessment}</span>
                <time>{formatTimestamp(item.availableAtMs)}</time>
              </li>
            ))}</ul> : <p className="v5-advisory__muted">Assessment history unavailable.</p>}
          </details>
        </>
      )}
    </section>
  );
}
