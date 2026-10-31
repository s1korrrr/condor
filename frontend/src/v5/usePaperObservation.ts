import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { PaperRead } from "./contracts";
import { paperBoundedRead, paperCoherentRead, paperObservationSummary, paperSectionError } from "./policy";

async function readPaperSection(path: string, section: string, bot?: string | null) {
  const response = await fetch(`/api/v5/dashboard/read?${new URLSearchParams({ path })}`, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(14_000) });
  if (!response.ok) throw Object.assign(new Error(`${section === "status" ? "Identity" : section} owner read unavailable. Check the retained observation diagnostics.`), { status: response.status });
  const value = await response.json() as PaperRead;
  if (!value || value.section !== section || (bot && value.bot_id !== bot) || paperSectionError(value)) throw new Error(`${section} owner read failed validation. No current observation is inferred.`);
  return value;
}

export function usePaperWorkspace(page: "capital" | "operations", bot?: string | null) {
  const [progress, setProgress] = useState<{bot: string | null | undefined; reads: PaperRead[]} | null>(null);
  const query = useQuery({ queryKey: ["v5-paper-workspace", page, bot], enabled: Boolean(bot), retry: false, refetchInterval: 15_000, queryFn: async () => {
    if (page === "operations") return paperBoundedRead(async () => {
      const response = await fetch("/api/v5/dashboard/read?" + new URLSearchParams({path:"/api/v1/operations/workspace"}), {credentials:"include", cache:"no-store", signal:AbortSignal.timeout(14_000)});
      if (!response.ok) throw Object.assign(new Error("Paper operations owner read unavailable."), {status:response.status});
      return response.json();
    });
    const prefix = "/api/v1/servers/rsibot-v5/";
    const reads = await paperCoherentRead(`${prefix}bots/${encodeURIComponent(bot!)}/native/status`, [
      {section:"wallet",path:`${prefix}account-balances`},
      {section:"history",path:`${prefix}controller-performance/history?limit=200`,paginate:true},
      {section:"accounting",path:`${prefix}fleet/accounting`},
    ], (path,section) => readPaperSection(path,section,bot), undefined, reads => setProgress({bot, reads}));
    return {...reads[1], history_read:reads[2], accounting_read:reads[3]};
  }});
  const reads = progress && progress.bot === bot ? progress.reads : [];
  const wallet = reads.find(read => read.section === "wallet");
  const partial = wallet ? {...wallet, history_read:reads.find(read => read.section === "history"), accounting_read:reads.find(read => read.section === "accounting")} : null;
  const complete = !query.isFetching && !query.isPending && !query.isError;
  return {data:query.isError ? null : page === "capital" && !complete ? partial : query.data ?? null, complete, progress:page === "capital" && !complete ? `Reading one owner snapshot: ${reads.length}/4 sections. Totals are withheld until the read completes.` : undefined, error:query.isError ? query.error.message : null, pending:query.isPending || query.isFetching, refresh:() => {void query.refetch();}};
}

export function usePaperObservation(bot: string | null | undefined) {
  const [progress, setProgress] = useState<{bot: string | null | undefined; reads: PaperRead[]} | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const query = useQuery({ queryKey: ["v5-paper-observation-health", bot], enabled: Boolean(bot), retry: false, refetchInterval: 15_000, queryFn: async () => {
    const prefix = "/api/v1/servers/rsibot-v5/";
    return paperCoherentRead(`${prefix}bots/${encodeURIComponent(bot!)}/native/status`, [
      {section:"wallet",path:`${prefix}account-balances`},
      {section:"positions",path:`${prefix}fleet/holdings`,paginate:true},
      {section:"executors",path:`${prefix}bots/${encodeURIComponent(bot!)}/executors`,paginate:true},
      {section:"risk",path:`${prefix}bots/${encodeURIComponent(bot!)}/risk`},
    ], (path,section) => readPaperSection(path,section,bot), undefined, reads => setProgress({bot, reads}));
  } });
  const reads = progress && progress.bot === bot ? progress.reads : [];
  const summary = query.isError ? { label: "Unavailable", reason: query.error.message } : query.isPending || query.isFetching ? { label: "Checking", reason: `Reading one owner snapshot: ${reads.length}/5 sections. Process heartbeat is a separate signal.` } : paperObservationSummary(query.data ?? [], bot ?? "", now);
  return { ...query, summary, status: query.isError ? undefined : (query.isFetching ? reads : query.data)?.find(read => read.section === "status") };
}
