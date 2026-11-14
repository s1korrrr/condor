/**
 * One number and time formatter for the V5 pages (Fable UI review 2026-11-14, section 4 "Shared rules").
 * Pure functions. Unknown input (null, undefined, NaN, text that is not a decimal) is "—" for numbers and null for
 * times, so a caller can keep its own words ("unknown time") and nothing unknown ever turns into 0.
 * Decimal strings are rounded by string arithmetic, never through a float, so a 20-digit owner value stays exact.
 */

export const MINUS = '−';
const DASH = '—';
const MAX_DATE_MS = 8.64e15;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PLAIN = /^([+-]?)(\d*)\.?(\d*)$/;
const EXPONENT = /^([+-]?)(\d*)\.?(\d*)[eE]([+-]?\d+)$/;
const MAX_EXPONENT = 400;

/** Exact {neg, int, frac} for exponent text ("1.0049e0", "4.9e-19") by moving the decimal point in the digit string. */
function expand(match) {
  const [, sign, intDigits, fracDigits, exp] = match;
  if (intDigits === '' && fracDigits === '') return null;
  const shift = Number(exp);
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > MAX_EXPONENT) return null;
  const digits = intDigits + fracDigits;
  const point = intDigits.length + shift;
  const int = point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0');
  const frac = point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point);
  return { neg: sign === '-', int: int.replace(/^0+(?=\d)/, '') || '0', frac };
}

/** {neg, int, frac} digit strings for a finite number or a decimal string, or null. */
function parse(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return null;
    const abs = Math.abs(value);
    const text = String(abs);
    return split(value < 0, text.includes('e') ? abs.toFixed(20) : text);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const exponent = EXPONENT.exec(text);
  if (exponent) return expand(exponent);
  const match = PLAIN.exec(text);
  if (!match || (match[2] === '' && match[3] === '')) return null;
  return { neg: match[1] === '-', int: match[2].replace(/^0+(?=\d)/, '') || '0', frac: match[3] };
}

function split(neg, text) {
  const [int, frac = ''] = text.split('.');
  return { neg, int: int.replace(/^0+(?=\d)/, '') || '0', frac };
}

/** Add one unit in the last place to a string of digits. */
function increment(digits) {
  const out = digits.split('');
  for (let index = out.length - 1; index >= 0; index -= 1) {
    if (out[index] === '9') out[index] = '0';
    else { out[index] = String(Number(out[index]) + 1); return out.join(''); }
  }
  return `1${out.join('')}`;
}

/** Round half away from zero to exactly `digits` decimals; a result of zero is never negative. */
function round(parts, digits) {
  let { int, frac } = parts;
  let kept = frac.slice(0, digits).padEnd(digits, '0');
  if (frac.length > digits && frac[digits] >= '5') {
    const total = increment(int + kept);
    int = total.slice(0, total.length - digits);
    kept = digits ? total.slice(-digits) : '';
  }
  const zero = /^0*$/.test(int + kept);
  return { neg: parts.neg && !zero, int: int.replace(/^0+(?=\d)/, '') || '0', frac: kept, zero };
}

const group = int => int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const render = (parts, plus = false) =>
  `${parts.neg ? MINUS : plus && !parts.zero ? '+' : ''}${group(parts.int)}${parts.frac ? `.${parts.frac}` : ''}`;

/** "1,234.50" with a true minus and no plus sign: `digits` decimals (default 2). */
export function fixed(value, digits = 2) {
  const parts = parse(value);
  return parts ? render(round(parts, digits)) : DASH;
}

/** "+1,234.5" / "−1,234.5" / "0.0": sign for non-zero values only, no arrow. */
export function signed(value, digits = 2) {
  const parts = parse(value);
  return parts ? render(round(parts, digits), true) : DASH;
}

/** "199,330.70 USDC". An empty unit leaves the unit off (an owner that did not publish one). */
export function usdc(value, unit = 'USDC') {
  const text = fixed(value, 2);
  return text === DASH || !unit ? text : `${text} ${unit}`;
}

/** Profit or loss: {text: "▲ +114.14" | "▼ −669.30" | "0.00" | "—", tone: "up" | "down" | "zero" | "none"}. */
export function pnl(value, digits = 2) {
  const parts = parse(value);
  if (!parts) return { text: DASH, tone: 'none' };
  const rounded = round(parts, digits);
  if (rounded.zero) return { text: render(rounded), tone: 'zero' };
  return rounded.neg ? { text: `▼ ${render(rounded)}`, tone: 'down' } : { text: `▲ ${render(rounded, true)}`, tone: 'up' };
}

