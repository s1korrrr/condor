import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { tri, utcMinute } from "./shown.mjs";
import "./market.css";

type Amount = number | string | null;
type HelmStatus = {
  generated_at: number; age_s: number; ready: boolean | null; failure: string | null; failure_reported: boolean; reasons: string[] | null;
  steps: Amount; actions: Amount; phase: string | null; profile_id: string | null; entries_held: string | null; operator_entry_paused: boolean | null;
  kill_switch: boolean | null; adaptive_actions: string | null; funding: string | null; image_tag: string | null;
  shutdown: { checkpoint: boolean | null; clean: boolean | null } | null;
  mandate: { mandate_id: string | null; state: string | null; valid_until_ms: number | null } | null;
  risk: { reason: string | null; latched: boolean | null; daily_loss_use: Amount; risk_reference_quote: Amount; unit: string | null } | null;
  control_rejections: { count: Amount; recent: ({ action: string | null; at_ms: number | null; reason: string | null } | null)[] } | null;
  symbols: { pair: string; status: string | null; candidate_hold: string | null; bag: { held_amount: Amount; breakeven_price: Amount } | null; last_decision: { at: number | null; reason: string | null } | null }[];
  withheld: number;
};
type HelmRead = { state: "FRESH" | "STALE" | "UNAVAILABLE" | "UNBOUND"; reason: string; bot: string | null; status: HelmStatus | null };

async function readHelm(): Promise<HelmRead> {
  const response = await fetch("/api/v5/helm", { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(14_000) });
  if (!response.ok) throw new Error(`Helm read failed (HTTP ${response.status})`);
  return response.json() as Promise<HelmRead>;
}

/** Owner codes as words; anything that is not text is shown as missing, never coerced. */
const words = (value: unknown) => typeof value === "string" && value ? value.replaceAll("_", " ") : "—";
const at = (ms: number | null | undefined) => utcMinute(ms) ?? "unknown time";
const amount = (value: Amount | undefined) => value == null ? "—" : String(value);
function duration(seconds: number) {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}

