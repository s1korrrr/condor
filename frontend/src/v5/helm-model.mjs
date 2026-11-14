/** Helm page headline from the read state alone: what the runtime itself published, never inferred. */
import { tri, utcMinute } from './shown.mjs';

/**
 * Entry-check results that mean "no entry signal yet" in the engine's signal policies (modular_spot_core/signals.py).
 * Any other hold (symbol_fault, observation_checkpoint_required, fee_reserve_exceeded, atr_unavailable, unknown codes)
 * is not normal waiting and is reported as not buying.
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
    // The controllers' own acquisition gates come first: a gate other than 'ready' (e.g. symbol_fault for a latched
    // coin) holds new buys whatever each coin's entry check says. Unknown or missing gates never count as ready.
    const gates = Array.isArray(status.gates) ? status.gates : [];
    const closed = gates.filter(row => row?.gate !== 'ready');
    if (closed.length) {
      const named = closed.map(row => `${words(row?.gate ?? 'gate not published')}${row?.note ? ` (${row.note})` : ''}`).join('; ');
      return { text: `Running, not buying: ${named}`, good: false };
    }
    const symbols = Array.isArray(status.symbols) ? status.symbols : [];
    // A hold that is not a signal wait (a fault, a missing checkpoint, an unknown code) is never shown as normal idle.
    const blocked = symbols.filter(row => row?.candidate_hold && !SIGNAL_WAIT.has(row.candidate_hold));
    if (blocked.length) {
      const codes = [...new Set(blocked.map(row => row.candidate_hold))].map(words).join(', ');
      return { text: `Running, not buying ${blocked.length === symbols.length ? 'on any coin' : `on ${blocked.map(row => row.pair ?? 'a coin').join(', ')}`}: ${codes}`, good: false };
    }
    // Every coin held only by its entry signal is Helm's normal idle state: it is waiting for a signal.
    if (gates.length && symbols.length && symbols.every(row => row?.candidate_hold)) {
      const holds = [...new Set(symbols.map(row => row.candidate_hold))], statuses = [...new Set(symbols.map(row => row?.status).filter(Boolean))];
      return { text: 'Running, waiting for a signal', good: true, detail: `Every coin idle: ${holds.map(words).join(', ')}${statuses.length ? ` · coin status ${statuses.map(words).join(', ')}` : ''}.` };
    }
    return { text: 'Running', good: true };
  }
  return { text: `Publishing status, ready: ${tri(status?.ready, 'yes', 'no')}`, good: false };
}
