import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { PaperRead } from "./contracts";

export function usePaperSnapshot<Result>(queryKey: QueryKey, enabled: boolean, total: number, load: (progress: (reads: PaperRead[]) => void, signal: AbortSignal) => Promise<Result>) {
  const key = JSON.stringify(queryKey);
  const attempt = useRef<symbol | null>(null);
  const [progress, setProgress] = useState<{key: string; signal: AbortSignal; reads: PaperRead[]} | null>(null);
  const query = useQuery({queryKey, enabled, retry:false, refetchInterval:15_000, queryFn:({signal}) => {
    const token = Symbol();
    attempt.current = token;
    return load(reads => {
      if (attempt.current === token && !signal.aborted) setProgress({key, signal, reads});
    }, signal);
  }});
  const reads = progress?.key === key && !progress.signal.aborted ? progress.reads : [];
  const complete = query.data !== undefined;
  return {...query, complete, reads, progress:query.isFetching ? `${complete ? "Refreshing" : "Checking"}: ${reads.length}/${total} sections` : undefined};
}
