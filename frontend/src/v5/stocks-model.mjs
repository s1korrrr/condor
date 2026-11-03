const products = new Set(['SPOT', 'SWAP', 'FUTURES']);

export function stockKey(region, instrument) {
  return `${region}/${instrument.instType}/${instrument.instId}`;
}

export function filterStockRows(rows, product) {
  return rows.filter(row => row?.instrument?.instCategory === '3'
    && products.has(row.instrument.instType)
    && (product === 'ALL' || row.instrument.instType === product));
}

export function selectedStock(rows, region, selected) {
  return rows.find(row => stockKey(region, row.instrument) === selected) ?? rows[0] ?? null;
}

export function effectiveState(source, failed, nowMs = Date.now()) {
  if (failed || !source) return 'unavailable';
  const age = nowMs / 1000 - source.now;
  if (['live', 'empty'].includes(source.state) && (age > 90 || age < -5)) return 'stale';
  return source.state;
}

export function publicObservation(source, dataset, failed = false, nowMs = Date.now()) {
  if (!['live', 'stale'].includes(effectiveState(source, failed, nowMs))) return null;
  if (!['live', 'stale'].includes(source?.channels?.[dataset]?.state)) return null;
  return source.latest?.[dataset] ?? null;
}

export function stockProductLabel(instrument) {
  if (instrument.instType === 'SPOT') return 'Spot · tokenized stock';
  if (instrument.instType === 'SWAP') return 'Perpetual · SWAP';
  return instrument.ruleType === 'xperp' ? 'X-Perp · FUTURES' : 'Futures';
}

export function fundingApplicable(instrument) {
  return instrument.instType === 'SWAP' || (instrument.instType === 'FUTURES' && instrument.ruleType === 'xperp');
}

// The collector's --stocks-instruments entry, exactly region:instType:instId.
export function captureEntry(region, identity) {
  return `${region}:${identity.instType}:${identity.instId}`;
}

export function stockCaptured(row) {
  return row?.captured === true;
}

export function unlistedCapture(catalog) {
  return (catalog?.capture ?? []).filter(entry => entry.listed === false);
}
