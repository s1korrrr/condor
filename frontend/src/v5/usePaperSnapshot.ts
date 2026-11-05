import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { PaperRead } from "./contracts";
import { paperSafetyReads } from "./paper-safety";
import { paperSnapshotsAgree } from "./policy";
import { paperJournalReads } from './paper-journal';

const safetyByQuery = new WeakMap<object, {reads: PaperRead[]; completed: unknown}>();
const journalByQuery = new WeakMap<object, {reads: PaperRead[]; completed: unknown}>();

function journalCompletion(data: unknown, total: number): PaperRead | undefined {
  if (!Array.isArray(data) || data.length !== total || !paperSnapshotsAgree(data)) return undefined;
  return data.find(read => read.section === 'status');
}

function completionSnapshot(data: unknown): PaperRead | undefined {
  if (!Array.isArray(data)) return undefined;
  const status = data.find(read => read.section === 'status');
  const risk = data.find(read => read.section === 'risk');
  return status && risk && status.bot_id === risk.bot_id && paperSnapshotsAgree([status, risk]) ? risk as PaperRead : undefined;
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
          const journal = journalByQuery.get(ownerQuery);
          journalByQuery.set(ownerQuery, {reads:paperJournalReads(journal?.reads ?? [], reads,
            journal?.completed !== completed ? journalCompletion(completed, total) : undefined), completed});
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
  const journal = ownerQuery ? journalByQuery.get(ownerQuery) : undefined;
  const journalReads = paperJournalReads(journal?.reads ?? [], reads,
    journal?.completed !== query.data ? journalCompletion(query.data, total) : undefined);
  if (ownerQuery) journalByQuery.set(ownerQuery, {reads:journalReads, completed:query.data});
  // Retained evidence holds the progress objects; the displayed snapshot is the (structurally shared) query data.
  // The same owner snapshot with the same content is one piece of evidence: hand consumers the displayed object, so an
  // identity merge cannot list it twice. Different snapshots or contents stay separate evidence.
  const shown = Array.isArray(query.data) ? query.data as PaperRead[] : reads;
  const sameEvidence = (left: PaperRead, right: PaperRead) => left.section === right.section && left.bot_id === right.bot_id
    && left.snapshot_id === right.snapshot_id && left.generated_at_ms === right.generated_at_ms && JSON.stringify(left.data) === JSON.stringify(right.data);
  const displayedSafety = [...new Set(safetyReads.map(read => shown.find(other => other === read || sameEvidence(other, read)) ?? read))];
  return {...query, complete, reads, safetyReads:displayedSafety, journalReads, progress:query.isFetching ? `${complete ? "Refreshing" : "Checking"}: ${reads.length}/${total} sections` : undefined};
}
