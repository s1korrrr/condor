import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { v5Api } from './api';
import { ownerTitle, signed } from './format.mjs';
import { STAGE_B_REVISION } from './learning-projection-schemas';
import {
  isUnavailableStub, useManifest, useProjectionPages,
  type AssessmentRow, type CampaignRow, type CandidateRow, type Issue, type ProjectionPagesView, type Ref,
} from './learning-projection';
import { CopyableHash, IssueList, ProjectionStatusBanner, RefList, SourceRefList, type BannerEnvelope } from './projection-ui';

type FactoryDatasetName = 'candidates' | 'campaigns' | 'assessments';

interface EvidenceRef {
  owner: string; record_kind: string; record_id: string; revision: string;
  content_sha256: string; available_at_ms: number;
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
  lineage?: LineageProjection[]; inventory_owner?: string; inventory_policy?: string;
  open_bags?: number | null; capital_occupancy?: string | null; risk_restrictions?: string; rollback_target?: string; forecast_quality?: string;
}

const TITLES = { candidates: 'Candidate revisions', campaigns: 'Recorded campaigns', assessments: 'Recorded assessments' };
const MISSING_SEAL = "preregistration seal not found in this store snapshot; the campaign's plan could not be verified as frozen";

function FactoryIssues({ issues }: { issues: Issue[] }) {
  return <>{issues.some(issue => issue.code === 'OMITTED_CONTENT') && <p>Some owner content was omitted from this projection.</p>}<IssueList issues={issues} /></>;
}

function FactList({ facts }: { facts: [string, ReactNode][] }) {
  return <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">{facts.map(([label, value]) =>
    <div className="min-w-0" key={label}><dt className="text-xs text-[var(--color-text-muted)]">{label}</dt><dd>{value}</dd></div>,
  )}</dl>;
}

function ReferencePreview({ refs, total }: { refs: Ref[]; total: number | null }) {
  return <div><p>References: {total === null ? `${refs.length} shown; more may exist` : `${refs.length} of ${total} shown`}</p>
    {refs.length > 0 && <RefList refs={refs} />}
  </div>;
}

function Candidate({ row, onAssess }: { row: CandidateRow; onAssess?: (revision: string) => void }) {
  return <>
    <h3>{row.title}</h3>
    <p><strong>{row.registration_state}</strong> — registered, not ready</p>
    <FactList facts={[
      ['Idea', <CopyableHash value={row.idea_id} label="idea ID" />],
      ['Exact revision', <CopyableHash value={row.idea_revision_id} label="idea revision" />],
      ['Implementation qualification', 'not published'], ['Readiness', 'not published'], ['Execution permission', row.execution_permission],
    ]} />
    <p><strong>{row.truncated_fields.includes('hypothesis') ? 'Hypothesis (shortened excerpt)' : 'Hypothesis'}:</strong> {row.hypothesis}</p>
    <ReferencePreview refs={[...row.experiment_refs, ...row.assessment_refs]} total={row.reference_total} />
    {onAssess && <button type="button" className="v5-button whitespace-normal" onClick={() => onAssess(row.idea_revision_id)}>View assessments for this revision</button>}
  </>;
}

function Campaign({ row }: { row: CampaignRow }) {
  const paper = row.native_kind === 'paper_campaign';
  return <>
    <h3>{paper ? 'Paper campaign' : row.title}</h3>
    <p><strong>Historical</strong> · {row.row_status} · Owner recorded {paper ? row.stage : row.native_state} · Dispatch permission {row.dispatch_permission}</p>
    <p><CopyableHash value={row.campaign_id} label="campaign ID" />{row.campaign_id !== row.record_id && <> · <CopyableHash value={row.record_id} label="record ID" /></>}</p>
    {paper ? <>
      <p>{row.preregistration_seal === 'MISSING' ? MISSING_SEAL : 'Preregistration seal verified for this store snapshot.'}</p>
      <p>{row.query}</p>
    </> : row.reason && <p>{row.reason}</p>}
    <ReferencePreview refs={[...(paper ? [row.experiment_ref] : []), ...row.candidate_refs, ...row.attempt_refs]} total={row.reference_total} />
  </>;
}

function Assessment({ row, relationship }: { row: AssessmentRow; relationship?: string }) {
  const { comparison } = row;
  return <>
    <h3>Historical assessment</h3>
    <FactList facts={[
      ['Record', <CopyableHash value={row.record_id} label="assessment record ID" />],
      ['Evaluation', <CopyableHash value={row.evaluation_id} label="evaluation ID" />],
      ['Exact revision', <CopyableHash value={row.idea_revision_id} label="assessed revision ID" />],
    ]} />
    <FactList facts={[
      ...(comparison || row.admission === 'RECORDED_ONLY' ? [['Recorded verdict', row.verdict] as [string, string]] : []),
      ['Admission', row.admission], ['Validity', row.validity], ['Attribution', row.attribution],
      ['Hurdle status', row.hurdle_status ?? 'not published'],
    ]} />
    {relationship && <p>{relationship}</p>}
    {comparison && <FactList facts={[
      ['Delta', <><span title={ownerTitle(comparison.delta) ?? undefined}>{signed(comparison.delta)}</span> {comparison.unit}</>],
      ['Baseline', comparison.baseline_id], ['Metric', comparison.metric], ['Comparable group', comparison.comparable_group],
      ['Owner comparison group', comparison.comparison_group],
      ['Window', typeof comparison.conditions.window === 'string' ? comparison.conditions.window : `${comparison.conditions.window.start} to ${comparison.conditions.window.end_exclusive} (exclusive)`],
      ['Venue', comparison.conditions.venue], ['Instrument', comparison.conditions.instrument], ['Capital model', comparison.conditions.capital_model],
      ['Costs', comparison.conditions.costs_identity], ['Execution', comparison.conditions.execution_identity], ['Validation', comparison.conditions.validation],
    ]} />}
    <RefList refs={[row.run_ref, ...(row.supersedes ? [row.supersedes] : [])]} />
  </>;
}

