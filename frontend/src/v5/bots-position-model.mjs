import { decimalPercentChange, fixed, signed } from './format.mjs';

export function breakEvenDistance(breakeven, close) {
  return breakEvenDistanceDetail(breakeven, close)?.text ?? '—';
}

export function breakEvenDistanceDetail(breakeven, close) {
  if (typeof breakeven !== 'string' || !/^\d+(\.\d+)?$/.test(breakeven) || typeof close !== 'number' || !Number.isFinite(close)) return null;
  const need = decimalPercentChange(breakeven, close, 1);
  const above = decimalPercentChange(close, breakeven, 1);
  if (!need || !above) return null;
  const needsRise = need.direction > 0;
  const result = needsRise ? need : above;
  const end = needsRise ? breakeven : String(close), base = needsRise ? String(close) : breakeven;
  return { text: needsRise ? `Needs ${signed(result.value, 1)}% to break even` : `Above breakeven by ${fixed(result.value, 1)}%`, exact: `(${end} − ${base}) × 100 / ${base} = ${result.exact}` };
}

export function moneySampleState(row, now) {
  if (!row || row.gap || row.unit !== 'USDC' || !Number.isSafeInteger(now) || !Number.isSafeInteger(row.at_ms) || !Number.isSafeInteger(row.snapshot_at_ms) || row.at_ms > now || row.snapshot_at_ms > now || Math.abs(row.at_ms - row.snapshot_at_ms) > 30000) return null;
  const next = (Math.floor(row.at_ms / 300000) + 1) * 300000;
  return { state: now < next ? 'sample' : 'late', next };
}

export function activeLots(rows) {
  return rows.filter(row => row.state !== 'terminal_dust');
}

export function exactSignedSum(left, right) {
  const valid = value => typeof value === 'string' && value.length <= 128 && /^-?\d+(\.\d+)?$/.test(value);
  if (!valid(left) || !valid(right)) return null;
  const places = Math.max(left.split('.')[1]?.length ?? 0, right.split('.')[1]?.length ?? 0);
  const scaled = value => {
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
    const result = BigInt(whole + fraction.padEnd(places, '0'));
    return negative ? -result : result;
  };
  const total = scaled(left) + scaled(right);
  const digits = (total < 0n ? -total : total).toString().padStart(places + 1, '0');
  return `${total < 0n ? '-' : ''}${places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits}`;
}