/** Helm page: the Helm paper bot's own published runtime state, read-only. Nothing here sends a control command. */
export function V5Helm() {
  const helm = useQuery({ queryKey: ["v5-helm"], queryFn: readHelm, retry: false, refetchInterval: 15_000 });
  const read = helm.data, status = read?.status;
  const fresh = read?.state === "FRESH";
  const stopped = !!status?.reasons?.includes("runtime_stopped");
  const lastAt = at(status ? status.generated_at * 1000 : null);
  // Only the runtime's own "runtime_stopped" reason says it stopped; an old status alone means the state is unknown.
  const headline = !read ? "" : read.state === "UNBOUND" ? "Not connected to this dashboard" : read.state === "UNAVAILABLE" ? `Status file unreadable (${words(read.reason)})`
    : stopped ? `Stopped (last status ${lastAt})` : !fresh ? `No status update since ${lastAt}; current state unknown`
    : status?.ready === true ? "Running" : `Publishing status, ready: ${tri(status?.ready, "yes", "no")}`;
  const good = fresh && !stopped && status?.ready === true;
  return <div className="v5m">
    <header className="v5m-head">
      <div><h1>Helm</h1><p>Helm paper bot ({read?.bot ?? "helm_v5_paper"}) · its own published runtime state · read-only, no controls on this page.</p></div>
      <div className="v5m-chips"><button className="v5m-refresh" onClick={() => void helm.refetch()}><RotateCw size={14} />Refresh</button></div>
    </header>
    {helm.isPending ? <p role="status" className="v5m-status">Reading Helm status…</p> : helm.isError ? <p role="alert" className="v5m-status">{helm.error.message}. Nothing older is shown.</p> : <>
      <section className={`v5m-card v5m-helm-head ${good ? "is-up" : "is-down"}`}>
        <strong>Helm paper bot: {headline}</strong>
        {read!.state === "UNBOUND" ? <p>{read!.reason}. The Helm status file has to be mounted read-only into the dashboard; no state is inferred.</p> : status && <p>
          Last status {duration(status.age_s)} ago{status.reasons == null ? " · reasons not published" : status.reasons.length ? ` · ${status.reasons.map(words).join(", ")}` : ""}
          {status.shutdown ? ` · shutdown ${tri(status.shutdown.clean, "clean", "not clean")}, checkpoint ${tri(status.shutdown.checkpoint, "saved", "missing")}` : ""}
          {status.failure ? ` · failure: ${status.failure}` : status.failure_reported ? " · a failure was reported but cannot be shown safely" : ""}.
        </p>}
      </section>
      {status && <>
        {!fresh && <p className="v5m-hint" role="note">Values below are as last published at {lastAt}, not the current state.</p>}
        {status.withheld > 0 && <p className="v5m-hint" role="note">{status.withheld} published value(s) did not match their expected form and are not shown.</p>}
        <div className="v5m-stats v5m-stats--wide">
          <Stat label="New entries" value={status.operator_entry_paused === true ? "Paused" : status.entries_held ? "Held" : status.operator_entry_paused === false ? "Not paused" : "Not published"} note={status.entries_held ? words(status.entries_held) : status.operator_entry_paused === false ? "no entry hold published" : "pause state not published"} warn={!!status.entries_held || status.operator_entry_paused !== false} />
          <Stat label="Mandate" value={words(status.mandate?.state)} note={status.mandate ? `${status.mandate.mandate_id ?? "id not published"} · until ${at(status.mandate.valid_until_ms)}` : "not published"} />
          <Stat label="Risk latch" value={tri(status.risk?.latched, "Latched", "Clear")} note={words(status.risk?.reason)} warn={status.risk?.latched !== false} />
          <Stat label="Daily loss used" value={amount(status.risk?.daily_loss_use)} note={`of the ${amount(status.risk?.risk_reference_quote)} ${status.risk?.unit ?? ""} risk reference`} />
          <Stat label="Kill switch" value={tri(status.kill_switch, "On", "Off")} warn={status.kill_switch !== false} />
          <Stat label="Phase · profile" value={status.phase ?? "—"} note={status.profile_id ?? undefined} />
          <Stat label="Runtime actions" value={amount(status.actions)} note={`${amount(status.steps)} engine steps`} />
          <Stat label="Funding" value={words(status.funding)} note={`adaptive actions ${words(status.adaptive_actions)}`} />
        </div>
        <section className="v5m-section"><header><h2>Coins</h2><span>Why each coin is or is not buying, and its bag</span></header>
          <div className="v5m-card"><table className="v5m-heat"><thead><tr><th>Pair</th><th>State</th><th>Entry candidate</th><th>Held</th><th>Breakeven</th><th>Last decision</th></tr></thead><tbody>{status.symbols.map(row => <tr key={row.pair}>
            <td>{row.pair}</td><td>{words(row.status)}</td><td>{words(row.candidate_hold)}</td>
            <td>{amount(row.bag?.held_amount)}</td><td>{amount(row.bag?.breakeven_price)}</td>
            <td title={row.last_decision?.at != null ? at(row.last_decision.at * 1000) : undefined}>{words(row.last_decision?.reason)}</td>
          </tr>)}</tbody></table>{!status.symbols.length && <p className="v5m-hint">No per-coin state published.</p>}</div>
        </section>
        <section className="v5m-section"><header><h2>Refused control commands</h2><span>{status.control_rejections == null ? "not published" : status.control_rejections.count == null ? "count not published" : `${status.control_rejections.count} in total`} · newest first · the runtime's own reasons</span></header>
          <div className="v5m-card">{status.control_rejections?.recent.filter(Boolean).length ? <ul className="v5m-list">{status.control_rejections.recent.filter(Boolean).map((row, index) => <li key={index}><b>{words(row!.action)}</b> at {at(row!.at_ms)}: {row!.reason ?? "reason not shown"}</li>)}</ul> : <p className="v5m-hint">{status.control_rejections?.count === 0 ? "None recorded." : "Not published by this runtime."}</p>}</div>
        </section>
        <p className="v5m-hint">Image {status.image_tag ?? "not published"} · status written {lastAt}.</p>
      </>}
    </>}
  </div>;
}

function Stat({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) {
  return <div className={`v5m-stat${warn ? " is-warn" : ""}`}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}
