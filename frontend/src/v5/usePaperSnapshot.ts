import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useRef, useState, useSyncExternalStore } from "react";
import type { PaperRead } from "./contracts";
import { paperSafetyBeyondDisplayed, paperSafetyReads } from "./paper-safety";
import { PaperSafetyStore } from "./paper-safety-store";
import { paperSnapshotsAgree } from "./policy";
import { paperJournalReads } from './paper-journal';

const safetyByClient = new WeakMap<object, Map<string, PaperSafetyStore>>();
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

export function usePaperSnapshot<Result>(queryKey: QueryKey, enabled: boolean, total: number, load: (progress: (reads: PaperRead[]) => void, signal: AbortSignal) => Promise<Result>, refetchInterval: number | false = 15_000) {
  const key = JSON.stringify(queryKey);
  const client = useQueryClient();
  let stores = safetyByClient.get(client);
  if (!stores) { stores = new Map(); safetyByClient.set(client, stores); }
  const bot = queryKey[queryKey.length - 1];
  const botKey = typeof bot === 'string' ? bot : '';
  let safety = stores.get(botKey);
  if (!safety) { safety = new PaperSafetyStore(); stores.set(botKey, safety); }
  const safetyStore = safety;
  const safetyReads = useSyncExternalStore(safetyStore.subscribe, safetyStore.snapshot, safetyStore.snapshot);
  const attempt = useRef<symbol | null>(null);
  const [progress, setProgress] = useState<{key: string; signal: AbortSignal; reads: PaperRead[]} | null>(null);
  const query = useQuery({queryKey, enabled, retry:false, refetchInterval, queryFn:({signal}) => {
    const token = Symbol();
    attempt.current = token;
    return load(reads => {
      if (attempt.current === token && !signal.aborted) {
        const ownerQuery = client.getQueryCache().find({queryKey, exact:true});
        if (ownerQuery) {
          const completed = ownerQuery.state.data;
          safetyStore.receive(reads.filter(read => read.bot_id === botKey));
          const journal = journalByQuery.get(ownerQuery);
          journalByQuery.set(ownerQuery, {reads:paperJournalReads(journal?.reads ?? [], reads,
            journal?.completed !== completed ? journalCompletion(completed, total) : undefined), completed});
        }
        setProgress({key, signal, reads});
      }
    }, signal).then(result => {
      if (attempt.current === token && !signal.aborted) {
        const completed = completionSnapshot(result);
        if (completed?.bot_id === botKey) safetyStore.receive((result as PaperRead[]).filter(read => read.bot_id === botKey), completed);
      }
      return result;
    });
  }});
  const reads = progress?.key === key && !progress.signal.aborted ? progress.reads : [];
  const effectiveSafety = safetyStore.reconcile(paperSafetyReads(safetyReads, reads.filter(read => read.bot_id === botKey)));
  const complete = query.data !== undefined;
  const ownerQuery = client.getQueryCache().find({queryKey, exact:true});
  const journal = ownerQuery ? journalByQuery.get(ownerQuery) : undefined;
  const journalReads = paperJournalReads(journal?.reads ?? [], reads,
    journal?.completed !== query.data ? journalCompletion(query.data, total) : undefined);
  if (ownerQuery) journalByQuery.set(ownerQuery, {reads:journalReads, completed:query.data});
  // Retained evidence may repeat what the displayed snapshot already shows (same snapshot as new objects, or the next
  // snapshot during a refresh). Hand the view only evidence that adds a signal; the retention store is unchanged.
  const displayedSafety = paperSafetyBeyondDisplayed(effectiveSafety, safetyStore.reconcile(Array.isArray(query.data) ? query.data as PaperRead[] : reads));
  return {...query, complete, reads, safetyReads:displayedSafety, safetyEvidence:effectiveSafety, reconcileSafety:safetyStore.reconcile, restartOrderUnknown:safetyStore.restartOrderUnknown, journalReads, progress:query.isFetching ? `${complete ? "Refreshing" : "Checking"}: ${reads.length}/${total} sections` : undefined};
}
