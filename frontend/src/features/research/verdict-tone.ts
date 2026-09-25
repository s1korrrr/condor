/** Outcome badge color: support, refutation, failure and interruption read at a glance. The text stays the source verdict. */
export function verdictTone(verdict: string | null | undefined): string {
  const value = (verdict ?? '').toUpperCase();
  if (/^(SUPPORTED|PASS|PASSED|PROMOTED)/.test(value)) return 'positive';
  if (/(REFUTED|REJECTED|NOT_SUPPORTED|FAILED|FAIL|ERROR)/.test(value)) return 'negative';
  if (/(INTERRUPTED|BLOCKED|INCONCLUSIVE|HELD|PENDING|RUNNING)/.test(value)) return 'warning';
  if (/(COMPLETED|DONE)/.test(value)) return 'neutral';
  return 'muted';
}
