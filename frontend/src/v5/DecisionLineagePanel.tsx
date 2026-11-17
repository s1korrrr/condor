import { isUnavailableStub, useProjectionPages } from './learning-projection';
import type { JobRow, ProjectionEnvelope, ProjectionPagesView, RecordEdgeRow, RecordNodeRow, UnavailableRowStub } from './learning-projection';
import { CopyableHash, IssueList, ProjectionStatusBanner, RefList, SourceRefList, UtcTime } from './projection-ui';
import { ownerTitle } from './format.mjs';
import { emptyPreview, ReferencePreview } from './LearningPanel';

type Records = ProjectionEnvelope<RecordNodeRow | RecordEdgeRow | UnavailableRowStub>;
type Attempts = ProjectionEnvelope<JobRow | UnavailableRowStub>;

function Pages({ view, label }: { view?: ProjectionPagesView<'records'> | ProjectionPagesView<'jobs'>; label: string }) {
  if (!view) return null;
  return <nav aria-label={`${label} pages`} className="flex flex-wrap gap-3"><button type="button" onClick={view.first} disabled={!view.hasPrevious && !view.snapshotChanged}>First</button><button type="button" onClick={view.previous} disabled={!view.hasPrevious}>Previous</button><button type="button" onClick={view.next} disabled={!view.hasNext}>Next</button></nav>;
}

function Receipts({ row }: { row: RecordNodeRow | RecordEdgeRow | JobRow | UnavailableRowStub }) {
  return <><p>Recorded: <UtcTime value={row.recorded_at_ms} /> · Available: <UtcTime value={row.available_at_ms} /></p><IssueList issues={row.issues} /><h4>Source receipts</h4><SourceRefList sources={row.sources} /><p>Row hash: <CopyableHash value={row.row_sha256} label="row hash" /></p></>;
}

export function DecisionLineagePanel({ nodeView, edgeView, attemptView, nodes, edges, attempts }: {
  nodeView?: ProjectionPagesView<'records'>; edgeView?: ProjectionPagesView<'records'>; attemptView?: ProjectionPagesView<'jobs'>;
  nodes?: Records; edges?: Records; attempts?: Attempts;
}) {
  const nodeEnvelope = nodeView ? nodeView.envelope : nodes ?? null;
  const edgeEnvelope = edgeView ? edgeView.envelope : edges ?? null;
  const attemptEnvelope = attemptView ? attemptView.envelope : attempts ?? null;
  const nodePage = !nodeView || nodeView.state === 'ready' ? nodeEnvelope : null;
  const edgePage = !edgeView || edgeView.state === 'ready' ? edgeEnvelope : null;
  const attemptPage = !attemptView || attemptView.state === 'ready' ? attemptEnvelope : null;
  const bannerState = (view: typeof nodeView | typeof attemptView, envelope: Records | Attempts | null) => view?.state === 'unavailable' && envelope?.status === 'UNAVAILABLE' && !view.error ? 'ready' : view?.state ?? (envelope ? 'ready' : 'unavailable');
  const excluded = edgePage?.status !== 'UNAVAILABLE' ? edgePage?.coverage.excluded_proposed_edges : null;
  return <div className="space-y-4 min-w-0">
    <div className="v5-page-heading"><div><h1>Research lineage</h1><p>Native-action lineage: not published</p><p>Only owner-recorded explicit assertions are shown.</p></div></div>
    <section className="min-w-0"><h2>Nodes</h2><ProjectionStatusBanner state={bannerState(nodeView, nodeEnvelope)} envelope={nodeEnvelope} error={nodeView?.error} onFirst={nodeView?.first} />
      {nodePage?.status !== 'UNAVAILABLE' && nodePage?.items.map(row => <article key={row.record_id} className="v5-panel min-w-0 break-words">
        <p className="break-all"><code className="select-text">{row.record_id}</code></p>
        {!isUnavailableStub(row) && row.record_type === 'node' ? <><h3>{row.title}</h3><p>{row.kind} · {row.native_state ?? 'Unknown'}</p>{row.kind === 'idea_revision' && <p>PROPOSED means registration, not readiness.</p>}{row.summary && <p>{row.summary}</p>}{row.identities.map(identity => <p key={`${identity.name}:${identity.value}`} className="break-all">{identity.name}: <code className="select-text">{identity.value}</code></p>)}</> : <p>Record unavailable</p>}
        <Receipts row={row} />
      </article>)}<Pages view={nodeView} label="Node" /></section>
    <section className="min-w-0"><h2>Explicit edges</h2><ProjectionStatusBanner state={bannerState(edgeView, edgeEnvelope)} envelope={edgeEnvelope} error={edgeView?.error} onFirst={edgeView?.first} />
      <p>{excluded == null ? 'unknown' : <span title={ownerTitle(excluded) ?? undefined}>{excluded}</span>} proposed links not shown: not explicit assertions</p>
      {edgePage?.status !== 'UNAVAILABLE' && edgePage?.items.map(row => <article key={row.record_id} className="v5-panel min-w-0 break-words">
        <p className="break-all"><code className="select-text">{row.record_id}</code></p>
        {!isUnavailableStub(row) && row.record_type === 'edge' ? <><h3>{row.relation} · {row.basis}</h3><h4>From</h4><RefList refs={[row.from_ref]} /><h4>To</h4><RefList refs={[row.to_ref]} /></> : <p>Record unavailable</p>}
        <Receipts row={row} />
      </article>)}<Pages view={edgeView} label="Edge" /></section>
    <section className="min-w-0"><h2>Research attempts</h2><ProjectionStatusBanner state={bannerState(attemptView, attemptEnvelope)} envelope={attemptEnvelope} error={attemptView?.error} onFirst={attemptView?.first} />
      {attemptPage?.status !== 'UNAVAILABLE' && attemptPage?.items.map(row => <article key={row.record_id} className="v5-panel min-w-0 break-words">
        <p className="break-all"><code className="select-text">{row.record_id}</code></p>
        {!isUnavailableStub(row) ? <><h3>Attempt <code className="select-text break-all">{row.attempt_id}</code></h3><p>{row.native_state} · Completion: {row.completion}{row.native_state === 'RUNNING' ? ' (not a process-liveness claim)' : ''}</p><p>Started: <UtcTime value={row.started_at_ms} /> · Finished: <UtcTime value={row.finished_at_ms} /></p><ReferencePreview shown={1 + row.artifact_refs.length} total={row.reference_total} /><h4>Experiment</h4><RefList refs={[row.experiment_ref]} /><h4>Artifacts</h4><RefList refs={row.artifact_refs} empty={emptyPreview(1 + row.artifact_refs.length, row.reference_total)} /></> : <p>Attempt unavailable</p>}
        <Receipts row={row} />
      </article>)}<Pages view={attemptView} label="Attempt" /></section>
  </div>;
}

export function DecisionLineagePage() {
  const nodeView = useProjectionPages('records', { record_type: 'node', limit: 25 });
  const edgeView = useProjectionPages('records', { record_type: 'edge', limit: 25 });
  const attemptView = useProjectionPages('jobs', { limit: 25 });
  return <DecisionLineagePanel nodeView={nodeView} edgeView={edgeView} attemptView={attemptView} />;
}
