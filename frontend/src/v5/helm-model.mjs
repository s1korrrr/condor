/** Helm page headline from the read state alone: what the runtime itself published, never inferred. */
import { age, coin, ownerTitleText, count, price, utcMin } from './format.mjs';
import { tri } from './shown.mjs';

const SCALE = 10n ** 30n;
const words = value => typeof value === 'string' && value ? value.replaceAll('_', ' ') : 'not published';

function decimal(value) {
  if (typeof value !== 'string' || !/^(?:\d{1,18}(?:\.\d{1,30})?|\.\d{1,30})$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole || '0') * SCALE + BigInt(fraction.padEnd(30, '0'));
}

function points(value) {
  const fraction = (value % SCALE).toString().padStart(30, '0').replace(/0+$/, '');
  return `${value / SCALE}${fraction ? `.${fraction}` : ''}`;
}

/**
 * The server's own time at the read, moved on by the seconds since the response arrived: the one clock every age on
 * the Helm surfaces is judged against. Undated reads give undefined, and nothing is then called current.
 */
export function helmReadTimeS(read, elapsedS) {
  const readAt = read?.observed_at, now = typeof readAt === 'number' ? readAt + elapsedS : NaN;
  return Number.isFinite(now) ? now : undefined;
}

export function helmCoinRow(row, { fresh, nowS }) {
  const signal = row.signal;
  const known = typeof nowS === 'number';
  const time = utcMin(signal?.at == null ? null : signal.at * 1000, known ? nowS * 1000 : undefined);
  const ageS = time == null || !known ? null : nowS - signal.at;
  const problem = !signal ? 'Signal not published by Helm' : !fresh ? 'Helm status is stale'
    : ageS == null ? 'Signal time not published' : ageS < 0 ? 'Signal time is in the future'
    : ageS > 30 ? 'Signal is stale' : null;
  const line = decimal(signal?.oversold), rsi = decimal(signal?.rsi);
  const lineKnown = line != null && line <= 100n * SCALE;
  const result = {
    pair: row.pair,
    rule: !signal ? 'Rule not published by Helm' : problem ? `Rule unavailable · ${problem}`
      : !Number.isSafeInteger(signal.rsi_length) || signal.rsi_length <= 0 || !lineKnown ? 'Rule not published by Helm'
      : `Buys when RSI(${count(signal.rsi_length)}) crosses up through ${coin(signal.oversold)}`,
    rsi: `— · ${problem ?? 'RSI or line not published by Helm'}`, rsiTitle: undefined,
    atr: `— · ${problem ?? 'ATR not published by Helm'}`,
    decision: `— · ${problem ?? 'Entry decision not published'}`,
    sample: !time ? 'Signal time not published' : ageS == null ? `${time} · age unknown` : `${time} · ${ageS < 0 ? 'ahead of this read' : `${age(ageS)} ago`}${!fresh || ageS > 30 ? ' · stale' : ''}`,
    owner: fresh ? `State: ${words(row.status)} · entry hold: ${words(row.candidate_hold)}` : '— · Helm status is stale',
    held: '—', breakeven: '—', bagNote: !fresh ? 'Helm status is stale' : 'Bag not published by Helm',
  };
  if (!problem) {
    if (rsi != null && rsi <= 100n * SCALE && lineKnown) {
      const distance = rsi - line;
      result.rsiTitle = `RSI ${ownerTitleText(signal.rsi)} − line ${ownerTitleText(signal.oversold)} = ${ownerTitleText(`${distance < 0n ? '−' : ''}${points(distance < 0n ? -distance : distance)}`)}`;
      result.rsi = `RSI ${coin(signal.rsi)}, ${distance === 0n ? 'on the line' : `${coin(points(distance < 0n ? -distance : distance))} points ${distance < 0n ? 'below' : 'above'} the line`}`;
      if (distance <= 0n) result.rsi += `: a buy needs RSI to rise above ${coin(signal.oversold)}`;
    }
    const atr = decimal(signal.atr_fraction), min = decimal(signal.min_atr_fraction), max = decimal(signal.max_atr_fraction);
    if (atr != null) {
      if (min == null || max == null) result.atr = '— · ATR band not published by Helm';
      else if (min > max) result.atr = '— · ATR band is invalid';
      else if (!Number.isSafeInteger(signal.atr_length) || signal.atr_length <= 0) result.atr = '— · ATR length not published by Helm';
      else result.atr = `ATR(${count(signal.atr_length)})/close ${coin(signal.atr_fraction)}, ${atr < min ? 'below' : atr > max ? 'above' : 'inside'} the ${coin(signal.min_atr_fraction)}–${coin(signal.max_atr_fraction)} band`;
    }
    if (typeof signal.decision?.enter === 'boolean' && signal.decision.reason) {
      result.decision = `Entry signal: ${signal.decision.enter ? 'yes' : 'no'} · Helm: ${words(signal.decision.reason)}`;
    }
  }
  if (fresh && row.bag?.held_amount != null) {
    const held = row.bag.held_amount;
    if (held === 0 || decimal(held) === 0n) result.bagNote = 'Nothing held';
    else {
      result.held = coin(held, row.pair.split('-')[0]);
      result.breakeven = price(row.bag.breakeven_price);
      result.bagNote = row.bag.breakeven_price == null ? 'Breakeven not published by Helm' : '';
    }
  }
  return result;
}

