import type { PaperRead } from './contracts';
import { newerSnapshot, paperSafetyCoverage, paperSafetyReads } from './paper-safety';

export class PaperSafetyStore {
  private reads: PaperRead[] = [];
  private coverage = new Map<string, PaperRead>();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot = () => this.reads;

  reconcile = (reads: PaperRead[]) => {
    let result = reads;
    for (const complete of new Set(this.coverage.values())) result = paperSafetyReads(result, [], complete);
    return result;
  };

  receive(received: PaperRead[], complete?: PaperRead) {
    if (complete) for (const key of paperSafetyCoverage(complete)) {
      const scopedKey = JSON.stringify([key, complete.source?.boot_id ?? null]);
      const previous = this.coverage.get(scopedKey);
      if (!previous || newerSnapshot(complete, previous)) this.coverage.set(scopedKey, complete);
    }
    this.reads = this.reconcile(paperSafetyReads(this.reads, received, complete));
    for (const listener of this.listeners) listener();
  }
}
