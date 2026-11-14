/**
 * Pure projections for the one-page V5 Market view.
 *
 * Every candle read is the owner's dense window (condor/v5/candles.py): one row per minute from `start` to `end`
 * (the last closed minute), prices only on a final minute (row[6] === 1), plus the owner's `now` and `totals`.
 * The model keeps that grid: index is time, a missing minute is an entry with null values. Every derived value
 * comes from a fixed position in the grid, so a missing boundary minute makes the value unknown instead of
 * silently using a neighbour. Spot and perpetual are separate grids and are only compared minute by minute.
 */

export const MARKET_COINS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
/** Reference lanes for prices and the spot/perpetual premium: one venue so both legs share quote and clock. */
export const REFERENCE = { venue: 'binance', quote: 'USDT', spot: 'binance__spot', perpetual: 'binance__perpetual' };
/** A price older than this (owner time plus time since the read arrived) is marked as old on its tile. */
export const STALE_AFTER_S = 180;
const SAMPLE = 5;

/** One entry per owner minute; a minute that is not final has null prices and volume. Null without a window. */
export function grid(read) {
  if (!read || !Array.isArray(read.buckets) || !read.buckets.length) return null;
  return read.buckets.map(row => row[6] === 1
    ? { t: row[0], high: row[2], low: row[3], close: row[4], volume: row[5] }
    : { t: row[0], high: null, low: null, close: null, volume: null });
}

export const pct = (value, base) => value != null && base != null ? (value / base - 1) * 100 : null;
const lastIndex = minutes => minutes.findLastIndex(minute => minute.close != null);

/** Seconds since a minute closed: owner `now` at read time plus local time elapsed since the read arrived. */
export function ageSeconds(minuteT, read, receivedAtMs, nowMs) {
  return read.now - (minuteT + 60) + Math.max(0, nowMs - receivedAtMs) / 1000;
}

/**
 * Every fifth minute of the grid, the newest minute with a value (so a chart ends where its tile does, even while
 * the window's last minute is still pending) and the last minute. A minute with no value anywhere since the
 * previous sample adds an explicit null at that minute, so a chart breaks across missing time even between samples.
 */
function samples(minutes, value) {
  const out = [];
  let missingSince = null;
  const newest = minutes.findLastIndex(minute => minute.close != null && value(minute) != null);
  minutes.forEach((minute, index) => {
    const current = minute.close == null ? null : value(minute);
    if (current == null && missingSince == null) missingSince = minute.t;
    if (index % SAMPLE !== SAMPLE - 1 && index !== minutes.length - 1 && index !== newest) return;
    if (missingSince != null && current != null) out.push({ time: missingSince * 1000, value: null });
    out.push({ time: minute.t * 1000, value: current });
    missingSince = null;
  });
  return out;
}

/** Price tile for one coin; null when the window holds no close at all. */
export function coinTile(coin, spotRead, perpetualRead) {
  const minutes = grid(spotRead);
  if (!minutes) return null;
  const index = lastIndex(minutes);
  if (index < 0) return null;
  const last = minutes[index];
  const perpetual = new Map((grid(perpetualRead) ?? []).map(minute => [minute.t, minute.close]));
  const held = minutes.filter(minute => minute.close != null);
  // Perpetual minutes finalize later than spot, so the newest spot minute often has no perpetual close yet. The premium
  // uses the newest minute where BOTH legs are final, and that minute is returned with it; nothing is substituted.
  const both = minutes.findLastIndex(minute => minute.close != null && perpetual.get(minute.t) != null);
  return {
    coin,
    last: last.close,
    lastTime: last.t,
    // Window return needs the window's first minute; last-hour return needs the minute exactly 60 earlier.
    changePct: pct(last.close, minutes[0].close),
    change1hPct: pct(last.close, minutes[index - 60]?.close),
    high: Math.max(...held.map(minute => minute.high)),
    low: Math.min(...held.map(minute => minute.low)),
    heldMinutes: held.length,
    windowMinutes: minutes.length,
    premiumBps: both < 0 ? null : (perpetual.get(minutes[both].t) / minutes[both].close - 1) * 10_000,
    premiumTime: both < 0 ? null : minutes[both].t,
    spark: samples(minutes, minute => minute.close),
  };
}

/** Return since the window's first minute, in percent; empty when that minute has no close (no base to index to). */
export function indexedReturns(spotRead) {
  const minutes = grid(spotRead);
  const base = minutes?.[0]?.close;
  return base == null ? [] : samples(minutes, minute => pct(minute.close, base));
}

