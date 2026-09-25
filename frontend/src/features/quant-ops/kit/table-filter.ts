/** Number-column filter: `>5`, `<=0`, `=12` or `1..3` compare numerically; any other text (including a bare number) matches as contains. */
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

/** Table search: case-insensitive contains over each row's raw values and displayed text. */
export function searchMatch(haystack: (string | number | null | undefined)[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || haystack.some(value => value != null && String(value).toLowerCase().includes(needle));
}
