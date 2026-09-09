import { useQuery } from '@tanstack/react-query';
import { authFetch } from '@/lib/auth-token';
import { readResearch } from './read';
import { object, text, records, catalogCount, researchReadState, type RecordData } from './model';
import { researchPage, RESEARCH_PAGE_SIZE } from './library';
import { labContext, labTimestamp, type LabState } from './lab-state';
import { ResearchDocuments } from './ResearchDocument';
import { ResearchRecommendations, ResearchMetadata, RawResearchData, ResearchReferences } from './ResearchInspector';

const read = readResearch(authFetch);
export function LabFilters({ state, facets, onChange, gaps = false }: { state: LabState; facets: RecordData; gaps?: boolean; onChange(values: Record<string, string>): void }) {
  const options = (key: string) => (Array.isArray(facets[key]) ? facets[key] : []).filter((v): v is string => typeof v === 'string');
  return <div className="quant-filters"><label className="quant-search"><input type="search" aria-label="Search research" placeholder={gaps ? 'Search missing evidence and references…' : 'Search ideas, hypotheses, evidence…'} value={state.q} maxLength={200} onChange={e => onChange({ q: e.target.value })} /></label>
    {gaps ? <label>Gap type<select aria-label="Gap type" value={state.gap_kind} onChange={e => onChange({ gap_kind: e.target.value })}><option value="">All evidence gaps</option><option value="recorded_gap">Recorded gaps</option><option value="unresolved_edge">Unresolved edges</option></select></label> : <>{(['lane', 'family'] as const).map(key => <label key={key}>{key === 'lane' ? 'Lane' : 'Family'}<select aria-label={key === 'lane' ? 'Lane' : 'Family'} value={state[key]} onChange={e => onChange({ [key]: e.target.value })}><option value="">All {key === 'lane' ? 'lanes' : 'families'}</option>{options(key === 'lane' ? 'lanes' : 'families').map(value => <option key={value}>{value}</option>)}</select></label>)}</>}
  </div>;
}
export function LabQueue({ server, onSelect, now, preview = false }: { server: string; onSelect(id: string): void; now: number; preview?: boolean }) {
  const query = useQuery({ queryKey: ['research-queue-preview', server], queryFn: ({ signal }) => read('queue', server, { limit: '6', offset: '0' }, signal), enabled: !!server, refetchInterval: 30000, retry: 1 });
  const state = researchReadState(query.data, now, query.isError, query.dataUpdatedAt);
  return <section className="quant-panel"><header className="quant-panel-heading"><h2>{preview ? 'Next evidence checks' : 'Research queue'}</h2></header><div className="lab-list-body">{state === 'available' ? <><LabRecommendations server={server} items={records(query.data?.data.items)} onSelect={onSelect} /><p className="quant-muted">{text(query.data?.data.basis, 'Recorded evidence checks.')}</p></> : <LabReadNotice state={state} error={query.error} onRetry={() => void query.refetch()} />}</div></section>;
}
export function LabReadNotice({ state, error, onRetry }: { state: string; error: Error | null; onRetry(): void }) {
  return <div className="quant-notice" role={error ? 'alert' : 'status'}>{error ? error.message : state === 'stale' ? 'The source has not refreshed. Previous records are unavailable.' : 'Loading research records…'}{(error || state === 'stale') && <button onClick={onRetry}>Retry records</button>}</div>;
}
export function LabRecords({ server, state, queryText, facets, now, onChange, onSelect, onPage }: {
  server: string; state: LabState; queryText: string; facets: RecordData; now: number;
  onChange(values: Record<string, string>): void; onSelect(id: string): void; onPage(offset: number): void;
}) {
  const gaps = state.view === 'gaps', queue = state.view === 'queue';
  const endpoint = gaps ? 'unresolved' : queue ? 'queue' : state.view === 'learning' ? 'learning' : 'nodes';
  const kind = state.view === 'papers' ? 'paper' : state.view === 'experiments' ? 'experiment' : 'idea';
  const list = useQuery({ queryKey: ['research-lab-records', server, endpoint, kind, queryText, state.family, state.lane, state.gap_kind, state.offset],
    queryFn: ({ signal }) => read(endpoint, server, { q: queryText, ...(gaps ? { kind: state.gap_kind } : { lane: state.lane, family: state.family, ...(endpoint === 'nodes' ? { kind } : {}) }), limit: String(RESEARCH_PAGE_SIZE), offset: String(state.offset) }, signal),
    enabled: !!server, refetchInterval: 30000, retry: 1,
  });
  const status = researchReadState(list.data, now, list.isError, list.dataUpdatedAt), data = status === 'available' ? object(list.data?.data) : {};
  const total = catalogCount(data, 'total'), items = records(data.items), page = researchPage(state.offset, total);
  const title = gaps ? 'Evidence gaps' : queue ? 'Research queue' : state.view === 'learning' ? 'Research loop' : state.view === 'papers' ? 'Paper library' : state.view === 'experiments' ? 'Experiments' : 'Ideas';
  return <section className="quant-panel lab-records"><header className="quant-panel-heading"><h2>{title}</h2><span>{total === null ? 'Waiting for source' : `${total.toLocaleString()} ${data.bounded === true ? 'bounded candidates' : 'matching records'}`}</span></header><LabFilters state={state} facets={facets} gaps={gaps} onChange={onChange} />
    {gaps && <p className="lab-view-note">Missing evidence and linkage describe research gaps. They do not classify an idea as successful, failed or untested.</p>}
    {queue && <p className="lab-view-note">{text(data.basis, 'Suggestions are grounded in recorded evidence gaps.')} {data.total_scope === 'bounded_candidates' ? 'This is the bounded candidate queue, not the entire catalog.' : ''}</p>}
    {status !== 'available' ? <LabReadNotice state={status} error={list.error} onRetry={() => void list.refetch()} /> : !items.length ? <p className="quant-notice" role="status">No records match these filters.</p> : queue ? <div className="lab-list-body"><LabRecommendations server={server} items={items} onSelect={onSelect} /></div> : gaps ? <LabGaps server={server} items={items} onSelect={onSelect} /> : <div className="quant-table-scroll"><table><thead><tr><th>Record</th><th>Lane</th><th>{state.view === 'ideas' ? 'Distinct experiments' : 'Recorded status'}</th><th>Recorded date</th></tr></thead><tbody>{items.map(node => <tr key={text(node.id)} aria-selected={node.id === state.selected}><td><button className="quant-record-link" onClick={() => onSelect(text(node.id, ''))}>{text(node.title, text(node.id))}</button><small>{text(node.kind)} · {text(node.family, 'No family')}</small>{labContext(node) && <p className="lab-record-context">{labContext(node)}</p>}</td><td>{text(node.lane)}</td><td>{state.view === 'ideas' ? catalogCount(object(node.usage), 'experiments')?.toLocaleString() ?? 'Unavailable' : text(node.status)}</td><td>{labTimestamp(node.recorded_at)}{Date.parse(text(node.recorded_at, '')) > now + 300000 && <small>Future-dated source</small>}</td></tr>)}</tbody></table></div>}
    <footer className="quant-pagination"><span>{total === null ? '' : `${page.first}–${page.last} of ${total.toLocaleString()}`}</span><button disabled={state.offset === 0 || list.isFetching} onClick={() => onPage(Math.max(0, state.offset - RESEARCH_PAGE_SIZE))}>Previous</button><button disabled={page.nextOffset === null || list.isFetching} onClick={() => page.nextOffset !== null && onPage(page.nextOffset)}>Next</button></footer>{page.boundaryReached && <p className="quant-notice" role="status">The source pagination limit has been reached. Narrow the search or filters to browse remaining records.</p>}
  </section>;
}
function LabGaps({ server, items, onSelect }: { server: string; items: RecordData[]; onSelect(id: string): void }) {
  return <div className="quant-table-scroll"><table><thead><tr><th>Missing evidence</th><th>Source and provenance</th><th>Reference</th></tr></thead><tbody>{items.map(item => <tr key={text(item.id)}><td><strong>{text(item.reason)}</strong><small>{text(item.kind).replaceAll('_', ' ')}</small></td><td>{typeof item.node_id === 'string' && item.node_id ? <button className="quant-record-link" onClick={() => onSelect(text(item.node_id, ''))}>{text(item.title, item.node_id)}</button> : <span>{text(item.title, text(item.source))}</span>}<details><summary>Provenance</summary><ResearchMetadata values={object(item.provenance)} /><p>{text(item.origin)}</p></details><LabItemDocuments server={server} item={item} /></td><td><RawResearchData title="Recorded reference" value={item.reference} />{Array.isArray(item.evidence_refs) && <ResearchReferences references={item.evidence_refs} onSelect={onSelect} />}</td></tr>)}</tbody></table></div>;
}

function LabItemDocuments({ server, item }: { server: string; item: RecordData }) {
  const scope = item.document_scope, id = text(item.document_id, '');
  if (!id || (scope !== 'node' && scope !== 'receipt' && scope !== 'archive')) return null;
  return <ResearchDocuments server={server} scope={scope} id={id} documents={item.documents} />;
}
function LabRecommendations({ server, items, onSelect }: { server: string; items: RecordData[]; onSelect(id: string): void }) {
  if (!items.length) return <ResearchRecommendations items={[]} onSelect={onSelect} />;
  return <>{items.map((item, index) => <div key={text(item.id, String(index))}><ResearchRecommendations items={[item]} onSelect={onSelect} /><LabItemDocuments server={server} item={item} /></div>)}</>;
}
