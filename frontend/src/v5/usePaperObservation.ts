import type { PaperRead } from "./contracts";
import { paperBoundedRead, paperCoherentRead, paperObservationSummary, paperSectionError } from "./policy";
import { usePaperSnapshot } from "./usePaperSnapshot";
import { paperSnapshotPresentation } from "./snapshot-presentation";
import { usePaperClock } from "./usePaperClock";
import { parsePaperReadText } from "./paper-json";

async function readPaperSection(path: string, section: string, bot: string | null | undefined, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch(`/api/v5/dashboard/read?${new URLSearchParams({ path })}`, { credentials: "include", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(14_000)]) });
  if (!response.ok) throw Object.assign(new Error(`${section === "status" ? "Identity" : section} owner read unavailable. Check the retained observation diagnostics.`), { status: response.status });
  const value = parsePaperReadText(await response.text()) as PaperRead;
  signal.throwIfAborted();
  if (!value || value.section !== section || (bot && value.bot_id !== bot) || paperSectionError(value)) throw new Error(`${section} owner read failed validation. No current observation is inferred.`);
  return value;
}

export function usePaperWorkspace(page: "capital" | "operations", bot?: string | null) {
  const query = usePaperSnapshot<PaperRead & {history_read?: PaperRead; accounting_read?: PaperRead}>(["v5-paper-workspace", page, bot], Boolean(bot), page === "capital" ? 4 : 1, async (progress, signal) => {
    if (page === "operations") return paperBoundedRead(async () => {
      signal.throwIfAborted();
      const response = await fetch("/api/v5/dashboard/read?" + new URLSearchParams({path:"/api/v1/operations/workspace"}), {credentials:"include", cache:"no-store", signal:AbortSignal.any([signal, AbortSignal.timeout(14_000)])});
      if (!response.ok) throw Object.assign(new Error("Paper operations owner read unavailable."), {status:response.status});
      return response.json();
    });
    const prefix = "/api/v1/servers/rsibot-v5/";
    const reads = await paperCoherentRead(`${prefix}bots/${encodeURIComponent(bot!)}/native/status`, [
      {section:"wallet",path:`${prefix}account-balances`},
      {section:"history",path:`${prefix}controller-performance/history?limit=200`,paginate:true},
      {section:"accounting",path:`${prefix}fleet/accounting`},
    ], (path,section) => readPaperSection(path,section,bot,signal), undefined, progress);
    return {...reads[1], history_read:reads[2], accounting_read:reads[3]};
  });
  const reads = query.reads;
  const wallet = reads.find(read => read.section === "wallet");
  const partial = wallet ? {...wallet, history_read:reads.find(read => read.section === "history"), accounting_read:reads.find(read => read.section === "accounting")} : null;
  return {data:query.data ?? (query.isError ? null : partial), complete:query.complete, progress:page === "capital" ? query.progress : undefined, error:query.isError ? query.error.message : null, pending:query.isPending || query.isFetching, refresh:() => {void query.refetch();}};
}

export function usePaperObservation(bot: string | null | undefined) {
  const now = usePaperClock();
  const query = usePaperSnapshot<PaperRead[]>(["v5-paper-observation-health", bot], Boolean(bot), 5, async (progress, signal) => {
    const prefix = "/api/v1/servers/rsibot-v5/";
    return paperCoherentRead(`${prefix}bots/${encodeURIComponent(bot!)}/native/status`, [
      {section:"wallet",path:`${prefix}account-balances`},
      {section:"positions",path:`${prefix}fleet/holdings`,paginate:true},
      {section:"executors",path:`${prefix}bots/${encodeURIComponent(bot!)}/executors`,paginate:true},
      {section:"risk",path:`${prefix}bots/${encodeURIComponent(bot!)}/risk`},
    ], (path,section) => readPaperSection(path,section,bot,signal), undefined, progress);
  });
  const reads = query.reads;
  const summary = query.isError ? { label: "Unavailable", reason: query.error.message } : query.isPending || query.isFetching ? { label: "Checking", reason: `Reading one owner snapshot: ${reads.length}/5 sections. Process heartbeat is a separate signal.` } : paperObservationSummary(query.data ?? [], bot ?? "", now);
  const status = (query.data ?? reads).find(read => read.section === "status");
  const snapshot = query.complete ? paperSnapshotPresentation(status?.generated_at_ms, now, query.isFetching || query.isError) : null;
  return { ...query, summary, status, snapshot };
}
