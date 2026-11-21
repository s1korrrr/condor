import type { PaperRead } from "./contracts";
import { parsePaperReadText } from "./paper-json";
import { paperReadFailureMessage, paperSectionAdmissionError } from "./policy";

/** One owner `decisions` read for the Overview pause banner: the same path and admission checks as the Bots page. */
export async function readPaperDecisions(bot: string, signal: AbortSignal): Promise<PaperRead> {
  const path = `/api/v1/servers/rsibot-v5/bots/${encodeURIComponent(bot)}/decisions`;
  const response = await fetch(`/api/v5/dashboard/read?${new URLSearchParams({ path })}`, { credentials: "include", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(14_000)]) });
  if (!response.ok) throw new Error(paperReadFailureMessage(response.status, await response.json().catch(() => null)));
  const value = parsePaperReadText(await response.text()) as PaperRead;
  if (!value || value.section !== "decisions" || paperSectionAdmissionError(value)) throw new Error("Decisions owner schema invalid; this section is unavailable.");
  return value;
}
