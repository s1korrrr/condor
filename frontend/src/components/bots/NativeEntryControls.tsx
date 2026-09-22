import {skipToken, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useState} from 'react';
import {authFetch} from '@/lib/auth-token';
import {getSessionSnapshot, sessionRevision} from '@/lib/auth-session';
import {clearPendingEntryCommand, entryCommandObserved, entryLabels, entryObservation, entryPath, entryPendingStorageKey, entryPublicationMessage, readPendingEntryCommand, writePendingEntryCommand, type EntryAction, type EntryCommand, type EntryPendingRead, type EntryPendingStorage} from '@/lib/native-entry-controls';

type Session = {command:EntryCommand|null; message:string};

function browserPendingStorage():EntryPendingStorage|null {
  if(typeof window==='undefined')return null;
  try{return window.sessionStorage;}catch{return null;}
}

export function NativeEntryControls({server,botName}:{server:string;botName:string}) {
  const client=useQueryClient();
  const [now,setNow]=useState(Date.now);
  const [confirmation,setConfirmation]=useState<EntryAction|null>(null);
  const [authRevision]=useState(sessionRevision);
  const [sessionUserId]=useState(()=>getSessionSnapshot().user?.id??null);
  const key=['native-entry-session',server,botName];
  const pendingKey=sessionUserId?entryPendingStorageKey(server,botName,sessionUserId):null;
  const [restored]=useState<EntryPendingRead>(()=>pendingKey
    ?readPendingEntryCommand(browserPendingStorage(),pendingKey)
    :{status:'empty',command:null});
  const session=useQuery<Session>({queryKey:key,queryFn:skipToken,enabled:false,gcTime:Infinity,
    initialData:restored.command
      ?{command:restored.command,message:'Pending native command restored after reload; waiting for matching owner state.'}
      :restored.status==='invalid'
        ?{command:null,message:'Stored pending native command is malformed; entry controls fail closed.'}
        :undefined});
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  const status=useQuery({queryKey:['native-entry-status',server,botName],queryFn:async()=>{
    const response=await authFetch(entryPath(server,botName,'status'),{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok) throw new Error(`Native entry state unavailable (${response.status}).`);
    return response.json() as Promise<unknown>;
  },refetchInterval:5000,retry:false});
  // Both samples use the browser clock. A query can publish between timer
  // ticks; its receipt is then the newer local clock sample for this render.
  const observationNow=Math.max(now,status.dataUpdatedAt);
  const view=entryObservation(status.isError?undefined:status.data,botName,observationNow,status.dataUpdatedAt);
  const command=session.data?.command;
  const commandId=command?.id;
  const observed=!!command && entryCommandObserved(status.isError?undefined:status.data,botName,observationNow,status.dataUpdatedAt,command);
  const waiting=!!command && !observed;
  useEffect(()=>{
    if(!observed || !commandId)return;
    client.setQueryData<Session>(['native-entry-session',server,botName],{
      command:null,message:'Matching command ID and entry state observed from the native owner.'});
    if(pendingKey)clearPendingEntryCommand(browserPendingStorage(),pendingKey);
  },[botName,client,commandId,observed,pendingKey,server]);
  const setSession=(next:Session,requirePendingWrite=false)=>{
    if(next.command){
      const persisted=!!pendingKey && writePendingEntryCommand(browserPendingStorage(),pendingKey,next.command);
      if(requirePendingWrite && !persisted)return false;
    }else if(pendingKey){
      clearPendingEntryCommand(browserPendingStorage(),pendingKey);
    }
    client.setQueryData<Session>(key,next);
    return true;
  };
  const mutation=useMutation({retry:false,mutationFn:async(action:EntryAction)=>{
    const latest=client.getQueryData<Session>(key);
    if(authRevision!==sessionRevision() || !entryObservation(status.isError?undefined:status.data,botName,Date.now(),status.dataUpdatedAt).allowed
      || (latest?.command && !entryCommandObserved(status.data,botName,Date.now(),status.dataUpdatedAt,latest.command))) {
      return {status:409,body:{detail:'Fresh matching native state is required before another command.'}};
    }
    const next={id:crypto.randomUUID(),action};
    if(!setSession({command:next,message:'Submitting to the registered native owner…'},true)){
      return {status:409,body:{detail:'Browser session storage unavailable; native command was not submitted.'}};
    }
    const response=await authFetch(entryPath(server,botName,action),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command_id:next.id}),signal:AbortSignal.timeout(20000)});
    return {status:response.status,body:await response.json() as unknown};
  },onSuccess:result=>{
    if(authRevision!==sessionRevision())return;
    const outcome=entryPublicationMessage(result.status,result.body);
    const prior=client.getQueryData<Session>(key);
    setSession({command:outcome.rejected?null:prior?.command??null,message:outcome.text});
  },onError:()=>{
    if(authRevision!==sessionRevision())return;
    const prior=client.getQueryData<Session>(key);
    setSession({command:prior?.command??null,message:'Publication outcome unknown. Await matching native state before retrying.'});
  },onSettled:()=>{setConfirmation(null);if(authRevision===sessionRevision())void client.invalidateQueries({queryKey:['native-entry-status',server,botName]});}});
  const disabled=!view.allowed || waiting || mutation.isPending || restored.status==='invalid';
  return <section className="mt-3 max-w-xl rounded border border-[var(--color-border)] p-3" aria-label={`Entry controls for ${botName}`}>
    <h4 className="text-sm font-medium">New entries</h4>
    <p className="mt-1 text-xs text-[var(--color-text-muted)]">Entry pause leaves native protective exits running. Daily-loss acknowledgement requires the next UTC day.</p>
    {view.valid ? <ul className="my-2 text-xs">{view.rows.map(row=><li key={String(row.controller_id)}>{String(row.controller_id)}: {row.entry_paused?'Paused':'Not paused'}{typeof row.pause_reason==='string' && row.pause_reason?` · ${row.pause_reason}`:''}</li>)}</ul> : <p role="status" className="my-2 text-xs">{status.isError?'Native entry controls are unavailable for this owner.':'Waiting for fresh native entry state…'}</p>}
    <div className="flex flex-wrap gap-2">{confirmation ? <>
      <span className="text-xs">{entryLabels[confirmation]} for {botName}?</span>
      <button type="button" disabled={disabled} onClick={()=>mutation.mutate(confirmation)} className="rounded border px-3 py-1 text-xs disabled:opacity-40">Confirm {entryLabels[confirmation].toLowerCase()}</button>
      <button type="button" disabled={mutation.isPending} onClick={()=>setConfirmation(null)} className="px-2 text-xs">Cancel</button>
    </> : (Object.keys(entryLabels) as EntryAction[]).map(action=><button type="button" key={action} disabled={disabled} onClick={()=>setConfirmation(action)} className="rounded border px-3 py-1 text-xs disabled:opacity-40">{entryLabels[action]}</button>)}</div>
    {(observed||session.data?.message) && <p role="status" className="mt-2 text-xs">{observed?'Matching command ID and entry state observed from the native owner.':session.data?.message}</p>}
  </section>;
}