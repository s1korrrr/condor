import type { PaperRead, PaperRiskData } from './contracts';
import { paperNativeLatch, paperRiskControllers, paperRiskHolds, paperSectionError, paperSnapshotsAgree } from './policy.ts';

export const PAPER_OWNER_HOLD_REASONS = [
  'stop_intent_log_damaged', 'stop_persistence_failed', 'ingress_unreadable',
  'clock_persistence_failed', 'clock_invalid', 'clock_anomaly',
] as const;

export const PAPER_NATIVE_ENTRY_HOLD_REASONS = [
  'native_refusal_recovery_unavailable', 'native_refusal_owner_ambiguous',
  'native_refusal_receipt_pending', 'v5_risk_incomplete',
] as const;

function signalKeys(read: PaperRead): string[] {
  return [
    ...paperRiskHolds(read).map(hold => `owner:${hold.reason}`),
    ...(paperRiskControllers(read, 0) ?? []).flatMap(controller => [
      ...(controller.operator.emergency === true ? [`${controller.id}:emergency`] : []),
      ...(controller.operator.paused === true ? [`${controller.id}:paused`] : []),
      ...(controller.latch === true ? [`${controller.id}:latch`] : []),
      ...controller.holds.map(hold => `${controller.id}:${hold.reason}`),
    ]),
  ];
}

export function newerSnapshot(candidate: PaperRead, prior: PaperRead): boolean {
  const candidateSource = candidate.source, priorSource = prior.source;
  if (typeof candidateSource?.boot_id === 'string' && candidateSource.boot_id && typeof priorSource?.boot_id === 'string' && priorSource.boot_id &&
      Number.isSafeInteger(candidateSource.sequence) && Number(candidateSource.sequence) > 0 && Number.isSafeInteger(priorSource.sequence) && Number(priorSource.sequence) > 0) {
    return candidateSource.boot_id !== priorSource.boot_id || Number(candidateSource.sequence) > Number(priorSource.sequence);
  }
  return false;
}

function riskSupersedes(read: PaperRead): boolean {
  const controllers = paperRiskControllers(read, 0);
  const holdOnly = read.state === 'degraded' && read.completeness === 'partial' && (
    PAPER_OWNER_HOLD_REASONS.some(reason => reason === read.reason) && paperRiskHolds(read).some(hold => hold.reason === read.reason) ||
    PAPER_NATIVE_ENTRY_HOLD_REASONS.some(reason => reason === read.reason) && controllers?.some(controller => controller.holds.some(hold => hold.reason === read.reason)) === true
  );
  return read.section === 'risk' && (read.state === 'available' && read.completeness === 'complete' || holdOnly) && !read.next_cursor && !paperSectionError(read) &&
    !!controllers?.length && controllers.every(controller => typeof controller.native.complete === 'boolean' && typeof controller.operator.emergency === 'boolean' && typeof controller.operator.paused === 'boolean');
}

