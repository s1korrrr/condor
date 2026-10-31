import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { PaperRead } from "./contracts";
import { paperSafetyReads } from "./paper-safety";

const safetyByQuery = new WeakMap<object, {reads: PaperRead[]; completed: unknown}>();

function completionSnapshot(data: unknown): PaperRead | undefined {
  const status = Array.isArray(data) ? data.find(read => read.section === 'status') : data;
  return status && typeof status === 'object' && 'bot_id' in status && 'generated_at_ms' in status ? status as PaperRead : undefined;
}

export function usePaperSnapshot<Result>(queryKey: QueryKey, enabled: boolean, total: number, load: (progress: (reads: PaperRead[]) => void, signal: AbortSignal) => Promise<Result>) {
  const key = JSON.stringify(queryKey);
  const client = useQueryClient();
  const attempt = useRef<symbol | null>(null);
  const [progress, setProgress] = useState<{key: string; signal: AbortSignal; reads: PaperRead[]} | null>(null);
  const query = useQuery({queryKey, enabled, retry:false, refetchInterval:15_000, queryFn:({signal}) => {
    const token = Symbol();
    attempt.current = token;
    return load(reads => {
      if (attempt.current === token && !signal.aborted) {
        const ownerQuery = client.getQueryCache().find({queryKey, exact:true});
        if (ownerQuery) {
          const previous = safetyByQuery.get(ownerQuery);
          const completed = ownerQuery.state.data;
          const retained = paperSafetyReads(previous?.reads ?? [], [], previous?.completed !== completed ? completionSnapshot(completed) : undefined);
          safetyByQuery.set(ownerQuery, {reads:paperSafetyReads(retained, reads), completed});
        }
        setProgress({key, signal, reads});
      }
    }, signal);
  }});
  const reads = progress?.key === key && !progress.signal.aborted ? progress.reads : [];
  const complete = query.data !== undefined;
  const ownerQuery = client.getQueryCache().find({queryKey, exact:true});
  const previous = ownerQuery ? safetyByQuery.get(ownerQuery) : undefined;
  const safetyReads = paperSafetyReads(previous?.reads ?? [], reads, previous?.completed !== query.data ? completionSnapshot(query.data) : undefined);
  if (ownerQuery) safetyByQuery.set(ownerQuery, {reads:safetyReads, completed:query.data});
  return {...query, complete, reads, safetyReads, progress:query.isFetching ? `${complete ? "Refreshing" : "Checking"}: ${reads.length}/${total} sections` : undefined};
}
