/**
 * Text for a JS number that came out of float math or a float JSON field (mark * units, a - b, cost / base).
 * A double holds 15 significant digits; the rest is binary noise such as 2672.8763299999996 or 0.30000000000000004.
 * Exact owner decimals arrive as strings and never pass through here.
 */
export function cleanFloat(value: number): string {
  return String(Number(value.toPrecision(15)));
}

/** Decimal display without converting financial values through binary floating point. */
export function decimalParts(value: string | number | null | undefined): { negative: boolean; whole: string; fraction: string } | null {
  if (value == null || value === '') return null;
  // Numbers are float-math results (see cleanFloat); strings stay exact.
  const text = typeof value === 'number' && Number.isFinite(value) ? cleanFloat(value) : String(value);
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const digits = match[2] + (match[3] ?? '');
  const split = match[2].length + exponent;
  const whole = (split <= 0 ? '0' : digits.slice(0, split).padEnd(split, '0')).replace(/^0+(?=\d)/, '');
  const fraction = (split < 0 ? '0'.repeat(-split) + digits : digits.slice(split)).replace(/0+$/, '');
  return { negative: match[1] === '-' && /[1-9]/.test(whole + fraction), whole, fraction };
}

export function displayDecimal(value: string | number | null | undefined, digits = 2, signed = false, maxFraction?: number): string {
  const parts = decimalParts(value);
  if (!parts) return 'Unavailable';
  const { whole, fraction, negative } = parts;
  if (!/[1-9]/.test(whole + fraction)) return signed ? '0.00' : '0';
  // Keep tiny holdings nonzero; retain up to eight significant fractional digits. A caller-set
  // `maxFraction` (signed PnL) rounds instead, and a value that rounds to zero prints unsigned 0.00.
  const leading = fraction.search(/[1-9]/);
  const wide = whole === '0' && leading >= digits ? Math.min(fraction.length, leading + 8) : digits;
  const precision = maxFraction === undefined ? wide : Math.min(Math.max(wide, digits), Math.max(maxFraction, digits));
  const kept = fraction.slice(0, precision).padEnd(precision, '0');
  let scaled = BigInt(whole + kept);
  if (Number(fraction[precision] ?? '0') >= 5) scaled += 1n;
  if (scaled === 0n) return signed ? '0.00' : '0';
  const text = scaled.toString().padStart(precision + 1, '0');
  const integer = (precision ? text.slice(0, -precision) : text).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const tail = precision ? text.slice(-precision) : '';
  const trimmed = tail.replace(/0+$/, '').padEnd(Math.min(precision, 2), '0');
  return `${negative ? '-' : signed ? '+' : ''}${integer}${trimmed ? `.${trimmed}` : ''}`;
}
