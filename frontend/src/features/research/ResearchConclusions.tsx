import { useQuery } from '@tanstack/react-query';
import { authFetch } from '@/lib/auth-token';
import { readResearch } from './read';
import { records, researchReadState, catalogCount } from './model';
import { researchRecordSummary } from './record-summary';
import { labTimestamp } from './lab-state';
import { LabReadNotice } from './ResearchViews';

const read = readResearch(authFetch);

export function ResearchConclusions({ server, now, revision, kind, onSelect }: {
  server: string;
  now: number;
  revision: string;
  kind: 'assessment' | 'run';
  onSelect(id: string): void;
}) {
  const query = useQuery({
    queryKey: [kind === 'assessment' ? 'research-recent-assessments' : 'research-recent-runs', server, revision],
    queryFn: ({ signal }) => read('nodes', server, { kind, limit: '6', offset: '0' }, signal),
    enabled: !!server && !!revision,
    refetchInterval: 30_000,
    retry: 1,
  });
  const state = researchReadState(query.data, now, query.isError, query.dataUpdatedAt);
  const sameRevision = query.data?.data.revision === revision;
  const items = records(query.data?.data.items);
  return <section className="quant-panel">
    <header className="quant-panel-heading"><div><h2>{kind === 'assessment' ? 'Recorded conclusions' : 'Recent attempt outcomes'}</h2><p className="quant-muted">{kind === 'assessment' ? 'Latest recorded assessments. Open a record for its scope, rationale and evidence.' : 'Latest recorded attempts, including failed and interrupted work. Completion alone does not support a hypothesis.'}</p></div></header>
    <div className="lab-list-body">
      {state !== 'available' ? <LabReadNotice state={state} error={query.error} onRetry={() => void query.refetch()} /> : !sameRevision ? <p className="quant-notice" role="status">These records belong to another index revision. <button onClick={() => void query.refetch()}>Refresh records</button></p> : <>
        {items.length ? <ul className="space-y-4">{items.map(item => {
          const row = researchRecordSummary(item);
          return <li key={row.id} className="border-b border-[var(--color-border)] pb-3 last:border-0">
            <div className="flex flex-wrap items-start justify-between gap-2"><button className="quant-record-link !text-left" title={row.fullTitle} onClick={() => onSelect(row.id)}>{row.title}</button><span className="text-xs font-medium">{row.verdict}</span></div>
            <p className="mt-1 text-xs quant-muted">{row.scope || 'Scope is in the source record'}{row.start || row.end ? ` · ${row.start || 'Start not recorded'} → ${row.end || 'End not recorded'}` : ''}</p>
            <p className="mt-1 text-xs quant-muted break-all">{labTimestamp(row.recordedAt)} · {row.id}</p>
            {(row.rationale || row.fullTitle !== row.title) && <details className="mt-2 text-sm"><summary className="cursor-pointer text-[var(--color-primary)]">Rationale and source title</summary>{row.fullTitle !== row.title && <p className="mt-2">{row.fullTitle}</p>}{row.rationale && <p className="mt-2 whitespace-pre-wrap break-words">{row.rationale}</p>}</details>}
          </li>;
        })}</ul> : <p className="quant-notice">No {kind === 'assessment' ? 'assessments' : 'attempts'} recorded in this index.</p>}
        <p className="quant-muted mt-3">Showing {items.length} of {catalogCount(query.data?.data ?? {}, 'total') ?? 'an unavailable total'} records, ordered by recorded date. {kind === 'run' ? 'This is recent activity, not a complete failure inventory.' : ''}</p>
      </>}
    </div>
  </section>;
}
