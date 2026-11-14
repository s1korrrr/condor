/** Shared display helpers: a time that cannot be a date and a value that was not published both stay visible as such. */

/** Largest JavaScript Date offset in milliseconds. */
const MAX_DATE_MS = 8.64e15;

/** "YYYY-MM-DD HH:MMZ" for epoch milliseconds, or null when the value is not a representable time. */
export function utcMinute(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z` : null;
}

/** Three-state text: true, false, or anything else (missing, null, wrong type) as unknown. */
export function tri(value, yes, no, unknown = 'not published') {
  return value === true ? yes : value === false ? no : unknown;
}
