import type { PaperRead, PaperRiskData } from './contracts';
import { paperRiskControllers, paperRiskHolds, paperSectionError, paperSnapshotsAgree } from './policy.ts';

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
      ...(controller.entryHold === true ? [`${controller.id}:entry_hold`] : []),
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
  // Only controllers whose newer report states every hold flag explicitly can clear retained signals (R97-SOL-2).
  const covered = new Set((paperRiskControllers(newer, 0) ?? []).filter(controller => controller.explicit).map(controller => controller.id));
  const data = read.data as PaperRiskData & Record<string, unknown>;
  const ownerCovered = Array.isArray((newer.data as Record<string, unknown> | null)?.holds);
  return {...read, data:{...data,
    ...(ownerCovered ? {control_hold:null, holds:[]} : {}),
    ...(data.controllers ? {controllers:Object.fromEntries(Object.entries(data.controllers).filter(([id]) => !covered.has(id)))} : {}),
    ...(data.native_entry_holds ? {native_entry_holds:data.native_entry_holds.filter(hold => !covered.has(hold.controller_id))} : {}),
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
