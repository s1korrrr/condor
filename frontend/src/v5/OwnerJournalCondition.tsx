import type { PaperRead } from './contracts';
import { usePaperObservation } from './usePaperObservation';

const reasons = ['OWNER_JOURNAL_EXCEEDED', 'OWNER_JOURNAL_SEGMENT_CAPACITY', 'OWNER_JOURNAL_INVENTORY_UNAVAILABLE'];
const states = ['exceeded', 'segment_capacity', 'inventory_unavailable'];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const condition = (value: unknown) => typeof value === 'boolean' ? String(value) : 'unavailable';

export function OwnerJournalCondition({ status, snapshotLabel }: { status?: PaperRead; snapshotLabel: string }) {
  const budget = record(record(status?.data).journal_budget);
  const state = typeof budget.state === 'string' && states.includes(budget.state) ? budget.state : null;
  if (!state && !reasons.includes(status?.reason ?? '') && budget.journal_evidence_held !== true) return null;
  const used = count(budget.post_transition_bytes), limit = count(budget.limit_bytes);
  const legacy = count(budget.legacy_segment_count), post = count(budget.post_transition_segment_count);
  const segmentLimit = count(budget.reader_segment_limit);
  return <section className="v5-panel" role="alert" aria-label="Owner journal evidence condition">
    <h2>Paper journal evidence held</h2>
    <p>{status?.reason ?? 'Owner journal condition'} · {state ?? 'Budget detail unavailable'}</p>
    <p>Owner status: {status?.state} · {snapshotLabel}</p>
    <p>journal_evidence_held: {condition(budget.journal_evidence_held)} · native_execution_continues: {condition(budget.native_execution_continues)}</p>
    <p>Post-transition growth: {used !== null && limit !== null ? `${used} / ${limit} bytes` : 'Unavailable'} · Active chain: {legacy !== null && post !== null && segmentLimit !== null ? `${legacy + post} / ${segmentLimit} segments` : 'Unavailable'}</p>
    <p>These are owner-reported conditions from this snapshot, not current execution or readiness proof. Evidence collection and native execution are separate. No dashboard action can archive evidence or activate trading.</p>
  </section>;
}

export function PaperJournalNotice({ bot }: { bot: string }) {
  const observation = usePaperObservation(bot);
  return <OwnerJournalCondition status={observation.status} snapshotLabel={observation.snapshot?.label ?? `${observation.summary.label}: ${observation.summary.reason}`} />;
}
