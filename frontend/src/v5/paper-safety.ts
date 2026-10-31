import type { PaperRead } from './contracts';
import { paperRiskControllers, paperRiskHolds, paperSnapshotsAgree } from './policy.ts';

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

export function paperSafetyReads(previous: PaperRead[], received: PaperRead[], complete?: Pick<PaperRead, 'bot_id' | 'generated_at_ms'>): PaperRead[] {
  const status = received.find(read => read.section === 'status');
  const incoming = received.filter(read => read.section === 'risk' && status && read.bot_id === status.bot_id && paperSnapshotsAgree([status, read]));
  const signals = new Map<string, PaperRead>();
  for (const read of [...previous, ...incoming]) {
    if (complete && read.bot_id === complete.bot_id && read.generated_at_ms !== null && complete.generated_at_ms !== null && read.generated_at_ms < complete.generated_at_ms) continue;
    for (const key of signalKeys(read)) {
      const prior = signals.get(key);
      if (!prior || (read.generated_at_ms ?? -1) >= (prior.generated_at_ms ?? -1)) signals.set(key, read);
    }
  }
  return [...new Set(signals.values())];
}
