/**
 * Pure projections for the one-page V5 Market view. Inputs are candle-store owner reads that the server has
 * already validated (condor/v5/candles.py). This module never fills a gap, converts a quote currency or merges
 * spot with perpetual values: a missing minute stays null and every derived number names its source.
 */

export const MARKET_COINS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
/** Reference lanes for prices and the spot/perpetual premium: one venue so both legs share quote and clock. */
export const REFERENCE = { venue: 'binance', quote: 'USDT', spot: 'binance__spot', perpetual: 'binance__perpetual' };
export const MINUTES_PER_YEAR = 525_600;

const COLUMN = { t: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };

function columnIndex(columns, name) {
  const index = Array.isArray(columns) ? columns.indexOf(name) : -1;
  return index >= 0 ? index : COLUMN[name];
}

/** Closed minutes with a numeric close, as {t, close, high, low} in seconds. Missing minutes are dropped, not zeroed. */
export function closes(read) {
  if (!read || !Array.isArray(read.buckets)) return [];
  const t = columnIndex(read.columns, 't'), close = columnIndex(read.columns, 'close');
  const high = columnIndex(read.columns, 'high'), low = columnIndex(read.columns, 'low');
  return read.buckets
    .filter(row => Array.isArray(row) && Number.isFinite(row[t]) && Number.isFinite(row[close]) && row[close] > 0)
    .map(row => ({ t: row[t], close: row[close], high: Number.isFinite(row[high]) ? row[high] : row[close], low: Number.isFinite(row[low]) ? row[low] : row[close] }));
}

/** The owner window's last closed minute (seconds); the newest close is current only when it is this minute. */
export function windowEnd(read) {
  return read && Number.isFinite(read.end) ? read.end : null;
}

/**
 * Time-bucketed samples over the read window: one point per `step`-minute bucket holding the bucket's last close,
 * and an explicit null for a bucket with no close, so charts break across missing time instead of joining it.
 */
export function sampled(rows, step, value) {
  if (!rows.length) return [];
  const width = step * 60, first = Math.floor(rows[0].t / width) * width, last = rows[rows.length - 1].t;
  const byBucket = new Map();
  for (const row of rows) byBucket.set(Math.floor(row.t / width) * width, row);
  const out = [];
  for (let bucket = first; bucket <= last; bucket += width) {
    const row = byBucket.get(bucket);
    out.push(row ? { time: row.t * 1000, value: value(row) } : { time: (bucket + width - 60) * 1000, value: null });
  }
  return out;
}

/** Price tile for one coin from its reference spot candles; null when fewer than two closes exist. */
export function coinTile(coin, spotRead, perpetualRead) {
  const spot = closes(spotRead);
  if (spot.length < 2) return null;
  const first = spot[0], last = spot[spot.length - 1];
  const returns = [];
  for (let index = 1; index < spot.length; index += 1) {
    // Only adjacent minutes form a one-minute return; a gap breaks the chain instead of stretching it.
    if (spot[index].t - spot[index - 1].t === 60) returns.push(spot[index].close / spot[index - 1].close - 1);
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / (returns.length || 1);
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length || 1);
  // The premium is shown only for the same minute as the shown price; an older overlap is not current.
  const perpetual = closes(perpetualRead).find(row => row.t === last.t);
  const end = windowEnd(spotRead);
  // Last-hour move from the close exactly one hour before the shown price; unknown when that minute is missing.
  const hourAgo = spot.find(row => row.t === last.t - 3600);
  return {
    coin,
    last: last.close,
    lastTime: last.t,
    firstTime: first.t,
    current: end == null || last.t >= end,
    changePct: (last.close / first.close - 1) * 100,
    change1hPct: hourAgo ? (last.close / hourAgo.close - 1) * 100 : null,
    high: Math.max(...spot.map(row => row.high)),
    low: Math.min(...spot.map(row => row.low)),
    volatilityPct: returns.length >= 30 ? Math.sqrt(variance * MINUTES_PER_YEAR) * 100 : null,
    premiumBps: perpetual ? (perpetual.close / last.close - 1) * 10_000 : null,
    spark: sampled(spot, 5, row => row.close),
  };
}

/** Each coin's return since the first close in the window, in percent, one point per `step` minutes, null in gaps. */
export function indexedReturns(spotRead, step = 5) {
  const spot = closes(spotRead);
  if (!spot.length) return [];
  const base = spot[0].close;
  return sampled(spot, step, row => (row.close / base - 1) * 100);
}

/** Perpetual over spot on the same venue and quote, in basis points, only where both legs closed that minute. */
export function premiumSeries(spotRead, perpetualRead) {
  const spot = new Map(closes(spotRead).map(row => [row.t, row.close]));
  return closes(perpetualRead)
    .filter(row => spot.has(row.t))
    .map(row => ({ time: row.t * 1000, value: (row.close / spot.get(row.t) - 1) * 10_000 }));
}

/**
 * Mean per fixed `minutes`-wide clock window (stamped at the window's last minute). A window with no value is an
 * explicit null, so an average never spans more clock time than its label says and charts break across gaps.
 */
