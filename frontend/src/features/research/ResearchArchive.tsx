import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, RefreshCw } from 'lucide-react';
import { authFetch } from '@/lib/auth-token';
import { object, records, text, catalogCount, researchReadState, type RecordData } from './model';
import { readResearch as createReader } from './read';
import { ResearchDocuments } from './ResearchDocument';
import { RawResearchData, ResearchMetadata } from './ResearchInspector';
import { archiveMetricsAvailable, safeSourceUrl, displayResearchValue } from './research-detail';
import { archiveState, updateArchiveParams } from './research-archive';
import './research-archive.css';

const readResearch = createReader(authFetch, 60_000);
const PAGE_SIZE = 30;
function title(record: RecordData) { return text(record.display_title, text(record.title, text(record.native_id, text(record.id)))); }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function recordedCount(value: unknown) { return typeof value === 'number' && value >= 0 && Number.isInteger(value) ? value.toLocaleString() : 'UNAVAILABLE'; }

function ArchiveMetricReadout({ readout }: { readout: RecordData }) {
  const metrics = object(readout.recorded_metrics), matched = archiveMetricsAvailable(readout);
  return <section><h4>Historical source metrics</h4><p>Values retain their source names and units. A matching source hash does not establish economic validity.</p><ResearchMetadata values={{ metrics_state: readout.metrics_state }} />
    {matched ? <>{['economics', 'activity', 'risk'].map(category => <details key={category} open={category === 'economics'}><summary>{category[0].toUpperCase() + category.slice(1)}</summary>{Object.keys(object(metrics[category])).length ? <dl className="research-metadata">{Object.entries(object(metrics[category])).map(([key, value]) => <div key={key} style={{ display: 'contents' }}><dt>{key}</dt><dd>{displayResearchValue(value)}</dd></div>)}</dl> : <p>UNAVAILABLE in the captured metric source.</p>}</details>)}{metrics.unavailable != null && <RawResearchData title="Unavailable in the source" value={metrics.unavailable} />}</> : <p>Metric values are unavailable because a matching frozen source has not been established.</p>}
    {readout.source != null && <RawResearchData title="Metric source identity" value={readout.source} />}
    <h4>Baseline comparison</h4><p>{text(readout.baseline_comparison, 'UNAVAILABLE')}</p><h4>Promotion and authority</h4><ResearchMetadata values={{ recorded_promotion: readout.promotion, recorded_authority: readout.authority }} /><p>These are source-recorded claims. This index grants no paper, canary or live authority.</p>
  </section>;
}

