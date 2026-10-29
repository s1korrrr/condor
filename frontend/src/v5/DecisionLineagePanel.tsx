import { useQuery } from '@tanstack/react-query';
import { DataTable } from '../features/quant-ops/kit/DataTable';
import { EvidenceList, ProjectionNotice, UtcTime } from './LearningPanel';
import { learningRead } from './api';
import type { ResearchProjection } from './ResearchFactoryPanel';

export function DecisionLineagePanel({ data, error }: { data?: ResearchProjection; error?: string }) {
  return <div className="space-y-4">
    <div className="v5-page-heading"><div><h1>Decision lineage</h1><p>Follow exact owner records, inputs, release bindings and receipts. Missing edges stay unknown.</p></div></div>
    <ProjectionNotice status={data?.status} reason={data?.reason} generatedAt={data?.generated_at_ms} error={error} />
    <section className="v5-panel"><h2>Workflow lifecycle and usage</h2><p>NOT_DISPATCHED requires owner proof and explicit zero consumption. DISPATCH_UNKNOWN means dispatch is unresolved. OUTPUT_PENDING means output is not yet final. UNKNOWN usage is not zero. Reservations remain HELD until the owner closes them. No request is replayed.</p><DataTable label="Workflow lifecycle and usage" rows={data?.jobs ?? []} rowId={row => `${row.job_id}:${row.attempt_id}`} emptyText="No job receipts available. Usage unknown." columns={[
      { id: 'job', header: 'Job / attempt', value: row => `${row.job_id} / ${row.attempt_id}`, rowHeader: true, wrap: true },
      { id: 'state', header: 'Owner lifecycle', value: row => row.owner_state },
      { id: 'history', header: 'State history', value: row => row.state_history.join(' → '), wrap: true },
      { id: 'usage', header: 'Usage state', value: row => row.usage.state },
      { id: 'calls', header: 'Calls / input / output tokens', value: row => [row.usage.calls, row.usage.input_tokens, row.usage.output_tokens].map(value => value ?? 'Unknown').join(' / ') },
      { id: 'cost', header: 'Cost / duration', value: row => `${row.usage.money ? `${row.usage.money.value} ${row.usage.money.quote_currency}` : 'Unknown'} / ${row.usage.duration_ms == null ? 'Unknown' : `${row.usage.duration_ms} ms`}` },
      { id: 'reserved', header: 'Reserved calls / duration', value: row => `${row.reservation.max_calls} / ${row.reservation.duration_ms == null ? 'Unknown' : `${row.reservation.duration_ms} ms`}` },
      { id: 'reservation-state', header: 'Reservation state', value: row => row.reservation_state ?? 'Unknown' },
      { id: 'resolution', header: 'No-dispatch owner proof', value: row => row.dispatch_resolution_ref?.record_id ?? 'Not reported', cell: row => <EvidenceList refs={row.dispatch_resolution_ref ? [row.dispatch_resolution_ref] : []} empty="Not reported" />, wrap: true },
    ]} /></section>
    <section className="v5-panel"><h2>Owner record chain</h2><p>Transport receipt ≠ native admission ≠ executor binding ≠ fill. An interrupted UI session never replays a request.</p><DataTable label="Full decision lineage" rows={data?.lineage ?? []} rowId={row => row.record_id} pageSize={12} emptyText="No decision lineage bound. Native execution and transport are unknown." columns={[
      { id: 'record', header: 'Record', value: row => row.title, rowHeader: true, wrap: true, size: 240, cell: row => <div><strong>{row.title}</strong><p>{row.kind.replaceAll('_', ' ')} · {row.record_id}</p></div> },
      { id: 'state', header: 'Owner state', value: row => row.state },
      { id: 'time', header: 'Available UTC', value: row => row.available_at_ms, cell: row => <UtcTime value={row.available_at_ms} /> },
      { id: 'parents', header: 'Parents and evidence', value: row => [...row.parent_refs, ...row.evidence_refs].map(ref => ref.record_id).join(' '), cell: row => <EvidenceList refs={[...row.parent_refs, ...row.evidence_refs]} empty="No parent / evidence refs reported" />, wrap: true, size: 300 },
      { id: 'inputs', header: 'Consumed inputs', value: row => row.input_refs.map(ref => ref.record_id).join(' '), cell: row => <EvidenceList refs={row.input_refs} empty="Inputs unknown" />, wrap: true, size: 300 },
      { id: 'identities', header: 'Pinned bindings', value: row => row.identities.map(item => `${item.label}: ${item.value}`).join('; '), cell: row => <details><summary>Inspect {row.identities.length} pinned identities</summary><dl className="break-all">{row.identities.map(item => <div key={item.label}><dt>{item.label.replaceAll('_', ' ')}</dt><dd>{item.value}</dd></div>)}<div className="mt-2 text-xs">Record SHA256 {row.payload_sha256}</div></dl></details>, wrap: true, size: 300 },
    ]} /></section>
    <section className="v5-panel"><h2>Permission remains separate</h2><p>Catalog eligibility: owner-only. Research support: owner-only. Paper, canary and live readiness: disabled. Transport: unknown. Native execution: unknown.</p><p>No activation, delegation, replay or model controls exist on this view.</p></section>
  </div>;
}

export function DecisionLineagePage() {
  const query = useQuery({ queryKey: ['v5-learning-lineage'], queryFn: () => learningRead<ResearchProjection>('research?cursor=0&limit=25'), retry: false });
  if (query.isPending) return <p role="status">Loading decision lineage…</p>;
  return <DecisionLineagePanel data={query.data} error={query.error?.message} />;
}
