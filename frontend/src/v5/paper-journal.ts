import type { PaperRead } from './contracts';
import { newerSnapshot } from './paper-safety.ts';
import { paperSectionError } from './policy.ts';

const states = ['exceeded', 'segment_capacity', 'inventory_unavailable'];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function paperJournalCondition(read?: PaperRead) {
  const data = record(read?.data), budget = record(data.journal_budget), operations = record(data.operations);
  const diagnostic = [operations.reason, operations.stale_reason].find(reason => typeof reason === 'string' && states.some(state => reason === `observation_journal_${state}`));
  const named = states.find(state => read?.reason === `OWNER_JOURNAL_${state.toUpperCase()}`);
  const state = named ?? states.find(state => state === budget.state) ?? states.find(state => diagnostic === `observation_journal_${state}`) ?? null;
  return state || budget.journal_evidence_held === true ? {state, budget, diagnostic:typeof diagnostic === 'string' ? diagnostic : null} : null;
}

function clearsJournal(read: PaperRead) {
  const operations = record(record(read.data).operations);
  return read.section === 'status' && ['available', 'degraded'].includes(read.state) && read.completeness === 'complete' && !read.next_cursor && !paperSectionError(read) && !paperJournalCondition(read) &&
    operations.completeness === 'complete' && operations.state === 'available' && operations.reason == null && operations.stale_reason == null;
}

export function paperJournalReads(previous: PaperRead[], received: PaperRead[], complete?: PaperRead): PaperRead[] {
  const retained = new Map<string, PaperRead>();
  for (const read of previous) {
    if (!complete || read.bot_id !== complete.bot_id || !clearsJournal(complete) || !newerSnapshot(complete, read)) retained.set(read.bot_id!, read);
  }
  for (const read of [...(complete ? [complete] : []), ...received]) {
    if (read.section !== 'status' || !read.bot_id || paperSectionError(read) || !paperJournalCondition(read)) continue;
    const prior = retained.get(read.bot_id);
    if (!prior || newerSnapshot(read, prior)) retained.set(read.bot_id, read);
  }
  return [...retained.values()];
}