/** Perpetual over spot (bps) on every fifth minute; null where either leg has no close that minute. */
export function premiumSeries(spotRead, perpetualRead) {
  const minutes = grid(spotRead);
  if (!minutes) return [];
  const perpetual = new Map((grid(perpetualRead) ?? []).map(minute => [minute.t, minute.close]));
  return samples(minutes, minute => minute.close != null && perpetual.get(minute.t) != null ? (perpetual.get(minute.t) / minute.close - 1) * 10_000 : null);
}

/** How many measured coins rose over the window and over the last hour; a coin without a measurement is not counted. */
export function breadth(tiles) {
  const window = tiles.map(tile => tile?.changePct).filter(value => value != null);
  const hour = tiles.map(tile => tile?.change1hPct).filter(value => value != null);
  return {
    measured: window.length,
    up: window.filter(value => value > 0).length,
    measured1h: hour.length,
    up1h: hour.filter(value => value > 0).length,
    averagePct: window.length ? window.reduce((sum, value) => sum + value, 0) / window.length : null,
  };
}

/** Venue × segment grid from candle-store lane tiles; a lane the store does not hold stays absent. */
export function venueGrid(tiles) {
  const venues = [...new Set(tiles.map(tile => tile.venue))].sort();
  return venues.map(venue => ({
    venue,
    spot: tiles.find(tile => tile.venue === venue && tile.segment === 'spot') ?? null,
    perpetual: tiles.find(tile => tile.venue === venue && tile.segment === 'perpetual') ?? null,
  }));
}

/**
 * Store-wide health numbers. A total is shown only when every lane reports the field; otherwise it is null and
 * `unreported` names how many lanes left it out, so a partial sum is never labelled as all lanes.
 */
export function storeHealth(tiles) {
  const all = key => tiles.length > 0 && tiles.every(tile => Number.isFinite(tile[key]));
  const sum = key => all(key) ? tiles.reduce((total, tile) => total + tile[key], 0) : null;
  const unreported = key => tiles.filter(tile => !Number.isFinite(tile[key])).length;
  return {
    lanes: tiles.length,
    lanesLive: tiles.filter(tile => tile.available === true).length,
    lanesUnknown: tiles.filter(tile => typeof tile.available !== 'boolean').length,
    pairsHeld: sum('pairs_held'),
    pairsListed: sum('pairs_listed'),
    coverage7d: all('coverage_7d') ? sum('coverage_7d') / tiles.length : null,
    gaps7d: sum('gaps_7d'),
    oldestMinuteAge: all('last_minute_age_s') ? Math.max(...tiles.map(tile => tile.last_minute_age_s)) : null,
    unreported: { pairs: Math.max(unreported('pairs_held'), unreported('pairs_listed')), coverage: unreported('coverage_7d'), gaps: unreported('gaps_7d'), age: unreported('last_minute_age_s') },
  };
}

/**
 * Window statistics for the coin detail. Horizons use fixed grid positions; high/low and the largest drop are over
 * held minutes and say how many; traded value only when every minute is final and carries a volume.
 */
export function coinStats(spotRead, perpetualRead) {
  const minutes = grid(spotRead);
  if (!minutes) return null;
  const index = lastIndex(minutes);
  if (index < 0) return null;
  const last = minutes[index];
  const held = minutes.filter(minute => minute.close != null);
  let peak = null, drawdown = null;
  for (const minute of held) {
    peak = peak == null ? minute.close : Math.max(peak, minute.close);
    drawdown = Math.min(drawdown ?? 0, minute.close / peak - 1);
  }
  const high = Math.max(...held.map(minute => minute.high)), low = Math.min(...held.map(minute => minute.low));
  const perpetual = new Map((grid(perpetualRead) ?? []).map(minute => [minute.t, minute.close]));
  const premium = minutes.filter(minute => minute.close != null && perpetual.get(minute.t) != null).map(minute => (perpetual.get(minute.t) / minute.close - 1) * 10_000);
  const volumeMissing = minutes.filter(minute => minute.volume == null).length;
  return {
    heldMinutes: held.length,
    windowMinutes: minutes.length,
    returnWindowPct: pct(last.close, minutes[0].close),
    return1hPct: pct(last.close, minutes[index - 60]?.close),
    rangePct: (high / low - 1) * 100,
    maxDrawdownPct: drawdown == null ? null : drawdown * 100,
    volumeQuote: volumeMissing === 0 ? minutes.reduce((sum, minute) => sum + minute.volume * minute.close, 0) : null,
    volumeMissingMinutes: volumeMissing,
    premium: premium.length ? { mean: premium.reduce((sum, value) => sum + value, 0) / premium.length, min: Math.min(...premium), max: Math.max(...premium), minutes: premium.length } : null,
  };
}

