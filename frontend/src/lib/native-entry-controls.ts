export type EntryAction = 'pause' | 'resume' | 'acknowledge-daily-loss';
export type EntryCommand = {id:string; action:EntryAction};
export type EntryPendingStorage = {getItem(key:string):string|null; setItem(key:string,value:string):void; removeItem(key:string):void};
export type EntryPendingRead = {status:'empty'|'valid'|'invalid'|'unavailable'; command:EntryCommand|null};
export const entryLabels: Record<EntryAction,string> = {pause:'Pause new entries',resume:'Resume new entries','acknowledge-daily-loss':'Acknowledge daily loss'};
const entryActions=new Set<EntryAction>(['pause','resume','acknowledge-daily-loss']);
const object=(value:unknown):Record<string,unknown>=>value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{};
const validCommand=(value:unknown):EntryCommand|null=>{
  const row=object(value),keys=Object.keys(row).sort();
  return keys.length===2 && keys[0]==='action' && keys[1]==='id'
    && typeof row.id==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(row.id)
    && typeof row.action==='string' && entryActions.has(row.action as EntryAction)
    ? {id:row.id,action:row.action as EntryAction}:null;
};
export function entryPendingStorageKey(server:string,bot:string,userId:number) {
  if(!server || !bot || !Number.isSafeInteger(userId) || userId<=0) throw new Error('Invalid native pending-command scope');
  return `condor:native-entry-pending:v1:${userId}:${encodeURIComponent(server)}:${encodeURIComponent(bot)}`;
}
export function readPendingEntryCommand(storage:EntryPendingStorage|null,key:string):EntryPendingRead {
  if(!storage) return {status:'unavailable',command:null};
  let raw:string|null;
  try { raw=storage.getItem(key); } catch { return {status:'unavailable',command:null}; }
  if(raw===null) return {status:'empty',command:null};
  try {
    const command=validCommand(JSON.parse(raw));
    return command?{status:'valid',command}:{status:'invalid',command:null};
  } catch { return {status:'invalid',command:null}; }
}
export function writePendingEntryCommand(storage:EntryPendingStorage|null,key:string,command:EntryCommand):boolean {
  const validated=validCommand(command);
  if(!storage || !validated) return false;
  try {
    const serialized=JSON.stringify(validated);
    storage.setItem(key,serialized);
    return storage.getItem(key)===serialized;
  } catch { return false; }
}
export function clearPendingEntryCommand(storage:EntryPendingStorage|null,key:string):boolean {
  if(!storage) return false;
  try { storage.removeItem(key); return storage.getItem(key)===null; } catch { return false; }
}
export function entryPath(server:string,bot:string,operation:EntryAction|'status') {
  if (!server || !bot || !['status','pause','resume','acknowledge-daily-loss'].includes(operation)) throw new Error('Invalid native entry route');
  return `/api/v1/servers/${encodeURIComponent(server)}/bots/${encodeURIComponent(bot)}/native/entries/${operation}`;
}
export function entryObservation(value:unknown,bot:string,now:number,receivedAt:number) {
  const payload=object(value),data=object(payload.data),stamp=payload.verified_at;
  const rows=Array.isArray(data.controllers)?data.controllers.map(object):[];
  const localAge=now-receivedAt;
  const valid=payload.status==='success' && data.bot_name===bot && data.bot_status==='running'
    && typeof stamp==='number' && Number.isFinite(stamp) && stamp>0
    && typeof receivedAt==='number' && Number.isFinite(receivedAt) && localAge>=0 && localAge<15000
    && rows.length>0 && rows.every(row=>typeof row.controller_id==='string' && typeof row.entry_paused==='boolean')
    && new Set(rows.map(row=>row.controller_id)).size===rows.length;
  return {valid,allowed:valid && payload.command_allowed===true,rows:valid?rows:[]};
}
export function entryCommandObserved(value:unknown,bot:string,now:number,receivedAt:number,command:EntryCommand) {
  const view=entryObservation(value,bot,now,receivedAt);
  return view.valid && view.rows.every(row=>row.last_command_id===command.id && row.entry_paused===(command.action==='pause')
    && typeof row.updated_at==='number' && Number.isFinite(row.updated_at) && row.updated_at>=0);
}
export function entryPublicationMessage(status:number,body:unknown) {
  const payload=object(body);
  if(status>=400) return {rejected:true,text:typeof payload.detail==='string'?payload.detail:'Native owner rejected this request.'};
  return {rejected:false,text:'Submitted; waiting for matching native entry state. Publication does not confirm execution.'};
}