export function averaged(points, minutes = 30) {
  const values = points.filter(point => point.value != null);
  if (!values.length) return [];
  const width = minutes * 60_000, first = Math.floor(values[0].time / width) * width, last = values[values.length - 1].time;
  const sums = new Map();
  for (const point of values) {
    const bucket = Math.floor(point.time / width) * width;
    const entry = sums.get(bucket) ?? { sum: 0, count: 0 };
    entry.sum += point.value; entry.count += 1; sums.set(bucket, entry);
  }
  const out = [];
  for (let bucket = first; bucket <= last; bucket += width) {
    const entry = sums.get(bucket);
    out.push({ time: bucket + width - 60_000, value: entry ? entry.sum / entry.count : null });
  }
  return out;
}

/** How many coins rose over the full window and over the last hour (from each coin's exact hour-ago close). */
export function breadth(tiles) {
  const present = tiles.filter(Boolean);
  const lastHour = present.map(tile => tile.change1hPct).filter(value => value != null);
  return {
    coins: present.length,
    up24h: present.filter(tile => tile.changePct > 0).length,
    up1h: lastHour.filter(value => value > 0).length,
    measured1h: lastHour.length,
    averagePct: present.length ? present.reduce((sum, tile) => sum + tile.changePct, 0) / present.length : null,
  };
}

/** Latest deviation from the cross-venue median per venue, from one owner cross-venue read (bps, owner-computed). */
export function crossLatest(coin, view) {
  if (!view || !Array.isArray(view.series)) return [];
  return view.series.flatMap(line => {
    const points = (line.deviation_bps ?? []).filter(point => Array.isArray(point) && Number.isFinite(point[1]));
    const closesSeen = (line.close ?? []).filter(point => Array.isArray(point) && Number.isFinite(point[1]));
    if (!points.length) return [];
    const [time, bps] = points[points.length - 1];
    return [{ venue: line.venue, coin, pair: line.pair, bps, time, close: closesSeen.length ? closesSeen[closesSeen.length - 1][1] : null }];
  });
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
    pairsHeld: sum('pairs_held'),
    pairsListed: sum('pairs_listed'),
    coverage7d: all('coverage_7d') ? sum('coverage_7d') / tiles.length : null,
    gaps7d: sum('gaps_7d'),
    oldestMinuteAge: all('last_minute_age_s') ? Math.max(...tiles.map(tile => tile.last_minute_age_s)) : null,
    unreported: { pairs: Math.max(unreported('pairs_held'), unreported('pairs_listed')), coverage: unreported('coverage_7d'), gaps: unreported('gaps_7d'), age: unreported('last_minute_age_s') },
  };
}

/**
 * Per-market statistics over one window of reference candles. Volume is base volume × close (quote units of the
 * reference pair); drawdown is the largest close-to-close fall from a running peak inside the window.
 */
export function coinStats(spotRead, perpetualRead) {
  const spot = closes(spotRead);
  if (spot.length < 2) return null;
  const volumeIndex = columnIndex(spotRead.columns, 'volume'), timeIndex = columnIndex(spotRead.columns, 't');
  const volumeByTime = new Map(spotRead.buckets.filter(row => Array.isArray(row) && Number.isFinite(row[volumeIndex])).map(row => [row[timeIndex], row[volumeIndex]]));
  const last = spot[spot.length - 1];
  const byTime = new Map(spot.map(row => [row.t, row]));
  const since = seconds => {
    // The horizon starts at exactly that minute; if it has no close the return over that horizon is unknown.
    const start = byTime.get(last.t - seconds);
    return start ? (last.close / start.close - 1) * 100 : null;
  };
  let peak = spot[0].close, drawdown = 0;
  for (const row of spot) { peak = Math.max(peak, row.close); drawdown = Math.min(drawdown, row.close / peak - 1); }
  const high = Math.max(...spot.map(row => row.high)), low = Math.min(...spot.map(row => row.low));
  const premium = premiumSeries(spotRead, perpetualRead).map(point => point.value);
  return {
    minutes: spot.length,
    windowMinutes: Math.round((last.t - spot[0].t) / 60) + 1,
    return1hPct: since(3600),
    return6hPct: since(6 * 3600),
    returnWindowPct: (last.close / spot[0].close - 1) * 100,
    rangePct: (high / low - 1) * 100,
    maxDrawdownPct: drawdown * 100,
    // Traded value only when every closed minute carries a volume; a partial sum would read as the whole window.
    volumeQuote: spot.every(row => Number.isFinite(volumeByTime.get(row.t))) ? spot.reduce((sum, row) => sum + volumeByTime.get(row.t) * row.close, 0) : null,
    volumeMissingMinutes: spot.filter(row => !Number.isFinite(volumeByTime.get(row.t))).length,
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
  'spot.venues_valid': ['Coverage', 'Spot venue pairs with data'],
  'spot.venues_expected': ['Coverage', 'Spot venue pairs expected'],
  'spot.venue_coverage_fraction': ['Coverage', 'Spot venue coverage'],
  'derivatives.venues_valid': ['Coverage', 'Perpetual venue pairs with data'],
  'derivatives.venues_expected': ['Coverage', 'Perpetual venue pairs expected'],
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