/** Human labels and groups for the V5 market-context features; an unknown feature keeps its id under "Other". */
const FEATURE_LABELS = {
  'spot.advancers': ['Breadth', 'Spot coins up (1m)'],
  'spot.decliners': ['Breadth', 'Spot coins down (1m)'],
  'spot.unchanged': ['Breadth', 'Spot coins unchanged (1m)'],
  'spot.pressure_original_1m': ['Breadth', 'Spot pressure (−3 … +3)'],
  'spot.pressure_missingness_lower': ['Breadth', 'Pressure, missing counted down'],
  'spot.pressure_missingness_upper': ['Breadth', 'Pressure, missing counted up'],
  'spot.return_median_pct.1m': ['Returns', 'Spot median return (1m)'],
  'derivatives.matched_return_median_pct.1m': ['Returns', 'Perpetual median return (1m)'],
  'derivatives.spot_perp_return_divergence_pct.1m': ['Returns', 'Spot − perpetual return gap (1m)'],
  'spot.venue_dispersion_range_median_pct.1m': ['Dispersion', 'Spot venue spread, median (1m)'],
  'derivatives.venue_dispersion_range_median_pct.1m': ['Dispersion', 'Perpetual venue spread, median (1m)'],
  'spot.assets_valid': ['Coverage', 'Spot coins with data'],
  'spot.assets_expected': ['Coverage', 'Spot coins expected'],
  'spot.asset_coverage_fraction': ['Coverage', 'Spot coin coverage'],
  'spot.venues_valid': ['Coverage', 'Spot venue pairs qualified this minute (V5 feed rule)'],
  'spot.venues_expected': ['Coverage', 'Spot venue pairs the V5 feed expects'],
  'spot.venue_coverage_fraction': ['Coverage', 'Spot venue coverage'],
  'derivatives.venues_valid': ['Coverage', 'Perpetual venue pairs qualified this minute (V5 feed rule)'],
  'derivatives.venues_expected': ['Coverage', 'Perpetual venue pairs the V5 feed expects'],
  'derivatives.venue_coverage_fraction': ['Coverage', 'Perpetual venue coverage'],
  'derivatives.matched_assets': ['Coverage', 'Coins with spot and perpetual'],
};
export const FEATURE_GROUPS = ['Breadth', 'Returns', 'Dispersion', 'Coverage', 'Other'];

/** Display text for one feature value in its owner unit; a non-numeric or unqualified value is said, not guessed. */
export function featureText(value, unit) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(number)) return value == null ? '—' : String(value);
  if (unit === 'fraction_0_1') return `${(number * 100).toFixed(0)}%`;
  if (unit === 'percent' || unit === 'percentage_points') return `${number > 0 ? '+' : ''}${number.toFixed(3)}${unit === 'percent' ? '%' : ' pp'}`;
  if (/count$/.test(unit ?? '')) return Number.isInteger(number) ? String(number) : number.toFixed(1);
  if (/pressure/.test(unit ?? '')) return `${number > 0 ? '+' : ''}${number.toFixed(2)}`;
  return Math.abs(number) >= 100 ? number.toFixed(0) : number.toPrecision(4);
}

export function featureRows(features) {
  return Object.entries(features ?? {}).map(([id, row]) => {
    const [group, label] = FEATURE_LABELS[id] ?? ['Other', id.replaceAll('_', ' ')];
    const numeric = typeof row?.value === 'number' ? row.value : typeof row?.value === 'string' && row.value.trim() !== '' ? Number(row.value) : NaN;
    return { id, group, label, unit: row?.unit ?? '', status: row?.status ?? 'UNKNOWN', value: row?.value ?? null, numeric: Number.isFinite(numeric) ? numeric : null, text: featureText(row?.value, row?.unit) };
  }).sort((a, b) => FEATURE_GROUPS.indexOf(a.group) - FEATURE_GROUPS.indexOf(b.group) || a.label.localeCompare(b.label));
}
