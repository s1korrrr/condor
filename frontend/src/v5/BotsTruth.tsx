import type { PaperRead } from "./contracts";
import "./bots-truth.css";
import { entryPause, entryPauseText, lastFillPerPair } from "./bots-truth";
import { OwnerCode } from "./OwnerCode";
import { paperTime, paperWords } from "./policy";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function EntryPauseBanner({ decisions, riskPaused = false, now, compact = false, retained = false, failure }: { decisions?: PaperRead; riskPaused?: boolean; now: number; compact?: boolean; retained?: boolean; failure?: { at: number; message: string; lastSuccessfulAt: number } }) {
  const caption = compact ? "v5m-hint" : "paper-caption";
  if (failure) return <p className={caption} role="alert" aria-label="Entry pause">
    Latest read failed at {paperTime(failure.at, now)} ({failure.message}) · {failure.lastSuccessfulAt ? `last successful read ${paperTime(failure.lastSuccessfulAt, now)}` : "never read"}
  </p>;
  const pause = entryPause(decisions, now, riskPaused, retained);
  const readTime = paperTime(decisions?.generated_at_ms, now);
  const lastRead = readTime === "Not published" ? "time not published" : readTime;
  if (pause.state !== "paused") return <p className={caption} role="status" aria-label="Entry pause">
    {pause.state === "not-paused" ? "Not paused" : "Pause state not current"} · {decisions ? `read ${lastRead}` : "never read"}{pause.state === "unknown" && pause.unknown !== null ? ` · ${pause.unknown} unknown` : ""}
  </p>;
  const text = entryPauseText(pause, now);
  return <aside className={compact ? "paper-entry-pause v5m-hint" : "paper-entry-pause paper-fleet"} role="status" data-state="degraded" aria-label="Entry pause">
    <p><strong>{text.lead}{text.reasons.length ? ": " : "."}</strong>{text.reasons.map((reason, index) => <span key={reason}>{index ? "; " : ""}<OwnerCode code={reason} /></span>)}{text.reasons.length ? "." : ""}</p>
    {text.missing && <p className="paper-caption">{text.missing}.</p>}
    <p className="paper-caption">{pause.unread ? `Owner risk report · ${decisions ? `last decisions read ${lastRead}` : "decisions never read"}` : `Owner decisions report · last read ${lastRead}`}</p>
  </aside>;
}

/** The newest fill per pair among the rows the owner published, with its time and age. */
export function LastFillPerPair({ read, pairs, now, valuesAt = now }: { read?: PaperRead; pairs: readonly string[]; now: number; valuesAt?: number }) {
  const last = lastFillPerPair(read, pairs, now, valuesAt);
  if (!last) return null;
  const hasUndated = last.rows.some(row => row.undated);
  return <section className="paper-section paper-last-fills" aria-label="Last fill per pair">
    <h3>Last fill per pair</h3>
    <ul>{last.rows.map(row => <li key={row.pair}><strong>{row.pair.split("-")[0]}</strong>{": "}{row.at !== null ? <>{paperWords(row.side)} · {paperTime(row.at, now)}{row.undated ? ` · newest dated fill · ${row.undated} undated` : ""}</> : row.rows ? `${plural(row.rows, "fill", "fills")} recorded, none with a qualified time` : last.complete ? "no fill in the owner's records" : "no fill among the retained rows"}</li>)}</ul>
    <p className="paper-caption">{last.complete ? (hasUndated ? "Newest dated fill among the owner records." : "Newest fill of every owner record.") : `${hasUndated ? "Newest dated fill" : "Newest fill"} among the retained rows only; older fills are not in this window.`}</p>
  </section>;
}