function uncoveredSafety(read: PaperRead, newer: PaperRead): PaperRead {
  // Per signal (R97-SOL-2): a retained hold signal is dropped only when the newer superseding read shows the same signal
  // itself or clears it explicitly (operator flag === false; latch false with complete native evidence; a listed native
  // hold set without this reason for a controller it reports). Omitted, null or malformed evidence keeps the signal.
  const newerData = newer.data as (PaperRiskData & Record<string, unknown>) | null;
  const reported = new Map((paperRiskControllers(newer, 0) ?? []).map(controller => [controller.id, controller]));
  const shown = new Set(signalKeys(newer));
  const holdsListed = Array.isArray(newerData?.native_entry_holds);
  const settled = (id: string, signal: string) => {
    if (shown.has(`${id}:${signal}`)) return true;
    const next = reported.get(id);
    if (!next) return false;
    if (signal === 'paused') return next.operator.paused === false;
    if (signal === 'emergency') return next.operator.emergency === false;
    if (signal === 'latch') return next.latch === false;
    return holdsListed;
  };
  const data = read.data as PaperRiskData & Record<string, unknown>;
  const ownerCovered = Array.isArray(newerData?.holds);
  const keptHolds = (data.native_entry_holds ?? []).filter(hold => !settled(hold.controller_id, hold.reason));
  const controllers = data.controllers && Object.fromEntries(Object.entries(data.controllers).flatMap(([id, row]) => {
    const next = reported.get(id);
    const operator = {...row.operator}, native = {...row.native};
    const keep = {
      paused: operator.paused === true && !settled(id, 'paused'),
      emergency: operator.emergency === true && !settled(id, 'emergency'),
      latch: paperNativeLatch(native) === true && !settled(id, 'latch'),
    };
    if (!keep.paused && !keep.emergency && !keep.latch && !keptHolds.some(hold => hold.controller_id === id)) return [];
    // A kept controller shows the newer read's values for the flags that read has settled, never the stale ones.
    if (next && operator.paused === true && !keep.paused) operator.paused = next.operator.paused;
    if (next && operator.emergency === true && !keep.emergency) operator.emergency = next.operator.emergency;
    if (next && paperNativeLatch(native) === true && !keep.latch) Object.assign(native, {latched:next.native.latched, entry_hold:next.native.entry_hold, complete:next.native.complete});
    return [[id, {...row, operator, native}]];
  }));
  return {...read, data:{...data,
    ...(ownerCovered ? {control_hold:null, holds:[]} : {}),
    ...(controllers ? {controllers} : {}),
    ...(data.native_entry_holds ? {native_entry_holds:keptHolds} : {}),
  }};
}

/**
 * Safety evidence the displayed risk read does not already show. The same hold signal from another object or another
 * snapshot (a refresh in flight, structural sharing) is one statement, so it is not handed to the view twice. A retained
 * read keeps only the controllers and owner holds that add a signal. Retention itself (paperSafetyReads) is unchanged,
 * and nothing is dropped when the displayed read is invalid or shows no signal.
 */
export function paperSafetyBeyondDisplayed(safety: PaperRead[], displayed: PaperRead[]): PaperRead[] {
  const shown = new Set(displayed.filter(read => read.section === 'risk' && !paperSectionError(read)).flatMap(read => signalKeys(read).map(key => `${read.bot_id}:${key}`)));
  if (!shown.size) return safety;
  return safety.flatMap(read => {
    if (displayed.includes(read)) return [read];
    const extra = signalKeys(read).filter(key => !shown.has(`${read.bot_id}:${key}`));
    if (!extra.length) return [];
    const adds = (id: string) => extra.some(key => key.startsWith(`${id}:`));
    const data = read.data as PaperRiskData & Record<string, unknown>;
    return [{...read, data:{...data,
      ...(extra.some(key => key.startsWith('owner:')) ? {} : {control_hold:null, holds:[]}),
      ...(data.controllers ? {controllers:Object.fromEntries(Object.entries(data.controllers).filter(([id]) => adds(id)))} : {}),
      ...(data.native_entry_holds ? {native_entry_holds:data.native_entry_holds.filter(hold => adds(hold.controller_id))} : {}),
    }}];
  });
}

export function paperSafetyReads(previous: PaperRead[], received: PaperRead[], complete?: PaperRead): PaperRead[] {
  const status = received.find(read => read.section === 'status');
  const incoming = received.filter(read => read.section === 'risk' && status && read.bot_id === status.bot_id && paperSnapshotsAgree([status, read]));
  const signals = new Map<string, PaperRead>();
  for (const priorRead of [...previous, ...incoming]) {
    const read = complete && priorRead.bot_id === complete.bot_id && riskSupersedes(complete) && newerSnapshot(complete, priorRead) ? uncoveredSafety(priorRead, complete) : priorRead;
    for (const key of signalKeys(read)) {
      const scopedKey = `${read.bot_id}:${key}`;
      const prior = signals.get(scopedKey);
      if (!prior || newerSnapshot(read, prior)) signals.set(scopedKey, read);
    }
  }
  return [...new Set(signals.values())];
}
