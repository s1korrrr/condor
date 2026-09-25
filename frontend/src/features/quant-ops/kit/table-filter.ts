/** Numeric filter expression: `>5`, `<=0`, `=12`, `1..3`, or a plain number (equality by display). */
export function numericFilterMatch(raw: unknown, expression: string): boolean {
  const text = expression.trim();
  if (!text) return true;
  const value = typeof raw === 'number' ? raw : raw == null || raw === '' ? NaN : Number(raw);
  const range = /^(-?\d*\.?\d+)\s*\.\.\s*(-?\d*\.?\d+)$/.exec(text);
  if (range) return Number.isFinite(value) && value >= Number(range[1]) && value <= Number(range[2]);
  const compare = /^(>=|<=|>|<|=)\s*(-?\d*\.?\d+)$/.exec(text);
  if (compare) {
    if (!Number.isFinite(value)) return false;
    const limit = Number(compare[2]);
    return compare[1] === '>' ? value > limit : compare[1] === '<' ? value < limit : compare[1] === '>=' ? value >= limit : compare[1] === '<=' ? value <= limit : value === limit;
  }
  return String(raw ?? '').toLowerCase().includes(text.toLowerCase());
}
