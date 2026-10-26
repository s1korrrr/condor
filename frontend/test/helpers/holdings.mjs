// Builders for `fleet-holdings.v1` test bodies. They only fill contract defaults (null facts, empty lists);
// every unit, value, count and total in a test is written by hand. Bodies pass through the real decoder.
import fs from 'node:fs';

export const holdingsExample = () => JSON.parse(fs.readFileSync(new URL('../../../tests/fixtures/fleet_holdings/holdings.example.json', import.meta.url), 'utf8'));

export function holdingsPairRow(over) {
  const [base, quote] = over.pair.split('-');
  return {
    controller_id: null, base_asset: base, quote_asset: quote, state: 'HOLDING',
    units: null, entry_cost_quote: null, breakeven_price: null, mark_price: null, mark_source: null, marked_value_quote: null,
    unrealized_pnl_quote: null, realized_pnl_quote: null, fees_quote: null, running_executor_count: 0, small: false,
    ...over,
  };
}

/** An admitted bot entry. `held`, `value` and the other totals are the test's hand-written expectations. */
export function holdingsEntry(bot, pairs, { held = null, value = null, known = value ?? '0', unrealized = null, entryCost = null, state = 'current', observedAtMs, reasons = [], paper = false, quote = 'USDC' } = {}) {
  return {
    bot, paper, state, reason: null, observed_at_ms: observedAtMs, stale_after_ms: 30000, snapshot_id: `${bot}:snap`, owner_boot_id: null,
    quote_asset: quote, inventory_complete: held !== null, value_complete: value !== null, incomplete_reasons: reasons,
    registered_pair_count: pairs.length, held_pair_count: held,
    totals: { marked_value_quote: value, known_marked_value_quote: known, unrealized_pnl_quote: unrealized, entry_cost_quote: entryCost },
    pairs: pairs.map(holdingsPairRow),
  };
}

export function unavailableEntry(bot, reason = 'SOURCE_UNAVAILABLE') {
  return {
    bot, paper: false, state: 'unavailable', reason, observed_at_ms: null, stale_after_ms: 30000, snapshot_id: null, owner_boot_id: null,
    quote_asset: null, inventory_complete: false, value_complete: false, incomplete_reasons: [], registered_pair_count: null, held_pair_count: null,
    totals: null, pairs: [],
  };
}

/** A decoded read of one or more entries, served at `servedAtMs` and received locally at `receivedAtMs`. */
export function holdingsRead(lib, entries, { servedAtMs, receivedAtMs = servedAtMs, server = 'main' }) {
  const body = lib.parseFleetHoldings({ schema: 'fleet-holdings.v1', server, generated_at_ms: servedAtMs, served_at_ms: servedAtMs, bots: entries });
  return { body, receivedAtMs };
}

/** `BotHoldings` for one entry observed `ageMs` before it was served, received at `now`. */
export function botHoldingsAt(lib, entry, now, ageMs = 1000) {
  const withTime = entry.state === 'unavailable' ? entry : { ...entry, observed_at_ms: now - ageMs };
  return lib.botHoldings(holdingsRead(lib, [withTime], { servedAtMs: now, receivedAtMs: now }), entry.bot);
}
