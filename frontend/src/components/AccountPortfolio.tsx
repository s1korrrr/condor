import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowDownUp, Download, ExternalLink, KeyRound, RefreshCw, Search, X } from 'lucide-react';
import { useServer } from '@/hooks/useServer';
import { api } from '@/lib/api';
import { containDialogTab } from '@/lib/dialog-focus';
import { filterHoldings, holdingsCsv, portfolioSummary, valueChange } from '@/features/portfolio/model';
import type { Holding, PortfolioRange, SortKey } from '@/features/portfolio/model';
import { AllocationChart, ValueHistoryChart } from '@/features/portfolio/PortfolioCharts';

import {formatValue, utc} from '@/features/portfolio/format';

const panel='rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5';
const control='inline-flex items-center justify-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs hover:bg-[var(--color-surface-hover)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]';
function download(name:string,content:string) {
  const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8;'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();URL.revokeObjectURL(url);
}

function AssetDetail({holding,close}: {holding:Holding;close:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>dialog?.close();},[]);
  return <dialog ref={ref} onCancel={close} onClose={close} onKeyDown={containDialogTab} aria-labelledby="portfolio-asset-title" className="m-auto w-[min(92vw,560px)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-[var(--color-text)] shadow-xl backdrop:bg-black/70">
    <div className="mb-6 flex items-center justify-between"><div><h2 id="portfolio-asset-title" className="text-xl font-semibold">{holding.token}</h2><p className="mt-1 text-xs text-[var(--color-text-muted)]">OKX Spot · account holding</p></div><button type="button" onClick={close} className={control} aria-label="Close asset details"><X size={16}/></button></div>
    <dl className="space-y-3 text-sm">{[['Total units',holding.total],['Available units',holding.available],['Locked units',holding.locked],['Price · USDT',holding.price],['Market value · USDT',holding.value],['Price source',holding.valuation_source==='okx_spot_last_trade'?'OKX spot · last trade':holding.valuation_source==='quote_currency'?'Reporting unit':holding.valuation_source],['Price read · UTC',holding.price_observed_at?utc(holding.price_observed_at):null]].map(([label,value])=><div key={label} className="flex justify-between gap-6 border-b border-[var(--color-border)] pb-3"><dt className="text-[var(--color-text-muted)]">{label}</dt><dd className="break-all text-right tabular-nums">{value??'Unavailable'}</dd></div>)}</dl>
    <p className="mt-5 text-xs leading-relaxed text-[var(--color-text-muted)]">Cost basis and unrealized P&amp;L require reconciled acquisition history. Available balance is exchange-reported availability, not a bot capital allocation.</p>
    <Link onClick={close} to="/trading-visuals" className={`${control} mt-5`}>Inspect bot execution records <ExternalLink size={13}/></Link>
  </dialog>;
}

export function AccountPortfolio() {
  const {server}=useServer();
  return server ? <PortfolioAccount key={server} server={server}/> : <p className="p-8 text-sm text-[var(--color-text-muted)]">Select a server to view its portfolio.</p>;
}

