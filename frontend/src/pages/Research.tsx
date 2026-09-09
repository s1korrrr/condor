import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { useServer } from '@/hooks/useServer';
import { authFetch } from '@/lib/auth-token';
import { object, text, catalogCount, researchReadState } from '@/features/research/model';
import { readResearch } from '@/features/research/read';
import { LAB_VIEWS, labTimestamp, readLabState, updateLabParams, clearLabServerSelection } from '@/features/research/lab-state';
import { loadConsistentLabNetwork, type LabNetwork } from '@/features/research/lab-network-data';
import { ResearchNetwork } from '@/features/research/ResearchNetwork';
import type { Camera } from '@/features/research/lab-network-engine';
import { LabCharts, LabCounts, LabLimitations } from '@/features/research/ResearchOverview';
import { LabQueue, LabRecords, LabReadNotice } from '@/features/research/ResearchViews';
import { ResearchInspector } from '@/features/research/ResearchInspector';
import { ResearchArchive } from '@/features/research/ResearchArchive';
import '@/features/research/workspace.css';
import '@/features/research/lab.css';

const read = readResearch(authFetch);
export function Research() {
  const { server } = useServer();
  const [params, setParams] = useSearchParams();
  const [previousServer, setPreviousServer] = useState(server);
  const serverChanged = previousServer !== server;
  useEffect(() => {
    if (!serverChanged) return;
    setParams(clearLabServerSelection(params), { replace: true });
    // Complete the boundary after the URL no longer carries the previous server's identities.
    queueMicrotask(() => setPreviousServer(server));
  }, [server, serverChanged, params, setParams]);
  return <div className="quant-workspace research-lab">{server && !serverChanged ? <ResearchLab key={server} server={server} /> : <><header className="quant-heading"><div><h1>Research</h1><p>Ideas, experiments and evidence from Research OS.</p></div></header><section className="quant-notice" role="status">{serverChanged ? 'Loading the selected research server…' : <>Select a server to open its research workspace. <Link to="/settings">Open Settings</Link></>}</section></>}</div>;
}
function ResearchLab({ server }: { server: string }) {
  const [params, setParams] = useSearchParams(), state = readLabState(params);
  const [now, setNow] = useState(Date.now), [queryText, setQueryText] = useState(state.q);
  const [cameraStore] = useState(() => new Map<string, Camera>());
  const lastTrigger = useRef<HTMLElement | null>(null), focusSequence = useRef(0);
  const client = useQueryClient();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { const timer = setTimeout(() => setQueryText(state.q), 300); return () => clearTimeout(timer); }, [state.q]);
  const overview = useQuery({ queryKey: ['research-overview', server], queryFn: ({ signal }) => read('overview', server, {}, signal), refetchInterval: 30000, retry: 1 });
  const overviewState = researchReadState(overview.data, now, overview.isError, overview.dataUpdatedAt);
  const available = overviewState === 'available', data = available ? object(overview.data?.data) : {}, freshness = object(data.freshness);
  const revision = text(overview.data?.data.revision, '');
  const networkVisible = state.view === 'overview' || state.view === 'graph';
  const networkQuery = useQuery({ queryKey: ['research-network', server, revision], enabled: available && networkVisible && !!revision,
    queryFn: ({ signal }) => loadConsistentLabNetwork(read, server, revision, signal), staleTime: Infinity, gcTime: 5 * 60 * 1000, retry: 1,
  });
  useEffect(() => {
    const result = networkQuery.data;
    if (!result?.overview || result.network.data.revision === revision) return;
    client.setQueryData(['research-network', server, result.network.data.revision], { network: result.network });
    client.setQueryData(['research-overview', server], result.overview);
  }, [networkQuery.data, revision, server, client]);
  const network = available && !networkQuery.isError && networkQuery.data?.network.data.revision === revision ? networkQuery.data.network.data as unknown as LabNetwork : null;
  const change = (values: Record<string, string>, options: { resetPage?: boolean; clearSelection?: boolean } = {}, replace = false) => setParams(updateLabParams(params, values, options), { replace });
  const navigate = (view: string) => change({ view }, { resetPage: true });
  const select = (id: string) => {
    if (id && !state.selected && document.activeElement instanceof HTMLElement) lastTrigger.current = document.activeElement;
    change({ id, ...(!id ? { network_focus: '' } : {}) });
    if (!id) requestAnimationFrame(() => lastTrigger.current?.isConnected && lastTrigger.current.focus());
  };
  const find = (id: string) => { focusSequence.current += 1; change({ view: 'graph', id, network_focus: `${id}:${Date.now()}:${focusSequence.current}` }); };
  const refresh = () => { void client.invalidateQueries({ predicate: query => query.queryKey[0] !== 'research-network' && typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('research-') && query.queryKey[1] === server }); };
  const filter = (values: Record<string, string>) => change(values, { resetPage: true, clearSelection: true }, true);
  const graph = network ? <ResearchNetwork data={network} selected={state.selected} query={state.network_q} kind={state.network_kind} focus={state.network_focus} onSelect={select} onFilters={(query, kind) => change({ network_q: query, network_kind: kind }, {}, true)} cameraStore={cameraStore} cameraKey={`${revision}:${state.view}`} /> : <LabReadNotice state={available ? networkQuery.isError ? 'error' : 'loading' : overviewState} error={overview.error ?? networkQuery.error} onRetry={() => { void overview.refetch(); void networkQuery.refetch(); }} />;
  const viewLabel = LAB_VIEWS.find(view => view.id === state.view)?.label ?? 'Overview';
  return <><header className="quant-heading"><div><h1>Research</h1><p>Ideas, experiments and evidence from Research OS.</p></div><button onClick={refresh} disabled={overview.isFetching}><RefreshCw size={15} className={overview.isFetching ? 'animate-spin' : ''} />Refresh</button></header>
    <div className="quant-source-strip"><span className={available && freshness.state === 'CURRENT' ? 'quant-positive' : ''}>{available ? `Index ${text(freshness.state, 'unknown').toLowerCase()}` : `Research connection ${overviewState}`}</span><span>Last index sync · {labTimestamp(freshness.last_sync)}</span><span>Read-only source</span><span title={revision}>Revision {revision ? revision.slice(0, 12) : 'unavailable'}</span></div>
    {overview.isError && <div className="quant-notice" role="alert">{overview.error.message}<button onClick={() => void overview.refetch()}>Retry connection</button></div>}
    <LabCounts data={data} onView={navigate} />
    <nav className="lab-nav" aria-label="Research Lab views">{LAB_VIEWS.map(view => <button key={view.id} aria-current={state.view === view.id ? 'page' : undefined} onClick={() => navigate(view.id)}>{view.label}</button>)}</nav>
    <div className={`lab-workspace-body ${state.selected && state.view !== 'archive' ? 'lab-with-inspector' : ''}`}>
      <main className="lab-main" aria-label={`${viewLabel} research view`}>
        {state.view === 'archive' ? <ResearchArchive key={server} server={server} /> : networkVisible ? <>
          {state.view === 'overview' && network && <LabCharts data={network} expanded onFilter={(key, value) => change({ view: 'ideas', q: '', family: '', lane: '', [key]: value }, { resetPage: true, clearSelection: true })} />}
          <section className={`quant-panel lab-network-panel ${state.view === 'overview' ? 'lab-network-preview' : ''}`}><header className="quant-panel-heading"><div><h2>{state.view === 'overview' ? 'The research landscape' : 'Research network'}</h2><p className="quant-muted">{network ? `${network.total_nodes.toLocaleString()} nodes · ${network.total_edges.toLocaleString()} recorded connections` : 'Complete source topology, including isolated records.'}</p></div>{state.view === 'overview' && <button onClick={() => navigate('graph')}>Explore full network</button>}</header>{graph}</section>
          {state.view === 'graph' && network && <LabCharts data={network} onFilter={() => {}} />}
          {state.view === 'overview' && <div className="lab-overview-columns"><LabQueue server={server} now={now} preview onSelect={select} /><LabLimitations data={data} /></div>}
        </> : <LabRecords key={`${server}:${state.view}`} server={server} state={state} queryText={queryText} facets={object(data.facets)} now={now} onChange={filter} onSelect={select} onPage={offset => change({ offset: String(offset) }, { clearSelection: true })} />}
      </main>
      {state.selected && state.view !== 'archive' && <ResearchInspector key={`${server}:${state.selected}`} server={server} id={state.selected} onSelect={select} onFindInNetwork={find} onArchiveRecord={id => change({ view: 'archive', archive_record: id, id: '', network_focus: '' }, { resetPage: true })} />}
    </div>
    <details className="quant-panel quant-source-detail"><summary>Index provenance and limitations</summary><p>Projection generated · {labTimestamp(data.generated_at)}</p><p>Pending events · {catalogCount(freshness, 'pending_events') ?? '—'}</p><p>Snapshot · {text(data.source_snapshot)}</p><p>Revision · {text(data.revision)}</p><ul>{(Array.isArray(data.limitations) ? data.limitations : []).filter((value): value is string => typeof value === 'string').map(value => <li key={value}>{value}</li>)}</ul></details>
  </>;
}