function ArchiveRecord({ server, id, overviewRevision, onSelect }: { server: string; id: string; overviewRevision: string; onSelect: (id: string) => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const query = useQuery({ queryKey: ['research-archive-record', server, id, overviewRevision], queryFn: ({ signal }) => readResearch('archive-record', server, { id }, signal), enabled: !!id, refetchInterval: 30000, retry: 1 });
  const state = researchReadState(query.data, now, query.isError, query.dataUpdatedAt);
  const payload = state === 'available' ? object(query.data?.data) : {};
  const mismatch = overviewRevision && payload.revision && overviewRevision !== payload.revision;
  if (state !== 'available' || mismatch) return <aside className="quant-panel research-inspector"><div className="quant-notice" role={query.isError || mismatch ? 'alert' : 'status'}>{mismatch ? 'The archive revision changed. Refresh the archive before reading this record.' : query.isError ? query.error.message : state === 'stale' ? 'The archive record has not refreshed. Previous details are unavailable.' : 'Loading full archive record…'}{(query.isError || state === 'stale') && <button type="button" onClick={() => void query.refetch()}>Retry record</button>}</div></aside>;
  const raw = object(payload.record), prepared = object(payload.prepared), record = { ...raw, ...prepared };
  const source = object(record.source), aliases = record.source_aliases ?? record.aliases ?? source.aliases;
  const note = record.projection_note ?? object(record.fields).projection_note;
  const relations = Array.isArray(record.relations) ? record.relations : record.relations ? [record.relations] : [];
  const external = safeSourceUrl(source.url);
  return <aside className="quant-panel quant-inspector research-inspector" aria-label="Selected archive record"><header className="quant-panel-heading"><h2>Archive evidence</h2></header><div className="quant-detail-body">
    <p className="quant-record-kind">{text(record.kind)} · {text(record.lane)}</p><h3>{title(record)}</h3>
    <ResearchMetadata values={{ id: record.id, native_id: record.native_id, kind: record.kind, strategy: record.strategy ?? record.family, family: record.family, lane: record.lane, status: record.status ?? record.status_group, recorded_at: record.recorded_at }} />
    <section><h4>Summary</h4><p>{text(record.display_summary, text(record.summary, 'No source summary is available. Inspect the source and native fields.'))}</p></section>
    {record.evidence_readout != null && <ArchiveMetricReadout readout={object(record.evidence_readout)} />}
    <ResearchDocuments key={`${id}:${text(payload.revision, '')}`} server={server} scope="archive" id={id} documents={payload.documents} title="Source evidence" />
    {external && <p><a href={external} target="_blank" rel="noopener noreferrer">Original source URL</a></p>}
    {records(record.links).filter(link => safeSourceUrl(link.path ?? link.url)).length > 0 && <ul className="research-reference-list">{records(record.links).flatMap((link, index) => { const url = safeSourceUrl(link.path ?? link.url); return url ? [<li key={index}><a href={url} target="_blank" rel="noopener noreferrer">{text(link.label, 'Source URL')}</a></li>] : []; })}</ul>}
    <ResearchMetadata values={{ captured_source_sha256: source.sha256, pointer: source.pointer, revision: payload.revision }} />
    <p>The captured hash identifies frozen source bytes. Original-source documents retain their current owner location.</p>
    {relations.length > 0 && <section><h4>Related archive records</h4><ul className="research-reference-list">{relations.map((relation, index) => { const r = object(relation), target = typeof relation === 'string' ? relation : text(r.target, text(r.target_id, text(r.id, ''))); return <li key={`${target}:${index}`}>{target ? <button type="button" onClick={() => onSelect(target)}>{text(r.title, target)}</button> : <span>Unresolved target · {displayResearchValue(relation)}</span>}</li>; })}</ul></section>}
    {note != null && <section><h4>Preview scope</h4><p>{displayResearchValue(note)}</p></section>}
    {aliases != null && <RawResearchData title="Source aliases" value={aliases} />}
    <RawResearchData title="Index fields" value={record.fields ?? {}} /><RawResearchData title="Prepared index record" value={prepared} /><RawResearchData title="Full native record" value={raw} />
  </div></aside>;
}

function ArchiveCoverage({ data, server }: { data: RecordData; server: string }) {
  const preservation = object(data.preservation);
  const keys = ['missing_paths', 'metadata_changed_paths', 'hash_changed_paths', 'unreadable_paths'];
  const complete = keys.every(key => Array.isArray(preservation[key]));
  return <section className="quant-panel"><header className="quant-panel-heading"><h2>Coverage and preservation</h2></header><div className="quant-detail-body">
    <p>Coverage describes the source inventory in this snapshot. Records, files and experiments are distinct counts.</p>
    {complete ? <ResearchMetadata values={Object.fromEntries(keys.map(key => [key.replace('_paths', ''), array(preservation[key]).length]))} /> : <p role="status">Preservation receipt incomplete. Missing receipt fields do not establish that sources were preserved.</p>}
    <ResearchDocuments server={server} scope="receipt" id="archive" documents={data.documents} title="Catalog and evidence files" />
    {['coverage', 'preservation', 'provenance'].map(key => <section key={key}><h3>{key[0].toUpperCase() + key.slice(1)}</h3><ResearchMetadata values={Object.fromEntries(Object.entries(object(data[key])).filter(([, value]) => value === null || typeof value !== 'object'))} /><RawResearchData title={`Complete ${key} receipt`} value={data[key] ?? null} /></section>)}
  </div></section>;
}
function ArchiveNext() {
  return <section className="quant-panel"><header className="quant-panel-heading"><h2>Continue from the evidence</h2></header><div className="quant-detail-body"><p>This archive records research. Use the owner workflow for each new idea or backtest.</p><ol className="research-next-flow">{[
    ['Find the nearest prior work', 'Search the mechanism, family and lane. Read failed attempts, unresolved evidence and superseded decisions before opening a new experiment.'],
    ['Define one falsifiable experiment', 'Keep a stable idea ID. Freeze the baseline, data window, source and code identities, costs, execution assumptions and invalidation criteria. Keep spot and futures accounting separate.'],
    ['Run in the owning repository', 'Use Quants Lab for research execution and Hummingbot for runtime semantics. Record every attempt, including failed, cancelled, skipped and unfinished outcomes.'],
    ['Register the evidence and decision', 'Link structured results, logs, manifests and exact commands. Record historical outcome, valid baseline comparison and promotion status separately. Leave unavailable metrics unavailable.'],
    ['Rebuild and verify the index', 'Validate identities, evidence links, coverage and preservation receipts. Regenerate the projections through the owner workflow before the next iteration.'],
  ].map(([heading, body]) => <li key={heading}><h3>{heading}</h3><p>{body}</p></li>)}</ol></div></section>;
}

export function ResearchArchive({ server }: { server: string }) {
  const [params, setParams] = useSearchParams(), state = archiveState(params);
  const [query, setQuery] = useState(state.q), [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setTimeout(() => setQuery(state.q), 250); return () => clearTimeout(timer); }, [state.q]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const change = (patch: Record<string, string>, reset = true) => setParams(updateArchiveParams(params, patch, reset));
  const overview = useQuery({ queryKey: ['research-archive-overview', server], queryFn: ({ signal }) => readResearch('archive-overview', server, {}, signal), enabled: !!server, refetchInterval: 30000, retry: 1 });
  const list = useQuery({ queryKey: ['research-archive', server, query, state.kind, state.family, state.lane, state.status, state.offset], queryFn: ({ signal }) => readResearch('archive', server, { q: query, kind: state.kind, family: state.family, lane: state.lane, status: state.status, offset: String(state.offset), limit: String(PAGE_SIZE) }, signal), enabled: !!server && state.view === 'explore', refetchInterval: 30000, retry: 1 });
  const overviewState = researchReadState(overview.data, now, overview.isError, overview.dataUpdatedAt), listState = researchReadState(list.data, now, list.isError, list.dataUpdatedAt);
  const data = overviewState === 'available' ? object(overview.data?.data) : {}, listData = listState === 'available' ? object(list.data?.data) : {};
  const revision = text(data.revision, ''), revisionMismatch = !!revision && !!listData.revision && revision !== listData.revision;
  const current = listState === 'available' && !revisionMismatch && query === state.q;
  const items = current ? records(listData.items) : [], total = current ? catalogCount(listData, 'total') : null;
  const selected = state.record || text(items[0]?.id, '');
  const coverage = object(data.coverage), facets = object(listData.facets ?? data.facets);
  const refresh = () => { void overview.refetch(); if (state.view === 'explore') void list.refetch(); };
  return <div className="research-archive">
    <div className="research-archive-toolbar"><nav aria-label="Archive views">{[['explore', 'Explore archive'], ['coverage', 'Coverage and preservation'], ['next', 'Next experiment']].map(([view, label]) => <button type="button" key={view} aria-current={state.view === view ? 'page' : undefined} onClick={() => change({ view }, false)}>{label}</button>)}</nav><button type="button" onClick={refresh} disabled={overview.isFetching || list.isFetching}><RefreshCw size={14} />Refresh archive</button></div>
    {overviewState !== 'available' ? <div className="quant-notice" role={overview.isError ? 'alert' : 'status'}>{overview.isError ? overview.error.message : overviewState === 'stale' ? 'The archive source has not refreshed.' : 'Loading archive snapshot…'}{(overview.isError || overviewState === 'stale') && <button type="button" onClick={refresh}>Retry archive</button>}</div> : <>
      <div className="research-archive-summary"><span><strong>{recordedCount(coverage.records ?? object(data.counts).records)}</strong> records</span><span><strong>{recordedCount(coverage.files_discovered)}</strong> source files</span><span><strong>{recordedCount(coverage.unresolved_count)}</strong> unresolved sources</span><small>Snapshot {text(data.generated_at)} · {revision.slice(0, 12) || 'Revision unavailable'}</small></div>
      {state.view === 'coverage' ? <ArchiveCoverage data={data} server={server} /> : state.view === 'next' ? <ArchiveNext /> : <div className="quant-research-layout">
        <section className="quant-panel"><header className="quant-panel-heading"><h2>Historical archive</h2><span>{total === null ? 'Waiting for source' : `${total.toLocaleString()} matching records`}</span></header>
          <form className="quant-filters" role="search" onSubmit={event => event.preventDefault()}><label className="quant-search"><Search size={15} /><input type="search" aria-label="Search the archive" placeholder="Search records, ideas or evidence…" maxLength={200} value={state.q} onChange={event => change({ q: event.target.value })} /></label>
            {['kind', 'family', 'lane', 'status'].map(key => <label key={key}>{key === 'status' ? 'Status group' : key[0].toUpperCase() + key.slice(1)}<select aria-label={`Archive ${key}`} value={state[key as 'kind' | 'family' | 'lane' | 'status']} onChange={event => change({ [key]: event.target.value })}><option value="">All</option>{array(facets[key] ?? facets[`${key}s`]).filter((value): value is string => typeof value === 'string').map(value => <option key={value} value={value}>{value}</option>)}</select></label>)}
            <button type="button" onClick={() => change({ q: '', kind: '', family: '', lane: '', status: '' })}>Reset filters</button>
          </form>
          {!current ? <div className="quant-notice" role={list.isError || revisionMismatch ? 'alert' : 'status'}>{revisionMismatch ? 'The archive changed during this read. Refresh to load one consistent revision.' : list.isError ? list.error.message : listState === 'stale' ? 'The archive records have not refreshed.' : 'Loading matching records…'}{(list.isError || listState === 'stale' || revisionMismatch) && <button type="button" onClick={refresh}>Retry records</button>}</div> : !items.length ? <div className="quant-notice" role="status">No archive records match. Clear a filter or try a broader search.</div> : <div className="quant-table-scroll"><table><thead><tr><th>Record</th><th>Family and lane</th><th>Status</th></tr></thead><tbody>{items.map(record => <tr key={text(record.id)} aria-selected={record.id === selected}><td><button type="button" className="quant-record-link" onClick={() => change({ record: text(record.id, '') }, false)}>{title(record)}</button><small>{text(record.kind)} · {text(record.native_id, text(record.id))}</small></td><td>{text(record.strategy, text(record.family))}<small>{text(record.lane)}</small></td><td>{text(record.status_group, text(record.status))}</td></tr>)}</tbody></table></div>}
          <footer className="quant-pagination"><span>{total === null ? '' : total === 0 || state.offset >= total ? `0 of ${total.toLocaleString()}` : `${state.offset + 1}–${Math.min(state.offset + PAGE_SIZE, total)} of ${total.toLocaleString()}`}</span><button type="button" disabled={state.offset === 0 || list.isFetching} onClick={() => change({ offset: String(Math.max(0, state.offset - PAGE_SIZE)), record: '' }, false)}>Previous</button><button type="button" disabled={total === null || state.offset + PAGE_SIZE >= total || state.offset + PAGE_SIZE > 1_000_000 || list.isFetching} onClick={() => change({ offset: String(state.offset + PAGE_SIZE), record: '' }, false)}>Next</button></footer>
        </section>
        {selected && current ? <ArchiveRecord key={`${server}:${selected}`} server={server} id={selected} overviewRevision={revision} onSelect={id => change({ record: id }, false)} /> : <aside className="quant-panel"><div className="quant-notice">Select a record to inspect its preserved evidence.</div></aside>}
      </div>}
    </>}
  </div>;
}