function PortfolioAccount({server}: {server:string}) {
  const [view,setView]=useState<'holdings'|'history'>('holdings');
  const [range,setRange]=useState<PortfolioRange>('1W');
  const [search,setSearch]=useState('');
  const [sort,setSort]=useState<{key:SortKey;direction:'asc'|'desc'}>({key:'value',direction:'desc'});
  const [selected,setSelected]=useState<string|null>(null);
  const [now,setNow]=useState(Date.now);
  const forceRefresh=useRef(false);
  const [refreshing,setRefreshing]=useState(false);
  const query=useQuery({queryKey:['portfolio-analytics',server,range],queryFn:async()=>{try{return await api.getPortfolioAnalytics(server,range,forceRefresh.current);}finally{forceRefresh.current=false;}},refetchInterval:15000,retry:1});
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  const failed=!!query.error;
  const data=failed?undefined:query.data;
  const summary=portfolioSummary(data?.current??null,Math.max(now,query.dataUpdatedAt),failed);
  const holdings=summary.current?data!.current!.holdings:[];
  const rows=filterHoldings(holdings,search,sort.key,sort.direction);
  const chosen=holdings.find(h=>h.token===selected);
  const first=data?.history?.first_observed_at;
  const change=valueChange(data?.history?.points??[]);
  const refresh=async()=>{
    setRefreshing(true);
    forceRefresh.current=true;
    try {await query.refetch();} finally {setRefreshing(false);}
  };
  const sortBy=(key:SortKey)=>setSort({key,direction:sort.key===key&&sort.direction==='desc'?'asc':'desc'});
  const metric=(label:string,value:string,note:string)=><div className="min-w-0"><dt className="text-xs text-[var(--color-text-muted)]">{label}</dt><dd className="mt-2 break-words text-xl font-semibold tabular-nums sm:text-2xl">{value}</dd><p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{note}</p></div>;
  return <div className="min-w-0 space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1><p className="mt-1 text-sm text-[var(--color-text-muted)]">Account holdings and valuation · OKX Spot · USDT</p></div>
      <div className="flex gap-2"><Link to="/settings?tab=keys" className={control}><KeyRound size={14}/>Connections</Link><button type="button" onClick={()=>void refresh()} disabled={refreshing||query.isFetching} className={`${control} bg-[var(--color-primary)] text-[var(--color-bg)]`}><RefreshCw size={14} className={refreshing?'animate-spin motion-reduce:animate-none':''}/>Refresh</button></div>
    </header>
    <nav aria-label="Portfolio views" className="flex gap-6 border-b border-[var(--color-border)]">{(['holdings','history'] as const).map(tab=><button type="button" key={tab} aria-current={view===tab?'page':undefined} onClick={()=>setView(tab)} className={`border-b-2 px-1 py-3 text-sm capitalize ${view===tab?'border-[var(--color-primary)] text-[var(--color-primary)]':'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>{tab}</button>)}</nav>
    {failed&&<div role="alert" className="rounded-md border border-[var(--color-red)]/40 p-4 text-sm"><p>Portfolio could not be refreshed. Current values and history are hidden until a successful read.</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">Check the account connection and that the API supports portfolio analytics, then use Refresh.</p></div>}
    {query.isLoading&&<p role="status" className="py-16 text-center text-sm text-[var(--color-text-muted)]">Loading portfolio observations…</p>}
    {data&&!data.current&&<div className={`${panel} py-12 text-center`}><h2 className="text-lg font-medium">Connect your account</h2><p className="mx-auto mt-2 max-w-lg text-sm text-[var(--color-text-muted)]">Connect OKX in Settings to see holdings and begin recording portfolio observations.</p><Link to="/settings?tab=keys" className={`${control} mt-5`}>Open Connections</Link></div>}
    {data?.current&&data.scope&&data.history&&<>
      {!summary.current&&<p role="status" className="border-l-2 border-[var(--color-yellow)] pl-3 text-sm">The current balance observation is stale. Refresh to view current holdings. Retained history remains historical.</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]"><span>{data.scope.account} · {data.scope.connector} · {summary.current?'Observed':'Last observation'} {utc(data.current.observed_at)} UTC</span><span>{first?`Recording since ${utc(first)} UTC`:'No recorded history'}</span></div>
      {view==='holdings'?<>
        {summary.current&&<>
        <dl className={`${panel} grid grid-cols-2 gap-6 lg:grid-cols-4`}>
          {metric(summary.complete?'Account value':'Priced assets value',formatValue(summary.pricedTotal),'USDT · last traded spot prices')}
          {metric('Available value',formatValue(summary.availableValue),summary.complete?'USDT · exchange available':'USDT · priced assets only')}
          {metric('Locked value',formatValue(summary.lockedValue),summary.complete?'USDT · total minus available':'USDT · priced assets only')}
          {metric('Valuation coverage',summary.current?`${holdings.length-summary.unpricedCount} / ${holdings.length}`:'Unavailable','Valued assets or zero inventory')}
        </dl>
          <section className={panel}><AllocationChart data={summary.allocation} complete={summary.complete} onSelect={setSelected}/></section>
          <section className={`${panel} !px-0`}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5"><h2 className="text-base font-semibold">Holdings <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">{rows.length} {rows.length===1?'asset':'assets'}</span></h2><div className="flex max-w-full flex-wrap gap-2"><label className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-3"><Search size={14} className="text-[var(--color-text-muted)]"/><input aria-label="Search holdings" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search assets…" className="w-36 bg-transparent py-2 text-xs outline-none focus:w-40"/></label><button type="button" className={control} onClick={()=>download('portfolio-holdings.csv',holdingsCsv(rows))} disabled={!rows.length}><Download size={14}/>Export</button></div></div>
            <div className="overflow-x-auto"><table className="w-full text-right text-xs tabular-nums"><caption className="sr-only">Account holdings. Prices and values in USDT. Select an asset for exact amounts and source.</caption><thead className="border-y border-[var(--color-border)] bg-[var(--color-bg)]/40 text-[var(--color-text-muted)]"><tr>{([['token','Asset'],['total','Total'],['available','Available'],['locked','Locked'],['price','Price · USDT'],['value','Value · USDT']] as const).map(([key,label])=><th scope="col" key={key} aria-sort={sort.key===key?(sort.direction==='asc'?'ascending':'descending'):'none'} className={`whitespace-nowrap px-4 py-3 font-normal ${key==='token'?'text-left':''}`}><button type="button" onClick={()=>sortBy(key)} className="inline-flex items-center gap-2">{label}<ArrowDownUp size={11}/></button></th>)}<th scope="col" className="px-4 py-3 font-normal">Weight</th></tr></thead><tbody>{rows.map(h=><tr key={h.token} className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-surface-hover)]"><th scope="row" className="px-4 py-4 text-left"><button type="button" onClick={()=>setSelected(h.token)} className="font-semibold text-[var(--color-primary)] hover:underline">{h.token}</button></th>{[h.total,h.available,h.locked].map((v,i)=><td key={i} className="whitespace-nowrap px-4 py-4" title={v}>{Number(v).toLocaleString(undefined,{maximumFractionDigits:8})}</td>)}<td className="whitespace-nowrap px-4 py-4">{h.price===null?'Unavailable':Number(h.price).toLocaleString(undefined,{maximumSignificantDigits:8})}</td><td className="whitespace-nowrap px-4 py-4">{formatValue(h.value===null?null:Number(h.value))}</td><td className="whitespace-nowrap px-4 py-4">{summary.complete&&summary.pricedTotal!>0?`${(Number(h.value)/summary.pricedTotal!*100).toFixed(1)}%`:'—'}</td></tr>)}</tbody></table></div>
            {!rows.length&&<p className="p-8 text-center text-sm text-[var(--color-text-muted)]">{holdings.length?'No assets match your search.':'This account has no recorded holdings.'}</p>}
          </section>
        </>}
      </>:<>
        <section className={panel}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-[var(--color-text-muted)]">{data.history.points.length} retained observations{data.history.truncated?' · latest observations only':''}</p><div className="flex flex-wrap gap-1" aria-label="History period">{(['1D','1W','1M','3M','ALL'] as const).map(r=><button type="button" key={r} aria-pressed={range===r} onClick={()=>setRange(r)} className={`${control} ${range===r?'border-[var(--color-primary)] text-[var(--color-primary)]':''}`}>{r}</button>)}</div></div>
          <ValueHistoryChart points={data.history.points}/>
          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t border-[var(--color-border)] pt-4 text-xs"><span>Comparable value change: <strong className="tabular-nums">{formatValue(change)}{change!==null?' USDT':''}</strong></span><span className="text-[var(--color-text-muted)]">{data.history.gaps.length} recorded {data.history.gaps.length===1?'gap':'gaps'} · observation-driven capture</span></div>
          <details className="mt-4 text-xs"><summary className="cursor-pointer text-[var(--color-text-muted)]">Exact valuation observations</summary><div className="mt-3 max-h-64 overflow-auto"><table className="w-full text-left tabular-nums"><thead><tr><th className="py-2">Observed · UTC</th><th>Priced assets · USDT</th><th>Coverage</th></tr></thead><tbody>{data.history.points.map(p=><tr key={p.observed_at} className="border-t border-[var(--color-border)]"><td className="py-2 pr-4">{utc(p.observed_at)}</td><td>{p.priced_total}</td><td>{p.valuation_complete?'Complete':`Unpriced: ${p.unpriced_assets.join(', ')}`}</td></tr>)}</tbody></table></div></details>
        </section>
        <section className={panel}><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-base font-semibold">Observed balance changes</h2><Link to="/trading-visuals" className="text-xs text-[var(--color-primary)] hover:underline">Bot fills and execution history ↗</Link></div><p className="mt-2 text-xs leading-relaxed text-[var(--color-text-muted)]">Differences between account observations, not classified transactions. A change may combine trades, transfers, fees, deposits or withdrawals. Latest 200 changes in the selected period.</p>
          {data.changes.length?<div className="mt-4 max-h-80 overflow-auto"><table className="w-full whitespace-nowrap text-right text-xs tabular-nums"><thead><tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">{['Observed · UTC','Asset','Previous units','Current units','Change in units'].map(h=><th key={h} className="px-3 py-3 font-normal first:text-left">{h}</th>)}</tr></thead><tbody>{data.changes.map((c,i)=><tr key={`${c.observed_at}-${c.token}-${i}`} className="border-b border-[var(--color-border)]"><td className="px-3 py-3 text-left">{utc(c.observed_at)}</td><td className="px-3 py-3">{c.token}</td><td className="px-3 py-3">{c.previous_total}</td><td className="px-3 py-3">{c.total}</td><td className="px-3 py-3">{Number(c.delta)>0?'+':''}{c.delta}</td></tr>)}</tbody></table></div>:<p className="py-8 text-sm text-[var(--color-text-muted)]">No balance differences were recorded in this period.</p>}
        </section>
      </>}
      <details className={`${panel} text-xs`}><summary className="cursor-pointer text-sm font-medium">Data coverage and calculation methods</summary><div className="mt-4 max-w-4xl space-y-3 leading-relaxed text-[var(--color-text-muted)]"><p>{data.performance.reason}</p><p>Valuation uses last traded OKX spot prices in USDT. USDT is the reporting unit; it is not assumed to equal USD. Unpriced assets stay visible. Available and locked value use the same prices as the holdings table.</p><p>History is stored by the account service when observations are requested. It survives service restarts but does not imply continuous recording with the dashboard closed. Earlier account history is not reconstructed from bot records.</p><p>Returns, drawdown, cost basis and contribution statistics become available only after account cash flows and acquisition history are reconciled. Bot-level metrics remain in Bots and Trading Visuals.</p></div></details>
    </>}
    {chosen&&<AssetDetail holding={chosen} close={()=>setSelected(null)}/>}
  </div>;
}
