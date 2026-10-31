import type { PaperRead } from './contracts';
import { paperRiskControllers, paperRiskHolds, paperSectionError, paperSnapshotsAgree } from './policy.ts';

function signalKeys(read: PaperRead): string[] {
  return [
    ...paperRiskHolds(read).map(hold => `owner:${hold.reason}`),
    ...(paperRiskControllers(read, 0) ?? []).flatMap(controller => [
      ...(controller.operator.emergency === true ? [`${controller.id}:emergency`] : []),
      ...(controller.operator.paused === true ? [`${controller.id}:paused`] : []),
      ...(controller.native.entry_hold === true ? [`${controller.id}:entry_hold`] : []),
      ...controller.holds.map(hold => `${controller.id}:${hold.reason}`),
    ]),
  ];
}

function newerSnapshot(candidate: PaperRead, prior: PaperRead): boolean {
  const candidateSource = candidate.source, priorSource = prior.source;
  if (typeof candidateSource?.boot_id === 'string' && candidateSource.boot_id && typeof priorSource?.boot_id === 'string' && priorSource.boot_id &&
      Number.isSafeInteger(candidateSource.sequence) && Number(candidateSource.sequence) > 0 && Number.isSafeInteger(priorSource.sequence) && Number(priorSource.sequence) > 0) {
    return candidateSource.boot_id !== priorSource.boot_id || Number(candidateSource.sequence) > Number(priorSource.sequence);
  }
  return false;
}

function riskSupersedes(read: PaperRead): boolean {
  const controllers = paperRiskControllers(read, 0);
  return read.section === 'risk' && read.state === 'available' && read.completeness === 'complete' && !read.next_cursor && !paperSectionError(read) &&
    !!controllers?.length && controllers.every(controller => typeof controller.native.complete === 'boolean' && typeof controller.operator.emergency === 'boolean' && typeof controller.operator.paused === 'boolean');
}

export function paperSafetyReads(previous: PaperRead[], received: PaperRead[], complete?: PaperRead): PaperRead[] {
  const status = received.find(read => read.section === 'status');
  const incoming = received.filter(read => read.section === 'risk' && status && read.bot_id === status.bot_id && paperSnapshotsAgree([status, read]));
  const signals = new Map<string, PaperRead>();
  for (const read of [...previous, ...incoming]) {
    if (complete && read.bot_id === complete.bot_id && riskSupersedes(complete) && newerSnapshot(complete, read)) continue;
    for (const key of signalKeys(read)) {
      const prior = signals.get(key);
      if (!prior || newerSnapshot(read, prior)) signals.set(key, read);
    }
  }
  return [...new Set(signals.values())];
}
