import type { PaperRead } from "./contracts";
import "./bots-truth.css";
import { entryPause, entryPauseText, lastFillPerPair } from "./bots-truth";
import { OwnerCode } from "./OwnerCode";
import { paperTime, paperWords } from "./policy";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The entry pause with its start and owner reason; each part the owner did not publish is named, never left blank. */
export function EntryPauseBanner({ decisions, riskPaused = false, now, compact = false }: { decisions?: PaperRead; riskPaused?: boolean; now: number; compact?: boolean }) {
  const pause = entryPause(decisions, now, riskPaused);
  if (!pause) return null;
  const text = entryPauseText(pause, now);
  const asOf = typeof decisions?.generated_at_ms === "number" ? ` · decisions read ${paperTime(decisions.generated_at_ms, now)}` : "";
  return <aside className={compact ? "paper-entry-pause v5m-hint" : "paper-entry-pause paper-fleet"} role="status" data-state="degraded" aria-label="Entry pause">
    <p><strong>{text.lead}{text.reasons.length ? ": " : "."}</strong>{text.reasons.map((reason, index) => <span key={reason}>{index ? "; " : ""}<OwnerCode code={reason} /></span>)}{text.reasons.length ? "." : ""}</p>
    {text.missing && <p className="paper-caption">{text.missing}.</p>}
    <p className="paper-caption">Protective exits keep running while entries are paused · owner report{asOf}</p>
  </aside>;
}

/** The newest fill per pair among the rows the owner published, with its time and age. */
export function LastFillPerPair({ read, pairs, now }: { read?: PaperRead; pairs: readonly string[]; now: number }) {
  const last = lastFillPerPair(read, pairs, now);
  if (!last) return null;
  return <section className="paper-section paper-last-fills" aria-label="Last fill per pair">
    <h3>Last fill per pair</h3>
    <ul>{last.rows.map(row => <li key={row.pair}><strong>{row.pair.split("-")[0]}</strong>{": "}{row.at !== null ? <>{paperWords(row.side)} · {paperTime(row.at, now)}</> : row.rows ? `${plural(row.rows, "fill", "fills")} recorded, none with a qualified time` : last.complete ? "no fill in the owner's records" : "no fill among the retained rows"}</li>)}</ul>
    <p className="paper-caption">{last.complete ? "Newest fill of every owner record." : "Newest fill among the retained rows only; older fills are not in this window."}</p>
  </section>;
}
