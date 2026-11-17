import { createContext, useContext, type ReactNode } from 'react';
import { TileGrid } from '../features/quant-ops/kit/grid';

export interface EvidenceRef {
  owner: string; record_kind: string; record_id: string; revision: string;
  content_sha256: string; available_at_ms: number;
}
const utc = (value: number | undefined) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Unknown';
const SyntheticClock = createContext(false);

export function ProjectionClock({ status, sourceGeneration, children }: { status?: string; sourceGeneration?: string; children: ReactNode }) {
  return <SyntheticClock.Provider value={status === 'FIXTURE_ONLY' || sourceGeneration?.startsWith('fixture-') === true}>{children}</SyntheticClock.Provider>;
}

export function UtcTime({ value }: { value?: number }) {
  const synthetic = useContext(SyntheticClock);
  const formatted = utc(value);
  return formatted === 'Unknown' ? <span>Unknown</span> : <span><time dateTime={new Date(value!).toISOString()}>{formatted}</time>{synthetic && <small className="block text-[var(--color-text-muted)]">Synthetic fixture clock</small>}</span>;
}

export function ProjectionNotice({ status, reason, generatedAt, error }: { status?: string; reason?: string; generatedAt?: number; error?: string }) {
  return <div className="v5-panel mb-4" role={error ? 'alert' : 'status'}>
    <strong>{error ? 'Read error' : status === 'STALE' ? 'Stale owner snapshot' : status === 'FIXTURE_ONLY' ? 'Synthetic fixtures · not production evidence' : 'Owner evidence unavailable'}</strong>
    <p>{error ?? reason ?? 'Reports only. Effect: NONE. No model call or execution permission.'}</p>
    <p className="text-xs text-[var(--color-text-muted)]">Owner snapshot: <UtcTime value={generatedAt} /> · Readiness: disabled · Native execution: unknown</p>
  </div>;
}

export function EvidenceList({ refs, empty = 'None reported by owner' }: { refs: EvidenceRef[]; empty?: string }) {
  if (!refs.length) return <span>{empty}</span>;
  const evidence = <ul className="space-y-2">{refs.map(reference => <li key={`${reference.record_id}:${reference.revision}`} className="break-all">
    <strong>{reference.record_id}</strong> · {reference.record_kind.replaceAll('_', ' ')} · {reference.owner}<br />
    Revision {reference.revision} · <UtcTime value={reference.available_at_ms} /><br />
    <span className="text-xs text-[var(--color-text-muted)]">SHA256 <code className="font-mono select-text">{reference.content_sha256}</code></span>
  </li>)}</ul>;
  return <div><span className="block truncate" title={refs[0].record_id}>{refs[0].record_id}</span><details><summary>Inspect {refs.length} evidence {refs.length === 1 ? 'reference' : 'references'}</summary>{evidence}</details></div>;
}

export function MetricTiles({ items }: { items: { label: string; value: string | number }[] }) {
  return <TileGrid label="Owner summary" min={170}>{items.map(item => <div key={item.label} className="v5-panel h-full"><span className="text-xs text-[var(--color-text-muted)]">{item.label}</span><p className="text-xl font-semibold break-words">{item.value}</p></div>)}</TileGrid>;
}

import { isUnavailableStub, useProjectionPages } from './learning-projection';
import type { LessonRow, ProjectionEnvelope, ProjectionPagesView, Ref, UnavailableRowStub } from './learning-projection';
import { CopyableHash, IssueList, ProjectionStatusBanner, RefList, SourceRefList, UtcTime as OwnerUtcTime } from './projection-ui';

export function ScopedRefs({ refs }: { refs: Ref[] }) {
  const scoped = refs.filter(ref => ref.resolution !== 'OUT_OF_SCOPE');
  const opaque = refs.filter(ref => ref.resolution === 'OUT_OF_SCOPE');
  return <div className="min-w-0"><RefList refs={scoped} empty="No in-scope references reported" />{opaque.map((ref, index) => <p key={`${ref.record_id}:${index}`} className="break-all">Unresolved reference: <code className="select-text">{ref.record_id}</code></p>)}</div>;
}

export function RecordedWindow({ row }: { row: LessonRow | UnavailableRowStub }) {
  const scope = row.row_scope.recorded_scope;
  return <p>Recorded scope: {scope?.venue ?? 'Unknown'} · {scope?.capital_model ?? 'Unknown'} · window {scope?.window ? <><OwnerUtcTime value={scope.window.start} /> to <OwnerUtcTime value={scope.window.end_exclusive} /> (exclusive)</> : 'Unknown'}</p>;
}

export function LearningPanel({ view, data }: { view?: ProjectionPagesView<'lessons'>; data?: ProjectionEnvelope<LessonRow | UnavailableRowStub> }) {
  const envelope = view ? (view.state === 'ready' ? view.envelope : null) : data ?? null;
  const rows = envelope && envelope.status !== 'UNAVAILABLE' ? envelope.items : [];
  return <div className="space-y-4 min-w-0">
    <div className="v5-page-heading"><div><h1>Learning</h1><p>Historical recorded lessons; not a research verdict.</p><p>Recall: not evaluated</p></div></div>
    <ProjectionStatusBanner state={view?.state ?? (envelope ? 'ready' : 'unavailable')} envelope={envelope} error={view?.error} onFirst={view?.first} />
    {rows.map(row => <article key={row.record_id} className="v5-panel min-w-0 break-words">
      <h2>{isUnavailableStub(row) ? 'Recorded lesson unavailable' : row.title}</h2>
      <p className="break-all">Record: <code className="select-text">{row.record_id}</code></p>
      <p>Recorded: <OwnerUtcTime value={row.recorded_at_ms} /> · Available: <OwnerUtcTime value={row.available_at_ms} /></p>
      <RecordedWindow row={row} /><IssueList issues={row.issues} />
      {!isUnavailableStub(row) && <><p>{row.statement}</p><p>Domain: {row.domain} · Confidence: {row.confidence} · Evidence: {row.evidence_state}</p>
        <p>Reopening condition: {row.reopening_condition}</p><p>Contradiction state: {row.contradiction_state}</p>
        <h3>Evidence references</h3><ScopedRefs refs={[...row.outcome_refs, ...row.contradictory_refs]} />
        <h3>Supersession</h3>{row.supersedes ? <ScopedRefs refs={[row.supersedes]} /> : <p>Not recorded</p>}</>}
      <h3>Source receipts</h3><SourceRefList sources={row.sources} /><p>Row hash: <CopyableHash value={row.row_sha256} label="row hash" /></p>
    </article>)}
    {view && <nav aria-label="Lesson pages" className="flex flex-wrap gap-3"><button type="button" onClick={view.first} disabled={!view.hasPrevious && !view.snapshotChanged}>First</button><button type="button" onClick={view.previous} disabled={!view.hasPrevious}>Previous</button><button type="button" onClick={view.next} disabled={!view.hasNext}>Next</button></nav>}
  </div>;
}

export function LearningPage() {
  const view = useProjectionPages('lessons', { limit: 25 });
  return <LearningPanel view={view} />;
}