/** Price: 0 decimals from 1,000, 2 decimals from 10, 4 decimals below 10. */
export function price(value) {
  const parts = parse(value);
  if (!parts) return DASH;
  // The bucket comes from the integer digits, exactly (999.99… stays below 1,000).
  const intDigits = parts.int === '0' ? 0 : parts.int.length;
  return render(round(parts, intDigits >= 4 ? 0 : intDigits >= 2 ? 2 : 4));
}

/**
 * Coin amount, trailing zeros removed, never 18 decimals: from 1 up, 6 significant digits but every integer digit
 * (1,390.56; 1,234,567); below 1, 6 decimals (0.016246); dust below 0.0001 keeps 3 significant digits (up to 18 decimals) so it never shows as 0.
 * `asset` is appended when given ("0.016246 BTC").
 */
export function coin(value, asset) {
  const parts = parse(value);
  if (!parts) return DASH;
  let digits;
  if (parts.int !== '0') digits = Math.max(0, 6 - parts.int.length);
  else {
    const lead = parts.frac.search(/[1-9]/);
    // Dust that cannot keep 3 significant digits within 18 decimals is shown in bounded scientific form, never as 0.
    if (lead >= 16) {
      const sig = round({ neg: false, int: parts.frac[lead], frac: parts.frac.slice(lead + 1) }, 2);
      const mantissa = sig.int.length > 1 ? `1.${sig.int.slice(1, 2)}${sig.frac[0]}` : `${sig.int}.${sig.frac}`;
      const power = sig.int.length > 1 ? lead : lead + 1;
      const text = `${parts.neg ? MINUS : ''}${mantissa.replace(/\.?0+$/, '')}e${MINUS}${power}`;
      return asset ? `${text} ${asset}` : text;
    }
    digits = lead < 0 ? 0 : Math.max(6, lead + 3);
  }
  const rounded = round(parts, digits);
  const frac = rounded.frac.replace(/0+$/, '');
  const text = `${rounded.neg ? MINUS : ''}${group(rounded.int)}${frac ? `.${frac}` : ''}`;
  return asset ? `${text} ${asset}` : text;
}

/** Percent with a sign and one percent sign: "+1.45%" / "−1.45%" / "0.00%". */
export function pct(value, digits = 2) {
  const text = signed(value, digits);
  return text === DASH ? text : `${text}%`;
}

/** Whole number with separators ("200,000"); a fraction is rounded. */
export function count(value) {
  return fixed(value, 0);
}

const validMs = ms => typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;
const two = number => String(number).padStart(2, '0');

function stamp(ms, nowMs, seconds) {
  if (!validMs(ms)) return null;
  const at = new Date(ms);
  const now = validMs(nowMs) ? new Date(nowMs) : new Date();
  const year = at.getUTCFullYear() === now.getUTCFullYear() ? '' : ` ${at.getUTCFullYear()}`;
  const clock = `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}${seconds ? `:${two(at.getUTCSeconds())}` : ''}`;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}${year} ${clock} UTC`;
}

/** "14 Nov 11:34:22 UTC", or null when `ms` is not a representable time. The year appears only when it is not the current UTC year. */
export function utc(ms, nowMs = Date.now()) {
  return stamp(ms, nowMs, true);
}

/** "14 Nov 11:34 UTC" where seconds mean nothing, or null. */
export function utcMin(ms, nowMs = Date.now()) {
  return stamp(ms, nowMs, false);
}

/** "24 s" under 2 min, "3 min" under 2 h, "3 h 10 min" under 2 days, then "3 d 19 h"; whole units, rounded down. Unknown is "—". */
export function age(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return DASH;
  const total = Math.floor(Math.max(0, seconds));
  if (total < 120) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return hours % 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : `${Math.floor(hours / 24)} d`;
}

/** "14 Nov 11:34:22 UTC · 24 s ago", or null when `ms` is not a representable time. */
export function when(ms, nowMs = Date.now()) {
  const text = utc(ms, nowMs);
  return text == null || !validMs(nowMs) ? text : `${text} · ${age((nowMs - ms) / 1000)} ago`;
}
