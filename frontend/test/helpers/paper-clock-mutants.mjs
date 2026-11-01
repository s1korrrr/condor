import assert from 'node:assert/strict';

export function clockMutation(filename, source) {
  if (!filename.endsWith('/v5/usePaperClock.ts')) return source;
  const mutant = process.env.V5_CLOCK_MUTANT;
  if (!mutant) return source;
  const anchor = mutant === 'never-clear' ? 'queueMicrotask(() => { cached = false; });' : 'if (!cached) {';
  assert.ok(['never-clear','raw-now'].includes(mutant),'unknown clock mutation');
  assert.equal(source.split(anchor).length - 1,1,'clock mutation must have exactly one target');
  return source.replace(anchor,mutant === 'never-clear' ? '' : '{');
}
