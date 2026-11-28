import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { ownerTitleText, age, count, usdc, utcMin } from './format.mjs';
import { OwnerValue } from "./OwnerValue";
import { tri } from "./shown.mjs";
import { helmCoinRow, helmCoinsNote, helmHeadline } from "./helm-model.mjs";
import "./market.css";

type Amount = number | string | null;
type HelmSignal = {
  at: number | null; candle_open: number | null; close: string | null;
  rsi: string | null; previous_rsi: string | null; rsi_length: number | null; oversold: string | null;
  atr_fraction: string | null; atr_length: number | null; min_atr_fraction: string | null; max_atr_fraction: string | null;
  decision: { enter: boolean | null; reason: string | null } | null;
};
export type HelmStatus = {
  generated_at: number; age_s: number; ready: boolean | null; failure: string | null; failure_reported: boolean; reasons: string[] | null;
  steps: Amount; actions: Amount; phase: string | null; profile_id: string | null; entries_held: string | null; operator_entry_paused: boolean | null;
  kill_switch: boolean | null; adaptive_actions: string | null; funding: string | null; image_tag: string | null;
  shutdown: { checkpoint: boolean | null; clean: boolean | null } | null;
  mandate: { mandate_id: string | null; revision: number | null; revocation_id: string | null; state: string | null; valid_until_ms: number | null; effective_until_ms?: number | null } | null;
  risk: { reason: string | null; latched: boolean | null; daily_loss_use: Amount; risk_reference_quote: Amount; unit: string | null } | null;
  control_rejections: { count: Amount; recent: ({ action: string | null; at_ms: number | null; reason: string | null } | null)[] } | null;
  recipe_version: string | null;
  gates: ({ gate: string | null; note: string | null } | null)[];
  symbols: { pair: string; status: string | null; candidate_hold: string | null; bag: { held_amount: Amount; breakeven_price: Amount } | null; last_decision: { at: number | null; reason: string | null } | null; signal: HelmSignal | null }[];
  withheld: number;
};
export type HelmRead = { state: "FRESH" | "STALE" | "UNAVAILABLE" | "UNBOUND"; reason: string; bot: string | null; status: HelmStatus | null };

export async function readHelm(): Promise<HelmRead> {
  const response = await fetch("/api/v5/helm", { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(14_000) });
  if (!response.ok) throw new Error(`Helm read failed (HTTP ${response.status})`);
  return response.json() as Promise<HelmRead>;
}

/** Owner codes as words; anything that is not text is shown as missing, never coerced. */
const words = (value: unknown) => typeof value === "string" && value ? value.replaceAll("_", " ") : "—";
const at = (ms: number | null | undefined) => utcMin(ms) ?? "unknown time";
/** The runtime's effective end (earliest of mandate, authorization and eligibility) when it publishes one, else the mandate's own end, named as such. */
const mandateEnd = (mandate: NonNullable<HelmStatus["mandate"]>) => {
  const effectiveEnd = utcMin(mandate.effective_until_ms);
  return effectiveEnd ? `until ${effectiveEnd}` : `mandate ends ${at(mandate.valid_until_ms)} (effective end unavailable)`;
};

