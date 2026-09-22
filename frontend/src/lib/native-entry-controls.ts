export type EntryAction = 'pause' | 'resume' | 'acknowledge-daily-loss';
export const entryLabels: Record<EntryAction,string> = {pause:'Pause new entries',resume:'Resume new entries','acknowledge-daily-loss':'Acknowledge daily loss'};
export function entryPath(server:string,bot:string,operation:EntryAction|'status') {
  if (!server || !bot || !['status','pause','resume','acknowledge-daily-loss'].includes(operation)) throw new Error('Invalid native entry route');
  return `/api/v1/servers/${encodeURIComponent(server)}/bots/${encodeURIComponent(bot)}/native/entries/${operation}`;
}
const object=(value:unknown):Record<string,unknown>=>value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{};
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
export function entryCommandObserved(value:unknown,bot:string,now:number,receivedAt:number,command:{id:string;action:EntryAction}) {
  const view=entryObservation(value,bot,now,receivedAt);
  return view.valid && view.rows.every(row=>row.last_command_id===command.id && row.entry_paused===(command.action==='pause')
    && typeof row.updated_at==='number' && Number.isFinite(row.updated_at) && row.updated_at>=0);
}
export function entryPublicationMessage(status:number,body:unknown) {
  const payload=object(body);
  if(status>=400) return {rejected:true,text:typeof payload.detail==='string'?payload.detail:'Native owner rejected this request.'};
  return {rejected:false,text:'Submitted; waiting for matching native entry state. Publication does not confirm execution.'};
}
