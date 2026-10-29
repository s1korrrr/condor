import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DataTable } from '../features/quant-ops/kit/DataTable';
import { EvidenceList, MetricTiles, ProjectionNotice } from './LearningPanel';
import { learningRead } from './api';
import type { EvidenceRef } from './LearningPanel';

export interface CandidateProjection {
  candidate_id: string; candidate_revision: string; family_id: string; variant_id: string;
  catalog_eligibility: string; research_support: string; readiness: string; native_execution: string; trial_refs: EvidenceRef[];
}
export interface LineageProjection {
  record_id: string; kind: string; title: string; state: string; available_at_ms: number;
  payload_sha256: string; parent_refs: EvidenceRef[]; evidence_refs: EvidenceRef[];
  input_refs: EvidenceRef[]; identities: { label: string; value: string }[];
}
export interface ResearchProjection {
  jobs?: { job_id: string; attempt_id: string; owner_state: string; state_history: string[]; usage: { state: string; calls: number | null; input_tokens: number | null; output_tokens: number | null; duration_ms: number | null; money: { value: string; quote_currency: string } | null }; reservation: { max_calls: number; duration_ms: number | null }; reservation_state: 'HELD' | 'CLOSED'; dispatch_resolution_ref?: EvidenceRef | null; replay_allowed: false }[];
  schema_version?: string; status: string; reason?: string; effect: 'NONE'; generated_at_ms?: number; source_generation?: string;
  total_candidates?: number; total_families?: number; total_variants?: number; next_cursor?: number | null;
  candidates?: CandidateProjection[]; campaigns?: { campaign_id: string; state: string; reason: string }[];
  lineage?: LineageProjection[]; inventory_owner?: string; inventory_policy?: string;
  open_bags?: number | null; capital_occupancy?: string | null; risk_restrictions?: string; rollback_target?: string; forecast_quality?: string;
}

const unknown = (value: string | number | null | undefined) => value == null || value === '' ? 'Unknown' : String(value);

export function ResearchFactoryPanel({ data, error, loading = false, onNext, onFirst }: { data?: ResearchProjection; error?: string; loading?: boolean; onNext?: () => void; onFirst?: () => void }) {
  const candidates = data?.candidates ?? [];
  return <div className="space-y-4">
    <div className="v5-page-heading"><div><h1>Research factory</h1><p>Every candidate and trial remains inspectable. Catalog membership is not research support.</p></div></div>
    <ProjectionNotice status={data?.status} reason={data?.reason} generatedAt={data?.generated_at_ms} error={error} />
    <MetricTiles items={[{ label: 'Candidates · full catalog', value: data?.total_candidates ?? 'Unknown' }, { label: 'Families · full catalog', value: data?.total_families ?? 'Unknown' }, { label: 'Variants · full catalog', value: data?.total_variants ?? 'Unknown' }, { label: 'Forecast quality', value: unknown(data?.forecast_quality) }]} />
    <section className="v5-panel"><h2>Candidate catalog</h2><p>Catalog eligibility, research support, readiness and native execution are independent owner facts. Trial references are not outcomes; missing owner results stay unknown.</p><DataTable label="Candidate revisions" rows={candidates} rowId={row => `${row.candidate_id}:${row.candidate_revision}`} emptyText="No candidates reported by owner." pageSize={25} columns={[
      { id: 'candidate', header: 'Candidate / revision', value: row => `${row.candidate_id} / ${row.candidate_revision}`, rowHeader: true },
      { id: 'family', header: 'Family / variant', value: row => `${row.family_id} / ${row.variant_id}` },
      { id: 'eligibility', header: 'Catalog eligibility', value: row => row.catalog_eligibility },
      { id: 'support', header: 'Research support', value: row => row.research_support },
      { id: 'ready', header: 'Readiness', value: row => row.readiness },
      { id: 'native', header: 'Native execution', value: row => row.native_execution },
      { id: 'trials', header: 'All trial evidence', value: row => row.trial_refs.map(ref => ref.record_id).join(' '), cell: row => <EvidenceList refs={row.trial_refs} empty="Trial evidence unavailable; outcome unknown" />, wrap: true, size: 300 },
    ]} /><nav aria-label="Owner candidate pages" className="flex flex-wrap gap-3 mt-3"><button className="v5-button" onClick={onFirst} disabled={!onFirst || loading}>First owner page</button><button className="v5-button" onClick={onNext} disabled={data?.next_cursor == null || !onNext || loading}>Next owner page</button><span role="status">{loading ? 'Loading owner page…' : `${candidates.length} rows on this owner page`}</span></nav></section>
    <section className="v5-panel"><h2>Campaigns, including failures</h2><DataTable label="Campaign outcomes" rows={data?.campaigns ?? []} rowId={row => row.campaign_id} emptyText="No campaign receipts. No outcome is inferred." columns={[
      { id: 'campaign', header: 'Campaign', value: row => row.campaign_id, rowHeader: true },
      { id: 'state', header: 'Owner state', value: row => row.state },
      { id: 'reason', header: 'Reason / limitation', value: row => row.reason, wrap: true },
    ]} /></section>
    <section className="v5-panel"><h2>Native owner boundaries</h2><dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">{[
      ['Inventory owner', data?.inventory_owner], ['Inventory policy', data?.inventory_policy], ['Open bags', data?.open_bags], ['Capital occupancy', data?.capital_occupancy], ['Native risk restrictions', data?.risk_restrictions], ['Rollback target', data?.rollback_target],
    ].map(([label, value]) => <div key={label}><dt className="text-xs text-[var(--color-text-muted)]">{label}</dt><dd>{unknown(value)}</dd></div>)}</dl><p>No bag, balance or native policy is reconstructed in the browser.</p></section>
  </div>;
}

export function ResearchFactoryPage() {
  const [cursor, setCursor] = useState(0);
  const query = useQuery({ queryKey: ['v5-learning-research', cursor], queryFn: () => learningRead<ResearchProjection>(`research?cursor=${cursor}&limit=25`), retry: false });
  return <ResearchFactoryPanel data={query.data} error={query.error?.message} loading={query.isPending} onFirst={() => setCursor(0)} onNext={() => { if (query.data?.next_cursor != null) setCursor(query.data.next_cursor); }} />;
}