export function FactoryStatus({ state, envelope, error, first }: Pick<ProjectionPagesView<FactoryDatasetName>, 'state' | 'error'> & { envelope: BannerEnvelope | null; first?: () => void }) {
  if (envelope?.status === 'UNAVAILABLE') return <div role="alert" className="v5-panel min-w-0">
    <strong>UNAVAILABLE</strong><p>{envelope.reason_codes.join(', ')}</p><FactoryIssues issues={envelope.issues} />
  </div>;
  if (error?.code === 'WARMING') return <div role="status" className="v5-panel"><strong>WARMING</strong><p>The owner is verifying a publication.</p></div>;
  if (error?.code === 'UPSTREAM_UNAVAILABLE') return <div role="alert" className="v5-panel"><strong>UNAVAILABLE · UPSTREAM_UNAVAILABLE</strong><p>No owner projection response is available.</p></div>;
  if (state === 'unavailable' && !error) return <div role="alert" className="v5-panel"><strong>UNAVAILABLE</strong><p>No fresh owner receipt is available.</p></div>;
  return <ProjectionStatusBanner state={state} envelope={envelope} error={error} onFirst={first}>
    {envelope?.reason_codes.includes('OMITTED_CONTENT') && <p>Some owner content was omitted from this projection.</p>}
  </ProjectionStatusBanner>;
}

export function FactoryDataset({ dataset, view, onAssess }: {
  dataset: FactoryDatasetName;
  view: ProjectionPagesView<FactoryDatasetName>;
  onAssess?: (revision: string) => void;
}) {
  const { state, envelope, rows, error } = view;
  return <section className="v5-panel min-w-0 max-w-full space-y-3 [overflow-wrap:anywhere]">
    <h2>{TITLES[dataset]}</h2>
    <FactoryStatus state={state} envelope={envelope} error={error} first={view.first} />
    {state === 'ready' && envelope && <>
      {!rows.length && <p>{dataset === 'assessments' && envelope.status === 'BOUND' && envelope.coverage.total_items === 0
        ? 'no recorded assessments for this revision' : 'No rows on this owner page.'}</p>}
      {dataset === 'assessments' && rows.length > 0 && !view.assessmentRelationships && <p>assessment relationship status not yet established</p>}
      {rows.map(row => <article key={row.record_id} className="min-w-0 space-y-2 border-t border-[var(--color-border)] pt-3">
        {isUnavailableStub(row) ? <p>UNAVAILABLE row · <CopyableHash value={row.record_id} label="record ID" /></p>
          : 'registration_state' in row ? <Candidate row={row} onAssess={onAssess} />
          : 'campaign_id' in row ? <Campaign row={row} />
          : 'assessment_id' in row ? <Assessment row={row} relationship={view.assessmentRelationships?.get(row.record_id)} />
          : null}
        <FactoryIssues issues={row.issues} /><SourceRefList sources={row.sources} />
      </article>)}
      <nav className="flex flex-wrap gap-2" aria-label={`${TITLES[dataset]} owner pages`}>
        <button type="button" className="v5-button" onClick={view.previous} disabled={!view.hasPrevious}>Previous page</button>
        <button type="button" className="v5-button" onClick={view.next} disabled={!view.hasNext}>Next page</button>
      </nav>
    </>}
  </section>;
}

function RevisionAssessments({ revision }: { revision: string }) {
  const view = useProjectionPages('assessments', { idea_revision_id: revision });
  return <div className="min-w-0"><p>Selected revision: <CopyableHash value={revision} label="selected revision" /></p>
    <FactoryDataset dataset="assessments" view={view} />
  </div>;
}

function FactoryPages() {
  const candidates = useProjectionPages('candidates');
  const campaigns = useProjectionPages('campaigns');
  const [revision, setRevision] = useState<string | null>(null);
  return <>
    <FactoryDataset dataset="candidates" view={candidates} onAssess={setRevision} />
    {revision && <RevisionAssessments key={revision} revision={revision} />}
    <FactoryDataset dataset="campaigns" view={campaigns} />
  </>;
}

export function ResearchFactoryPanel() {
  const { data: session } = useQuery({ queryKey: ['v5-auth'], queryFn: v5Api.auth, enabled: false });
  const stageB = session?.authenticated === true && session.learning_projection_revision === STAGE_B_REVISION;
  const manifest = useManifest();
  return <div className="min-w-0 max-w-full space-y-4 [overflow-wrap:anywhere]">
    <div className="v5-page-heading"><div><h1>Research factory</h1><p>Recorded research only. No execution authority.</p></div></div>
    <FactoryStatus state={manifest.state} envelope={manifest.envelope} error={manifest.error} />
    {stageB ? <FactoryPages /> : <p>Factory: not bound in this stage</p>}
  </div>;
}

export const ResearchFactoryPage = ResearchFactoryPanel;