/** Time, age and reason of a published point in time; "not published" when the owner gives nothing, never a guess. */
function whenAndWhy(atS, reason, nowS) {
  const time = utcMin(typeof atS === 'number' ? atS * 1000 : null, typeof nowS === 'number' ? nowS * 1000 : undefined);
  const why = typeof reason === 'string' && reason ? words(reason) : null;
  if (!time) return why ? `time not published · ${why}` : 'not published';
  const ago = typeof nowS !== 'number' ? '' : nowS < atS ? ' · ahead of this read' : ` · ${age(nowS - atS)} ago`;
  return `${time}${ago} · ${why ?? 'reason not published'}`;
}

/** One coin's last decision as Helm published it (condor's `last_decision {at, reason}`). */
export function helmLastDecision(row, { nowS } = {}) {
  return whenAndWhy(row?.last_decision?.at, row?.last_decision?.reason, nowS);
}

/** A count is current only when its own observation is this young: the same bound as the status (30 s) and the signals. */
const COUNT_FRESH_S = 30;

/**
 * Helm's active-executor count with the time of the report it came from. The status file's own time does not date the
 * count, so `current` is true only when the count's observation is dated and within COUNT_FRESH_S of this read.
 * `when` is its time and age (null when undated); an incomplete roster says how many controllers it covered.
 */
export function helmExecutors(status, { nowS } = {}) {
  const read = status?.active_executors;
  if (!read || typeof read.count !== 'number') {
    const incomplete = Number.isSafeInteger(read?.covered) && Number.isSafeInteger(read?.of) ? `incomplete: ${count(read.covered)} of ${count(read.of)} controllers` : null;
    return { value: 'Not published', note: incomplete ?? 'the Helm runtime status has no complete executor report', count: null, current: false, incomplete };
  }
  const known = typeof nowS === 'number';
  const time = utcMin(typeof read.observed_at === 'number' ? read.observed_at * 1000 : null, known ? nowS * 1000 : undefined);
  const ageS = time && known ? nowS - read.observed_at : null;
  const ago = ageS == null ? null : ageS < 0 ? 'ahead of this read' : `${age(ageS)} ago`;
  return { value: count(read.count), note: time ? `reported ${time}${ago ? ` · ${ago}` : ''}` : 'count time not published', count: read.count,
    current: ageS != null && ageS >= 0 && ageS <= COUNT_FRESH_S, when: time ? `${time}${ago ? ` (${ago})` : ''}` : null };
}

/** The count as a phrase; unless it is current it carries its own time, or says the time is not published. */
function executorPhrase(executors) {
  if (executors.count == null) return `active executors not published${executors.incomplete ? ` (${executors.incomplete})` : ''}`;
  const what = executors.count === 0 ? 'no active executors' : `${count(executors.count)} active executor${executors.count === 1 ? '' : 's'}`;
  return executors.current ? what : executors.when ? `${what} as of ${executors.when}` : `${what}, count time not published`;
}

