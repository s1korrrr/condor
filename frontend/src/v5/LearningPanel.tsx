import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DataTable } from '../features/quant-ops/kit/DataTable';
import { TileGrid } from '../features/quant-ops/kit/grid';
import { learningRead } from './api';

export interface EvidenceRef {
  owner: string; record_kind: string; record_id: string; revision: string;
  content_sha256: string; available_at_ms: number;
}
export interface RoleProjection {
  role_id: string; name: string; status: string; blockers: string[];
  task_id: string | null; model: string; usage: string; provider_metered_usage: string | null;
}
export interface LessonProjection {
  record_id: string; lesson_id: string; revision: string; claim: string; condition: string;
  evidence_validity: string; lifecycle_state: string; available_at_ms: number;
  support_refs: EvidenceRef[]; contradictory_refs: EvidenceRef[]; retraction_refs: EvidenceRef[];
}
export interface LearningProjection {
  schema_version?: string; status: string; reason?: string; generated_at_ms?: number;
  source_generation?: string; effect: 'NONE'; lessons?: LessonProjection[];
  releases?: { record_id: string; release_id: string; state: string; scope_of_use: string; binding_status: string; missing_bindings: string[]; bindings?: { component: string; refs: EvidenceRef[]; absence_reason: string | null }[] }[];
  adoptions?: { record_id: string; consumer_id: string; disposition: string; reason: string; new_release_ref: EvidenceRef; effective_decision_boundary_ms: number }[];
  retractions?: { record_id: string; reason: string; effective_at_ms: number; affected_refs: EvidenceRef[] }[];
}

const unknown = (value: string | number | null | undefined) => value == null || value === '' ? 'Unknown' : String(value);
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
  return <div><span className="block truncate" title={refs[0].record_id}>{refs[0].record_id}</span><details><summary>Inspect {refs.length} evidence references</summary>{evidence}</details></div>;
}

export function MetricTiles({ items }: { items: { label: string; value: string | number }[] }) {
  return <TileGrid label="Owner summary" min={170}>{items.map(item => <div key={item.label} className="v5-panel h-full"><span className="text-xs text-[var(--color-text-muted)]">{item.label}</span><p className="text-xl font-semibold break-words">{item.value}</p></div>)}</TileGrid>;
}

