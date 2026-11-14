/** Helm page headline from the read state alone: what the runtime itself published, never inferred. */
import { tri, utcMinute } from './shown.mjs';

/**
 * Entry-check results that mean "no entry signal yet" in the engine's signal policies (modular_spot_core/signals.py).
 * Only these upgrade a ready gate to "waiting for a signal"; any other coin hold (planner codes such as bag_gap_not_met,
 * same_candle, cooldown; atr_unavailable; unknown) leaves the headline neutral with the coin named.
 */
const SIGNAL_WAIT = new Set(['no_rebound', 'low_volatility', 'high_volatility', 'no_turn', 'score_below_minimum', 'no_breakout']);

export function helmHeadline(read) {
  if (!read) return { text: '', good: false };
  if (read.state === 'UNBOUND') return { text: 'Not connected to this dashboard', good: false };
  // No status file: only absence is known. The runtime may be stopped or still starting; neither is claimed.
  if (read.state === 'UNAVAILABLE' && read.reason === 'HELM_STATUS_MISSING') return { text: 'No status file published; current state unknown', good: false };
  if (read.state === 'UNAVAILABLE') return { text: `Status file unreadable (${String(read.reason ?? 'unknown').replaceAll('_', ' ')})`, good: false };
  const status = read.status;
  const lastAt = utcMinute(status ? status.generated_at * 1000 : null) ?? 'unknown time';
  const stopped = !!status?.reasons?.includes('runtime_stopped');
  if (stopped) return { text: `Stopped (last status ${lastAt})`, good: false };
  if (read.state !== 'FRESH') return { text: `No status update since ${lastAt}; current state unknown`, good: false };
  if (status?.ready === true) {
    const words = code => String(code).replaceAll('_', ' ');
    if (status.operator_entry_paused === true) return { text: 'Running, not buying: new entries paused by the operator', good: false };
    if (status.entries_held) return { text: `Running, not buying: ${words(status.entries_held)}`, good: false };
    // Red comes only from owner gate fields: a controller gate other than 'ready' holds new buys (e.g. symbol_fault
    // with the faulted pairs in its note). Coin holds are the first "no" of a per-coin preview, not a gate: they can
    // only upgrade the text to "waiting for a signal", never turn it red.
    const gates = Array.isArray(status.gates) ? status.gates : [];
    const closed = gates.filter(row => row?.gate !== 'ready');
    if (closed.length) {
      const named = closed.map(row => `${words(row?.gate ?? 'gate not published')}${row?.note ? ` (${row.note})` : ''}`).join('; ');
      return { text: `Running, not buying: ${named}`, good: false };
    }
    if (!gates.length) return { text: 'Running; entry gate not published', good: null };
    const symbols = Array.isArray(status.symbols) ? status.symbols : [];
    const other = symbols.filter(row => !SIGNAL_WAIT.has(row?.candidate_hold));
    if (symbols.length && !other.length) {
      return { text: 'Running, waiting for a signal', good: true, detail: `Every coin idle: ${[...new Set(symbols.map(row => row.candidate_hold))].map(words).join(', ')}.` };
    }
    return { text: 'Running, entry gate ready', good: null, detail: other.map(row => `${row?.pair ?? 'a coin'}: ${row?.candidate_hold ? words(row.candidate_hold) : 'no entry check published this tick'}`).join(' · ') || undefined };
  }
  return { text: `Publishing status, ready: ${tri(status?.ready, 'yes', 'no')}`, good: false };
}
