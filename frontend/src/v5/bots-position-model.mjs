export function breakEvenDistance(breakeven, close) {
  if (typeof breakeven !== 'string' || !/^\d+(\.\d+)?$/.test(breakeven) || typeof close !== 'number' || !Number.isFinite(close) || close <= 0) return '—';
  // Candles are owner JSON numbers: this display percentage uses Number and rounds to 0.1%; money totals remain exact decimals.
  const price = Number(breakeven);
  if (!Number.isFinite(price) || price <= 0) return '—';
  const distance = (price / close - 1) * 100;
  return distance > 0 ? `Needs +${distance.toFixed(1)}% to break even` : `Above breakeven by ${Math.abs(distance).toFixed(1)}%`;
}

export function activeLots(rows) {
  return rows.filter(row => row.state !== 'terminal_dust');
}

export function sellOrderCount(rows) {
  if (!rows || rows.some(row => typeof row.protected_exit !== 'boolean')) return null;
  return `${rows.filter(row => row.protected_exit).length} of ${rows.length}`;
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
