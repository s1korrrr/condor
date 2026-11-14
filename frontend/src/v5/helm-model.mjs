/** Helm page headline from the read state alone: what the runtime itself published, never inferred. */
import { tri, utcMinute } from './shown.mjs';

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
    // Every coin held by its own entry check is Helm's normal idle state: it is waiting for its entry signal.
    const symbols = Array.isArray(status.symbols) ? status.symbols : [];
    if (symbols.length && symbols.every(row => row?.candidate_hold)) {
      const holds = [...new Set(symbols.map(row => row.candidate_hold))], statuses = [...new Set(symbols.map(row => row?.status).filter(Boolean))];
      return { text: 'Running, waiting for a signal', good: true, detail: `Every coin idle: ${holds.map(words).join(', ')}${statuses.length ? ` · coin status ${statuses.map(words).join(', ')}` : ''}.` };
    }
    return { text: 'Running', good: true };
  }
  return { text: `Publishing status, ready: ${tri(status?.ready, 'yes', 'no')}`, good: false };
}
