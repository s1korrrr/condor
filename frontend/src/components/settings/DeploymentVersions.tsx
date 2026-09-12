import {useQuery} from '@tanstack/react-query';
import {authFetch} from '@/lib/auth-token';

type Component = {id:string;name:string;image_id:string;source_manifest:string;commit:string|null;started_at:string};
type Receipt = {recorded:false;reason:string} | {recorded:true;observed_at:string;components:Component[];release:{root_commit:string;condor_commit:string;api_commit:string;deployed_at:string};pending:{component:string;reason:string}[]};
const timestamp=(value:string)=>new Date(value).toLocaleString('en-GB',{timeZone:'UTC'})+' UTC';
export function DeploymentVersions() {
  const query=useQuery({queryKey:['deployment-observation'],queryFn:async({signal}):Promise<Receipt>=>{
    const response=await authFetch('/api/v1/deployment',{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),cache:'no-store'});
    if(!response.ok) throw new Error(response.status===403 ? 'Administrator access is required to inspect deployment versions.' : 'Deployment details could not be verified. Retry after the deployment receipt is checked.');
    return response.json();
  },retry:false});
  return <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 space-y-4">
    <header className="flex items-center justify-between gap-3"><h2 className="font-semibold">Application versions</h2><button className="text-sm text-[var(--color-primary)] disabled:opacity-50" disabled={query.isFetching} onClick={()=>void query.refetch()}>{query.isFetching?'Reading…':'Refresh receipt'}</button></header>
    {query.isPending ? <p role="status" className="text-sm">Reading verified deployment details…</p> : query.isError ? <p role="alert" className="text-sm">{query.error.message}</p> : query.data?.recorded ? <>
      <p className="text-xs text-[var(--color-text-muted)]">Last verified {timestamp(query.data.observed_at)}. Application services only; infrastructure images are outside this receipt. This records inspected running images at that time; it is not a continuous update check.</p>
      <div className="divide-y divide-[var(--color-border)]">{query.data.components.map(component=><details key={component.id} className="py-3"><summary className="cursor-pointer flex flex-wrap justify-between gap-2 text-sm"><span>{component.name}</span><code>{component.commit ? component.commit.slice(0,12) : component.image_id.slice(0,19)}</code></summary><dl className="mt-3 space-y-2 text-xs">{[['Image',component.image_id],['Source manifest',component.source_manifest],...(component.commit ? [['Source commit',component.commit]] : []),['Started',timestamp(component.started_at)]].map(([key,value])=><div key={key} className="grid gap-1 sm:grid-cols-[8rem_1fr]"><dt className="text-[var(--color-text-muted)]">{key}</dt><dd className="break-all font-mono">{value}</dd></div>)}</dl></details>)}</div>
      {query.data.pending.length>0 && <div className="text-sm"><h3 className="font-medium mb-2">Pending components</h3><ul className="space-y-2">{query.data.pending.map((item,i)=><li key={i}><strong>{item.component}</strong> · {item.reason}</li>)}</ul></div>}
      <details className="text-xs"><summary className="cursor-pointer">Release source references</summary><dl className="mt-3 space-y-2">{Object.entries(query.data.release).map(([key,value])=><div key={key} className="break-all"><dt className="text-[var(--color-text-muted)]">{key.replaceAll('_',' ')}</dt><dd className="font-mono">{value}</dd></div>)}</dl></details>
    </> : <p role="status" className="text-sm">{query.data?.reason ?? 'Deployment details have not been recorded.'}</p>}
  </section>;
}
