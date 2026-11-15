import type { PaperRead } from './contracts';
import { newerSnapshot, paperSafetyCoverage, paperSafetyReads } from './paper-safety';
import { paperSectionError } from './policy';

export class PaperSafetyStore {
  private reads: PaperRead[] = [];
  private coverage = new Map<string, PaperRead>();
  private listeners = new Set<() => void>();
  restartOrderUnknown = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot = () => this.reads;

  reconcile = (reads: PaperRead[]) => {
    let result = reads.filter(read => read.section === 'risk' && read.data != null && !paperSectionError(read));
    for (const complete of new Set(this.coverage.values())) result = paperSafetyReads(result, [], complete);
    return result;
  };

  receive(received: PaperRead[], complete?: PaperRead) {
    const incoming = paperSafetyReads([], received);
    const risks = complete ? [complete] : received.filter(read => read.section === 'risk');
    const unordered = (left: PaperRead, right: PaperRead) => {
      if (left.bot_id !== right.bot_id) return false;
      const same = !!left.source?.boot_id && left.source.boot_id === right.source?.boot_id && left.source.sequence === right.source?.sequence && left.source.boot_epoch === right.source?.boot_epoch;
      return !same && !newerSnapshot(left, right) && !newerSnapshot(right, left);
    };
    const unknown = risks.some(risk => this.reads.some(held => unordered(risk, held))) || incoming.some(held => [...this.coverage.values()].some(risk => unordered(risk, held)));
    if (unknown || complete) this.restartOrderUnknown = unknown;
    if (complete) for (const key of paperSafetyCoverage(complete)) {
      const previous = this.coverage.get(key);
      if (!previous || newerSnapshot(complete, previous)) this.coverage.set(key, complete);
    }
    this.reads = this.reconcile(paperSafetyReads(this.reads, received, complete));
    for (const listener of this.listeners) listener();
  }
}
