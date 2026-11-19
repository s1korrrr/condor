import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { PaperRead } from "./contracts";
import { paperSafetyBeyondDisplayed, paperSafetyReads } from "./paper-safety";
import { paperSectionError, paperSnapshotsAgree } from "./policy";
import { paperJournalReads } from './paper-journal';

const safetyByQuery = new WeakMap<object, {reads: PaperRead[]; completed: unknown}>();
const journalByScope = new WeakMap<object, PaperRead[]>();
const journalCompletedByQuery = new WeakMap<object, unknown>();
const journalProgressByQuery = new WeakMap<object, PaperRead>();
const noReads: PaperRead[] = [];

function journalCompletion(data: unknown, total: number): PaperRead | undefined {
  if (!Array.isArray(data) || data.length !== total || !paperSnapshotsAgree(data)) return undefined;
  // A coherent read can include degraded placeholders or a deliberately bounded history page.
  // Only valid owner responses in usable states can supersede retained journal evidence.
  if (data.some(read => !['available', 'not_applicable'].includes(read.state) || paperSectionError(read))) return undefined;
  return data.find(read => read.section === 'status');
}

function readJournal(query: object, scope: object, data: unknown, total: number, progress = noReads) {
  const previous = journalByScope.get(scope) ?? noReads;
  const completed = journalCompletedByQuery.get(query) !== data;
  const status = progress.find(read => read.section === 'status');
  const received = status && journalProgressByQuery.get(query) !== status ? status : undefined;
  if (!completed && !received) return previous;
  const committedStatus = completed && Array.isArray(data) ? data.find(read => read.section === 'status') as PaperRead | undefined : undefined;
  const observations = [committedStatus, received].filter((read): read is PaperRead => read !== undefined);
  const retained = paperJournalReads(previous, observations, committedStatus ? journalCompletion(data, total) : undefined);
  journalCompletedByQuery.set(query, data);
  if (received) journalProgressByQuery.set(query, received);
  journalByScope.set(scope, retained);
  return retained;
}

function completionSnapshot(data: unknown): PaperRead | undefined {
  if (!Array.isArray(data)) return undefined;
  const status = data.find(read => read.section === 'status');
  const risk = data.find(read => read.section === 'risk');
  return status && risk && status.bot_id === risk.bot_id && paperSnapshotsAgree([status, risk]) ? risk as PaperRead : undefined;
}

export function usePaperSnapshot<Result>(queryKey: QueryKey, enabled: boolean, total: number, load: (progress: (reads: PaperRead[]) => void, signal: AbortSignal) => Promise<Result>, refetchInterval: number | false = 20_000, options?: { journalAcrossRoutes: boolean }) {
  const key = JSON.stringify(queryKey);
  const client = useQueryClient();
  const attempt = useRef<symbol | null>(null);
  const [progress, setProgress] = useState<{key: string; signal: AbortSignal; reads: PaperRead[]} | null>(null);
  // The profile query lives across routes and is removed with the signed-in cache.
  const profile = options?.journalAcrossRoutes ? client.getQueryCache().find({queryKey:['v5-profile'], exact:true}) : undefined;
  const query = useQuery<Result>({
    queryKey, enabled, retry:false,
    // Keep the validated immutable section identities returned by the loader.
    structuralSharing:false,
    refetchInterval: owner => owner.state.fetchStatus === 'idle' ? refetchInterval : false,
    queryFn: ({signal}) => {
      const token = Symbol();
      attempt.current = token;
      return load(reads => {
        if (attempt.current !== token || signal.aborted) return;
        const ownerQuery = client.getQueryCache().find({queryKey, exact:true});
        if (ownerQuery) {
          const previous = safetyByQuery.get(ownerQuery);
          const completed = ownerQuery.state.data;
          const retained = paperSafetyReads(previous?.reads ?? [], [], previous?.completed !== completed ? completionSnapshot(completed) : undefined);
          safetyByQuery.set(ownerQuery, {reads:paperSafetyReads(retained, reads), completed});
          readJournal(ownerQuery, profile ?? ownerQuery, completed, total, reads);
        }
        setProgress({key, signal, reads});
      }, signal);
    },
  });
  const reads = progress?.key === key && !progress.signal.aborted ? progress.reads : [];
  const complete = query.data !== undefined;
  const ownerQuery = client.getQueryCache().find({queryKey, exact:true});
  const previous = ownerQuery ? safetyByQuery.get(ownerQuery) : undefined;
  const safetyReads = paperSafetyReads(previous?.reads ?? [], reads, previous?.completed !== query.data ? completionSnapshot(query.data) : undefined);
  if (ownerQuery) safetyByQuery.set(ownerQuery, {reads:safetyReads, completed:query.data});
  const journalReads = ownerQuery ? readJournal(ownerQuery, profile ?? ownerQuery, query.data, total, reads) : noReads;
  // Retained evidence may repeat what the displayed snapshot already shows (same snapshot as new objects, or the next
  // snapshot during a refresh). Hand the view only evidence that adds a signal; the retention store is unchanged.
  const displayedSafety = paperSafetyBeyondDisplayed(safetyReads, Array.isArray(query.data) ? query.data as PaperRead[] : reads);
  return {...query, refetch: () => query.refetch({cancelRefetch:false}), complete, reads, safetyReads:displayedSafety, journalReads, progress:query.isFetching ? `${complete ? "Refreshing" : "Checking"}: ${reads.length}/${total} sections` : undefined};
}
