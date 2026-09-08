export type NativeAction = 'start' | 'stop';
export interface NativeCommandResult { httpStatus: number; body: Record<string, unknown> }
export function nativeBotPath(server: string, botName: string, action: NativeAction|'status'): string {
  if (!server || !botName || !['status','start','stop'].includes(action)) throw new Error('Invalid native lifecycle route');
  return `/api/v1/servers/${encodeURIComponent(server)}/bots/${encodeURIComponent(botName)}/native/${action}`;
}
export interface NativeControlEligibility {
  action: NativeAction|null; allowed: boolean; reason: string; state: string;
  bootId: string; instanceId: string; sequence: number;
}
const object = (value: unknown): Record<string,unknown> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};

export function nativeControlEligibility(value: unknown, botName: string, canControl: boolean, canStart: boolean, now: number): NativeControlEligibility {
  const data=object(object(value).data), lifecycle=object(data.lifecycle), observation=object(lifecycle.observation), payload=object(observation.payload), heartbeat=object(data.heartbeat);
  const state=typeof lifecycle.state==='string'?lifecycle.state:'unknown';
  const action:NativeAction|null=state==='running'||state==='unknown'?'stop':state==='stopped'?'start':null;
  const limit=typeof data.stale_after_seconds==='number' && Number.isFinite(data.stale_after_seconds) && data.stale_after_seconds>0 ? Math.min(data.stale_after_seconds,30)*1000 : 0;
  const fresh=(timestamp:unknown,scale=1000)=>typeof timestamp==='number' && Number.isFinite(timestamp) && limit>0 && now-timestamp*scale>=-5000 && now-timestamp*scale<limit;
  let reason='';
  if (!canControl || (action==='start'&&!canStart)) reason='Native lifecycle controls are unavailable on this server.';
  else if (data.bot_name!==botName || data.source!=='native_mqtt' || data.execution_owner!=='native_hummingbot' || data.identity_verified!==true || typeof data.mqtt_instance_id!=='string' || !data.mqtt_instance_id) reason='Native process identity is unverified.';
  else if (lifecycle.valid!==true || lifecycle.blocked_reason || typeof lifecycle.boot_id!=='string' || !lifecycle.boot_id || typeof lifecycle.sequence!=='number' || !Number.isSafeInteger(lifecycle.sequence) || lifecycle.sequence<=0 || payload.boot_id!==lifecycle.boot_id || payload.instance_id!==data.mqtt_instance_id || payload.sequence!==lifecycle.sequence || payload.state!==state) reason='Verified owner lifecycle evidence is unavailable.';
  else if (observation.retained!==false || observation.replayed!==false || heartbeat.retained!==false || !fresh(observation.received_at) || !fresh(payload.generated_at) || !fresh(heartbeat.received_at) || !fresh(heartbeat.source_timestamp,0.001)) reason='Native lifecycle or heartbeat is stale. Await fresh owner telemetry.';
  else if (!action) reason='Await the current native lifecycle transition.';
  else if (action==='start' && lifecycle.reconciliation_complete!==true) reason='Start requires completed owner reconciliation.';
  return {action,allowed:!reason,reason,state,bootId:typeof lifecycle.boot_id==='string'?lifecycle.boot_id:'',instanceId:typeof data.mqtt_instance_id==='string'?data.mqtt_instance_id:'',sequence:typeof lifecycle.sequence==='number'?lifecycle.sequence:0};
}

export function nativeCommandOutcome(result: NativeCommandResult, expected:{botName:string;action:NativeAction;bootId:string;instanceId:string}) {
  const response=object(result.body.response), ack=object(response.acknowledgement);
  const identity=response.bot_name===expected.botName && response.action===expected.action && typeof response.request_id==='string' && !!response.request_id && ack.request_id===response.request_id && ack.action===expected.action && ack.boot_id===expected.bootId && ack.instance_id===expected.instanceId;
  const verified=result.httpStatus===200 && result.body.status==='success' && identity && response.execution_verified===true && response.owner_accepted===true && response.owner_execution_completed===true && response.outcome_unknown===false && response.verification_source==='native_owner_acknowledgement' && ack.accepted===true && ack.execution_completed===true && ack.state===(expected.action==='start'?'running':'stopped') && (expected.action==='start'||ack.reconciliation_complete===true);
  if (verified) return {state:'verified' as const,message:expected.action==='start'?'Native owner verified the strategy is running.':'Native owner verified the strategy is stopped and reconciliation is complete.'};
  if (result.httpStatus>=400 && result.httpStatus<500 && (typeof result.body.detail==='string' || (identity && response.owner_accepted===false && ack.accepted===false))) return {state:'rejected' as const,message:typeof result.body.detail==='string'?result.body.detail:'Native owner rejected this lifecycle request.'};
  return {state:'unknown' as const,message:'Execution outcome is unknown. Await a fresh owner state transition before retrying.'};
}

export function awaitingNativeOwnerTransition(submitted: {bootId:string;sequence:number;action:NativeAction}|null, eligibility: NativeControlEligibility): boolean {
  if (!submitted) return false;
  if (!eligibility.allowed) return true;
  // A verified replacement process is independent of the old request. Its fresh
  // state governs new controls; the old acknowledgement remains unknown.
  if (eligibility.bootId!==submitted.bootId) return false;
  if (eligibility.sequence<=submitted.sequence) return true;
  // A terminal failed transition can require another owner reconciliation stop.
  if (eligibility.state==='unknown' && eligibility.action==='stop') return false;
  return eligibility.state!==(submitted.action==='start'?'running':'stopped');
}