export function LearningPanel({ data, roles = [], error }: { data?: LearningProjection; roles?: RoleProjection[]; error?: string }) {
  return <ProjectionClock status={data?.status} sourceGeneration={data?.source_generation}><div className="space-y-4">
    <div className="v5-page-heading"><div><h1>Learning oversight</h1><p>Inspect claims, contradictions and release adoption. Evidence never grants execution.</p></div></div>
    <ProjectionNotice status={data?.status} reason={data?.reason} generatedAt={data?.generated_at_ms} error={error} />
    <MetricTiles items={[{ label: 'Roles blocked', value: roles.length ? roles.filter(role => role.status === 'BLOCKED').length : 'Unknown' }, { label: 'Lessons on this page', value: data?.lessons?.length ?? 'Unknown' }, { label: 'Applied receipts on this page', value: data?.adoptions?.filter(row => row.disposition === 'APPLIED').length ?? 'Unknown' }, { label: 'View provider calls', value: 'Not dispatched' }]} />
    <section className="v5-panel"><h2>Fixed roles and blockers</h2><DataTable label="Role bindings" rows={roles} rowId={row => row.role_id} emptyText="No role manifest available." columns={[
      { id: 'role', header: 'Role', value: row => row.name, rowHeader: true },
      { id: 'status', header: 'State', value: row => row.status },
      { id: 'blockers', header: 'Blockers', value: row => row.blockers.join('; '), wrap: true },
      { id: 'task', header: 'Owner task', value: row => row.task_id ?? 'Binding missing' },
      { id: 'usage', header: 'Usage', value: row => row.usage },
      { id: 'metered', header: 'Provider metered', value: row => unknown(row.provider_metered_usage) },
    ]} /></section>
    <section className="v5-panel"><h2>Lessons and contradictions</h2><DataTable label="Lesson evidence" rows={data?.lessons ?? []} rowId={row => row.record_id} emptyText="No lessons reported. This is not evidence of no contradictions." columns={[
      { id: 'claim', header: 'Claim and scope condition', value: row => `${row.claim} — ${row.condition}`, rowHeader: true, wrap: true, size: 300 },
      { id: 'state', header: 'Validity / lifecycle', value: row => `${row.evidence_validity} / ${row.lifecycle_state}` },
      { id: 'support', header: 'Support', value: row => row.support_refs.map(ref => ref.record_id).join(' '), cell: row => <EvidenceList refs={row.support_refs} />, wrap: true, size: 260 },
      { id: 'contradictions', header: 'Contradictions', value: row => row.contradictory_refs.map(ref => ref.record_id).join(' '), cell: row => <EvidenceList refs={row.contradictory_refs} />, wrap: true, size: 260 },
      { id: 'time', header: 'Available UTC', value: row => utc(row.available_at_ms), cell: row => <UtcTime value={row.available_at_ms} /> },
    ]} /></section>
    <section className="v5-panel"><h2>Knowledge releases</h2><DataTable label="Release consumer bindings" rows={data?.releases ?? []} rowId={row => row.record_id} columns={[
      { id: 'release', header: 'Release', value: row => row.release_id, rowHeader: true },
      { id: 'state', header: 'Publication / use', value: row => `${row.state} / ${row.scope_of_use}` },
      { id: 'bindings', header: 'Consumer bindings', value: row => row.binding_status ?? 'Unknown' },
      { id: 'missing', header: 'Missing bindings', value: row => row.missing_bindings?.length === 0 ? 'None; owner validation still required' : row.missing_bindings?.join(', ') ?? 'Unknown', wrap: true },
      { id: 'components', header: 'Complete consumer manifest', value: row => row.bindings?.map(binding => binding.component).join(' ') ?? 'Unknown', cell: row => row.bindings?.length ? <details><summary>Inspect {row.bindings.length} consumer bindings</summary><dl>{row.bindings.map(binding => <div key={binding.component} className="mb-2"><dt>{binding.component.replaceAll('_', ' ')}</dt><dd>{binding.absence_reason ?? <EvidenceList refs={binding.refs} />}</dd></div>)}</dl></details> : 'Unknown', wrap: true, size: 340 },
    ]} /></section>
    <section className="v5-panel"><h2>Applied releases and retractions</h2><DataTable label="Release adoption receipts" rows={data?.adoptions ?? []} rowId={row => row.record_id} emptyText="No adoption receipt. Publication does not mean applied." columns={[
      { id: 'consumer', header: 'Consumer', value: row => row.consumer_id, rowHeader: true },
      { id: 'release', header: 'Release', value: row => row.new_release_ref.record_id },
      { id: 'disposition', header: 'Adoption', value: row => row.disposition },
      { id: 'reason', header: 'Reason', value: row => row.reason, wrap: true },
      { id: 'boundary', header: 'Decision boundary UTC', value: row => utc(row.effective_decision_boundary_ms), cell: row => <UtcTime value={row.effective_decision_boundary_ms} /> },
    ]} /><DataTable label="Retractions" rows={data?.retractions ?? []} rowId={row => row.record_id} emptyText="No retraction reported by this snapshot." columns={[
      { id: 'reason', header: 'Retraction reason', value: row => row.reason, rowHeader: true, wrap: true },
      { id: 'affected', header: 'Affected evidence', value: row => row.affected_refs.map(ref => ref.record_id).join(' '), cell: row => <EvidenceList refs={row.affected_refs} />, wrap: true },
      { id: 'effective', header: 'Effective UTC', value: row => utc(row.effective_at_ms), cell: row => <UtcTime value={row.effective_at_ms} /> },
    ]} /></section>
  </div></ProjectionClock>;
}

export function LearningPage() {
  const manifest = useQuery({ queryKey: ['v5-learning'], queryFn: () => learningRead<LearningProjection>('manifest'), retry: false });
  const roles = useQuery({ queryKey: ['v5-learning-roles'], queryFn: () => learningRead<{ roles: RoleProjection[] }>('roles'), retry: false });
  if (manifest.isPending || roles.isPending) return <p role="status">Loading learning evidence…</p>;
  return <LearningPanel data={manifest.data} roles={roles.data?.roles} error={manifest.error?.message ?? roles.error?.message} />;
}