/** Helm page: the Helm paper bot's own published runtime state, read-only. Nothing here sends a control command. */
export function V5Helm() {
  const helm = useQuery({ queryKey: ["v5-helm"], queryFn: readHelm, retry: false, refetchInterval: 15_000 });
  const read = helm.data, status = read?.status;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  // The server's age at read time plus local time since the read arrived, so it ticks between reads.
  const ageS = status ? status.age_s + Math.max(0, now - helm.dataUpdatedAt) / 1000 : null;
  const fresh = read?.state === "FRESH";
  const coins = status?.symbols.map(row => helmCoinRow(row, { fresh: fresh && ageS != null && ageS <= 30, nowS: status.generated_at + (ageS ?? status.age_s) })) ?? [];
  const coinsNote = helmCoinsNote(coins, status?.withheld);
  const rejectionCount = status?.control_rejections?.count;
  const noRejections = rejectionCount === 0 || typeof rejectionCount === "string" && /^-?0+(?:\.0+)?$/.test(rejectionCount);
  const lastAt = at(status ? status.generated_at * 1000 : null);
  const { text: headline, good, detail } = helmHeadline(read);
  return <div className="v5m">
    <header className="v5m-head">
      <div><h1>Helm</h1><p>Helm paper bot ({read?.bot ?? "helm_v5_paper"}) · its own published runtime state · read-only, no controls on this page.</p></div>
      <div className="v5m-chips"><button className="v5m-refresh" onClick={() => void helm.refetch()}><RotateCw size={14} />Refresh</button></div>
    </header>
    {helm.isPending ? <p role="status" className="v5m-status">Reading Helm status…</p> : helm.isError ? <p role="alert" className="v5m-status">{helm.error.message}. Nothing older is shown.</p> : <>
      <section className={`v5m-card v5m-helm-head ${good === true ? "is-up" : good === false ? "is-down" : ""}`}>
        <strong>Helm paper bot: {headline}</strong>
        {detail && <p>{detail}</p>}
        {read!.state === "UNBOUND" ? <p>{read!.reason}. The Helm status file has to be mounted read-only into the dashboard; no state is inferred.</p> : read!.reason === "HELM_STATUS_MISSING" ? <p>No Helm status file exists in its state directory. The runtime may be stopped or still starting; nothing is shown until it publishes.</p> : status && <p>
          Last status {age(ageS ?? status.age_s)} ago{status.reasons == null ? " · reasons not published" : status.reasons.length ? ` · ${status.reasons.map(words).join(", ")}` : ""}
          {status.shutdown ? ` · shutdown ${tri(status.shutdown.clean, "clean", "not clean")}, checkpoint ${tri(status.shutdown.checkpoint, "saved", "missing")}` : ""}
          {status.failure ? ` · failure: ${status.failure}` : status.failure_reported ? " · a failure was reported but cannot be shown safely" : ""}.
        </p>}
      </section>
      {status && <>
        {!fresh && <p className="v5m-hint" role="note">Values below are as last published at {lastAt}, not the current state.</p>}
        {status.withheld > 0 && <p className="v5m-hint" role="note">{count(status.withheld)} published value(s) did not match their expected form and are not shown.</p>}
        <div className="v5m-stats v5m-stats--wide">
          <Stat label="New entries" value={status.operator_entry_paused === true ? "Paused" : status.entries_held ? "Held" : status.operator_entry_paused === false ? "Not paused" : "Not published"} note={status.entries_held ? words(status.entries_held) : status.operator_entry_paused === false ? "no entry hold published" : "pause state not published"} warn={!!status.entries_held || status.operator_entry_paused !== false} />
          <Stat label="Mandate" value={words(status.mandate?.state)} note={status.mandate ? <><span>{status.mandate.mandate_id ?? "id not published"}</span> · revision {status.mandate.revision == null ? "not published" : count(status.mandate.revision)} · {mandateEnd(status.mandate)}</> : "not published"} title={status.mandate?.revocation_id ? `Revocation id ${status.mandate.revocation_id} (shared by the mandate and its authorization)` : undefined} />
          <Stat label="Risk latch" value={tri(status.risk?.latched, "Latched", "Clear")} note={words(status.risk?.reason)} warn={status.risk?.latched !== false} />
          <Stat label="Daily loss used" value={<OwnerValue value={status.risk?.daily_loss_use} kind="usdc" unit="" />} note={<>of the <span title={ownerTitleText(status.risk?.risk_reference_quote == null ? undefined : String(status.risk.risk_reference_quote))}>{usdc(status.risk?.risk_reference_quote, status.risk?.unit ?? "")}</span> risk reference</>} />
          <Stat label="Kill switch" value={tri(status.kill_switch, "On", "Off")} warn={status.kill_switch !== false} />
          <Stat label="Phase · profile" value={status.phase ?? "—"} note={status.profile_id ?? undefined} />
          <Stat label="Runtime actions" value={count(status.actions)} note={`${count(status.steps)} engine steps`} />
          <Stat label="Funding" value={words(status.funding)} note={`adaptive actions ${words(status.adaptive_actions)}`} />
        </div>
        <section className="v5m-section"><header><h2>Coins</h2><span>Why each coin is or is not buying, and its bag</span></header>
          {coins.length ? <>
            {coinsNote && <p className="v5m-hint" role="note">{coinsNote}</p>}
            <div className="v5m-card v5m-helm-table"><table className="v5m-heat v5m-helm-coins"><thead><tr><th>Pair</th><th>Buy rule</th><th>Where it is now</th><th className="is-number">Held</th><th className="is-number">Breakeven</th></tr></thead><tbody>{coins.map(row => <tr key={row.pair}>
              <td>{row.pair}</td><td>{row.rule}</td><td><CoinSignal row={row} /></td>
              <td className="is-number">{row.held}{row.bagNote && <small>{row.bagNote}</small>}</td><td className="is-number">{row.breakeven}</td>
            </tr>)}</tbody></table></div>
            <div className="v5m-helm-mobile">{coins.map(row => <article className="v5m-card v5m-helm-coin" key={row.pair}>
              <h3>{row.pair}</h3>{row.signalPublished && <p>{row.rule}</p>}<CoinSignal row={row} />
              <dl className="v5m-kv"><dt>Held</dt><dd>{row.held}</dd><dt>Breakeven</dt><dd>{row.breakeven}</dd></dl>
              {row.bagNote && <small>{row.bagNote}</small>}
            </article>)}</div>
          </> : <p className="v5m-hint">No per-coin state published.</p>}
        </section>
        {!noRejections && <section className="v5m-section"><header><h2>Refused control commands</h2><span>{status.control_rejections == null ? "not published" : status.control_rejections.count == null ? "count not published" : `${count(status.control_rejections.count)} in total`} · newest first · the runtime's own reasons</span></header>
          <div className="v5m-card">{status.control_rejections?.recent.filter(Boolean).length ? <ul className="v5m-list">{status.control_rejections.recent.filter(Boolean).map((row, index) => <li key={index}><b>{words(row!.action)}</b> at {at(row!.at_ms)}: {row!.reason ?? "reason not shown"}</li>)}</ul> : <p className="v5m-hint">Not published by this runtime.</p>}</div>
        </section>}
        <p className="v5m-hint">Image {status.image_tag ?? "not published"} · status written {lastAt}.</p>
      </>}
    </>}
  </div>;
}

function CoinSignal({ row }: { row: ReturnType<typeof helmCoinRow> }) {
  if (!row.signalPublished) return <div className="v5m-helm-signal"><span className="v5m-muted">—</span><small>{row.owner}</small></div>;
  return <div className="v5m-helm-signal"><span className={row.rsi.startsWith("—") ? "v5m-muted" : undefined} title={ownerTitleText(row.rsiTitle)}>{row.rsi}</span><span className={row.atr.startsWith("—") ? "v5m-muted" : undefined}>{row.atr}</span><small>{row.decision}</small><small>{row.owner}</small><small>{row.sample}</small></div>;
}

function Stat({ label, value, note, warn, title }: { label: string; value: ReactNode; note?: ReactNode; warn?: boolean; title?: string }) {
  return <div className={`v5m-stat${warn ? " is-warn" : ""}`} title={ownerTitleText(title)}><span>{label}</span><strong>{value}</strong>{note && <> <small>{note}</small></>}</div>;
}