/** What Helm itself says it has been doing: active executors and the newest published decision, each "not published" when it is. */
function helmActivity(status, nowS) {
  const parts = [executorPhrase(helmExecutors(status, { nowS }))];
  const decided = (Array.isArray(status.symbols) ? status.symbols : []).filter(row => typeof row?.last_decision?.at === 'number');
  const newest = decided.reduce((best, row) => (best && best.last_decision.at >= row.last_decision.at ? best : row), null);
  parts.push(newest ? `latest decision ${newest.pair ?? 'a coin'} ${helmLastDecision(newest, { nowS })}` : 'no decision time published');
  return `Activity: ${parts.join(' · ')}.`;
}

/**
 * Entry-check results that mean "no entry signal yet" in the engine's signal policies (modular_spot_core/signals.py).
 * Only these upgrade a ready gate to "waiting for a signal"; any other coin hold (planner codes such as bag_gap_not_met,
 * same_candle, cooldown; atr_unavailable; unknown) leaves the headline neutral with the coin named.
 */
const SIGNAL_WAIT = new Set(['no_rebound', 'low_volatility', 'high_volatility', 'no_turn', 'score_below_minimum', 'no_breakout']);

export function helmHeadline(read, { nowS } = {}) {
  if (!read) return { text: '', good: false };
  if (read.state === 'UNBOUND') return { text: 'Not connected to this dashboard', good: false };
  // No status file: only absence is known. The runtime may be stopped or still starting; neither is claimed.
  if (read.state === 'UNAVAILABLE' && read.reason === 'HELM_STATUS_MISSING') return { text: 'No status file published; current state unknown', good: false };
  if (read.state === 'UNAVAILABLE') return { text: `Status file unreadable (${words(read.reason ?? 'unknown')})`, good: false };
  const status = read.status;
  const lastAt = utcMin(status ? status.generated_at * 1000 : null) ?? 'unknown time';
  const stopped = !!status?.reasons?.includes('runtime_stopped');
  if (stopped) return { text: `Stopped (last status ${lastAt})`, good: false };
  if (read.state !== 'FRESH') return { text: `No status update since ${lastAt}; current state unknown`, good: false };
  if (status?.ready === true) {
    if (status.operator_entry_paused === true) return { text: 'Running, not buying: new entries paused by the operator', good: false };
    if (status.entries_held) return { text: `Running, not buying: ${words(status.entries_held)}`, good: false };
    // Red comes only from owner gate fields: a controller gate other than 'ready' holds new buys (e.g. symbol_fault
    // with the faulted pairs in its note). Coin holds are the first "no" of a per-coin preview, not a gate: they can
    // only upgrade the text to "waiting for a signal", never turn it red.
    const gates = Array.isArray(status.gates) ? status.gates : [];
    // A published gate other than 'ready' is closed (red); a missing or withheld gate is unknown (neutral), never closed.
    const closed = gates.filter(row => typeof row?.gate === 'string' && row.gate !== 'ready');
    if (closed.length) {
      const named = closed.map(row => `${words(row.gate)}${row?.note ? ` (${row.note})` : ''}`).join('; ');
      return { text: `Running, not buying: ${named}`, good: false };
    }
    if (!gates.length || gates.some(row => typeof row?.gate !== 'string')) return { text: 'Running; entry gate not published', good: null };
    const symbols = Array.isArray(status.symbols) ? status.symbols : [];
    const other = symbols.filter(row => !SIGNAL_WAIT.has(row?.candidate_hold));
    if (symbols.length && !other.length) {
      // "No entry signal" is all the holds say. Idle would also claim no executor and no decision, which they do not show.
      // Only a count observed within the freshness bound is present tense; an old or undated one stays in the detail.
      const executors = helmExecutors(status, { nowS });
      const active = executors.current ? executors.count : 0;
      return { text: active ? `Running, no entry signal · ${count(active)} active executor${active === 1 ? '' : 's'}` : 'Running, waiting for a signal', good: true,
        detail: `No coin has an entry signal: ${[...new Set(symbols.map(row => row.candidate_hold))].map(words).join(', ')}. ${helmActivity(status, nowS)}` };
    }
    const holds = other.map(row => `${row?.pair ?? 'a coin'}: ${row?.candidate_hold ? words(row.candidate_hold) : 'no entry check published this tick'}`).join(' · ');
    return { text: 'Running, entry gate ready', good: null, detail: `${holds ? `${holds}. ` : ''}${helmActivity(status, nowS)}` };
  }
  return { text: `Publishing status, ready: ${tri(status?.ready, 'yes', 'no')}`, good: false };
}
