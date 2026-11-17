import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
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
import type { LessonRow, ProjectionEnvelope, ProjectionPagesView, UnavailableRowStub } from './learning-projection';
import { ownerTitle } from './format.mjs';
import { CopyableHash, IssueList, ProjectionStatusBanner, RefList, SourceRefList, UtcTime as OwnerUtcTime } from './projection-ui';

export function ReferencePreview({ shown, total }: { shown: number; total: number | null }) {
  return <p>Reference preview: {shown} of {total === null ? 'unknown total shown; more may exist' : <><span title={ownerTitle(total) ?? undefined}>{total}</span> shown{shown < total ? '; more may exist' : ''}</>}</p>;
}

export function ReferencePreviewList({ refs, complete, empty }: Pick<ComponentProps<typeof RefList>, 'refs' | 'empty'> & { complete: boolean }) {
  return <RefList refs={refs} empty={empty ?? (complete ? 'None recorded' : 'No references in this preview; more may exist.')} />;
}

function PartialReasons({ codes }: { codes: string[] }) {
  return <>{codes.includes('CONTRADICTIONS_NOT_INDEXED') && <p>Counter-evidence not indexed; recall not evaluated.</p>}{codes.includes('OMITTED_CONTENT') && <p>Preview shortened or scope details omitted; full recorded content remains in the source.</p>}</>;
}

const contradictionText = {
  NOT_INDEXED: 'Contradictions not indexed: unknown, not none',
  RECORDED: 'Contradictions recorded',
  UNAVAILABLE: 'Contradictions unavailable: unknown, not none',
} as const;

export function RecordedWindow({ row }: { row: LessonRow | UnavailableRowStub }) {
  const scope = row.row_scope.recorded_scope;
  const window = scope?.window;
  return <p>Historical recorded scope: {scope?.venue ?? 'Unknown'} · {scope?.capital_model ?? 'Unknown'} · window {typeof window === 'string' ? window : window ? <><OwnerUtcTime value={window.start} /> to <OwnerUtcTime value={window.end_exclusive} /> (exclusive)</> : 'Unknown'} · recorded regimes: {scope?.regimes.length ? scope.regimes.join(', ') : 'Not recorded'}</p>;
}

function LessonReferences({ row }: { row: LessonRow }) {
  const { outcome_refs, contradictory_refs, supersedes, reference_total } = row;
  const shown = outcome_refs.length + contradictory_refs.length + (supersedes ? 1 : 0);
  const complete = shown === reference_total;
  return <>
    <ReferencePreview shown={shown} total={reference_total} />
    <h3>Outcomes</h3><ReferencePreviewList refs={outcome_refs} complete={complete} />
    <h3>Contradicting records</h3><ReferencePreviewList refs={contradictory_refs} complete={complete} empty={row.contradiction_state === 'RECORDED' ? undefined : 'No references in this preview; contradictions are not established as absent.'} />
    <h3>Supersession</h3>{supersedes ? <RefList refs={[supersedes]} /> : <p>{complete ? 'Not recorded' : 'Not shown; more references may exist.'}</p>}
  </>;
}

export function LearningPanel({ view, data }: { view?: ProjectionPagesView<'lessons'>; data?: ProjectionEnvelope<LessonRow | UnavailableRowStub> }) {
  const envelope = view ? view.envelope : data ?? null;
  const rows = (!view || view.state === 'ready') && envelope && envelope.status !== 'UNAVAILABLE' ? envelope.items : [];
  const bannerState = view?.state === 'unavailable' && envelope?.status === 'UNAVAILABLE' && !view.error ? 'ready' : view?.state ?? (envelope ? 'ready' : 'unavailable');
  return <div className="space-y-4 min-w-0">
    <div className="v5-page-heading"><div><h1>Learning</h1><p>Historical recorded lessons; not a research verdict.</p><p>Recall: not evaluated</p></div></div>
    <ProjectionStatusBanner state={bannerState} envelope={envelope} error={view?.error} onFirst={view?.first}><PartialReasons codes={envelope?.reason_codes ?? []} /></ProjectionStatusBanner>
    {rows.map(row => <article key={row.record_id} className="v5-panel min-w-0 break-words">
      <h2>{isUnavailableStub(row) ? 'Recorded lesson unavailable' : row.title}</h2>
      <p className="break-all">Record: <code className="select-text">{row.record_id}</code></p>
      <p>Recorded: <OwnerUtcTime value={row.recorded_at_ms} /> · Available: <OwnerUtcTime value={row.available_at_ms} /></p>
      <RecordedWindow row={row} /><IssueList issues={row.issues} /><PartialReasons codes={row.issues.map(issue => issue.code)} />
      {!isUnavailableStub(row) && <><p>{row.statement}</p><p>Domain: {row.domain} · Confidence: {row.confidence} · Evidence: {row.evidence_state}</p>
        <p>Reopening condition: {row.reopening_condition}</p><p>{contradictionText[row.contradiction_state]}</p>
        <LessonReferences row={row} /></>}
      <h3>Source receipts</h3><SourceRefList sources={row.sources} /><p>Row hash: <CopyableHash value={row.row_sha256} label="row hash" /></p>
    </article>)}
    {view && <nav aria-label="Lesson pages" className="flex flex-wrap gap-3"><button type="button" onClick={view.first} disabled={!view.hasPrevious && !view.snapshotChanged}>First</button><button type="button" onClick={view.previous} disabled={!view.hasPrevious}>Previous</button><button type="button" onClick={view.next} disabled={!view.hasNext}>Next</button></nav>}
  </div>;
}

export function LearningPage() {
  const view = useProjectionPages('lessons', { limit: 25 });
  return <LearningPanel view={view} />;
}
