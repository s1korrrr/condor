import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { PaperRead } from "./contracts";
import { paperObservationSummary, paperSectionError } from "./policy";

export function usePaperObservation(bot: string | null | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const query = useQuery({ queryKey: ["v5-paper-observation-health", bot], enabled: Boolean(bot), retry: false, refetchInterval: 15_000, queryFn: async () => {
    async function read(path: string, section: string, snapshot?: string | null) {
      const response = await fetch(`/api/v5/dashboard/read?${new URLSearchParams({ path: path + (snapshot ? `?snapshot_id=${encodeURIComponent(snapshot)}` : "") })}`, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(14_000) });
      if (!response.ok) throw new Error(`${section === "status" ? "Identity" : section} owner read unavailable. Check the retained observation diagnostics.`);
      const value = await response.json() as PaperRead;
      if (!value || value.section !== section || value.bot_id !== bot || paperSectionError(value)) throw new Error(`${section} owner read failed validation. No current observation is inferred.`);
      return value;
    }
    const prefix = "/api/v1/servers/rsibot-v5/";
    const status = await read(`${prefix}bots/${encodeURIComponent(bot!)}/native/status`, "status");
    const sections = await Promise.all([read(`${prefix}account-balances`, "wallet", status.snapshot_id), read(`${prefix}fleet/holdings`, "positions", status.snapshot_id), read(`${prefix}bots/${encodeURIComponent(bot!)}/executors`, "executors", status.snapshot_id), read(`${prefix}bots/${encodeURIComponent(bot!)}/risk`, "risk", status.snapshot_id)]);
    return [status, ...sections];
  } });
  const summary = query.isError ? { label: "Unavailable", reason: query.error.message } : query.isPending ? { label: "Checking", reason: "Checking required paper owner reads; process heartbeat is a separate signal." } : paperObservationSummary(query.data ?? [], bot ?? "", now);
  return { ...query, summary, status: query.isError ? undefined : query.data?.find(read => read.section === "status") };
}
