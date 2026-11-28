import { compareDecimal } from '@/v5/format.mjs';

/** Number-column filter: `>5`, `<=0`, `=12` or `1..3` compare numerically; any other text (including a bare number) matches as contains. */
export function numericFilterMatch(raw: unknown, expression: string): boolean {
  const text = expression.trim();
  if (!text) return true;
  const orderAgainst = (operand: string) => {
    if (typeof raw === 'string') return compareDecimal(raw, operand);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    const limit = Number(operand);
    return raw < limit ? -1 : raw > limit ? 1 : 0;
  };
  const range = (typeof raw === 'string' ? /^(.*?)\.\.(.*)$/s : /^(-?\d*\.?\d+)\s*\.\.\s*(-?\d*\.?\d+)$/).exec(text);
  if (range) {
    const lower = orderAgainst(range[1]), upper = orderAgainst(range[2]);
    return lower !== null && upper !== null && lower >= 0 && upper <= 0;
  }
  const compare = (typeof raw === 'string' ? /^(>=|<=|>|<|=)\s*(.*)$/s : /^(>=|<=|>|<|=)\s*(-?\d*\.?\d+)$/).exec(text);
  if (compare) {
    const order = orderAgainst(compare[2]);
    if (order === null) return false;
    return compare[1] === '>' ? order > 0 : compare[1] === '<' ? order < 0 : compare[1] === '>=' ? order >= 0 : compare[1] === '<=' ? order <= 0 : order === 0;
  }
  return String(raw ?? '').toLowerCase().includes(text.toLowerCase());
}

/** Table search: case-insensitive contains over each row's raw values and displayed text. */
export function searchMatch(haystack: (string | number | null | undefined)[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || haystack.some(value => value != null && String(value).toLowerCase().includes(needle));
}
