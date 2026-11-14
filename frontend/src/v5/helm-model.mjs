/** Helm page headline from the read state alone: what the runtime itself published, never inferred. */
import { tri, utcMinute } from './shown.mjs';

export function helmHeadline(read) {
  if (!read) return { text: '', good: false };
  if (read.state === 'UNBOUND') return { text: 'Not connected to this dashboard', good: false };
  // No status file yet: the runtime has not published (not started in this state directory). Not an error.
  if (read.state === 'UNAVAILABLE' && read.reason === 'HELM_STATUS_MISSING') return { text: 'Not running (no status published yet)', good: false };
  if (read.state === 'UNAVAILABLE') return { text: `Status file unreadable (${String(read.reason ?? 'unknown').replaceAll('_', ' ')})`, good: false };
  const status = read.status;
  const lastAt = utcMinute(status ? status.generated_at * 1000 : null) ?? 'unknown time';
  const stopped = !!status?.reasons?.includes('runtime_stopped');
  if (stopped) return { text: `Stopped (last status ${lastAt})`, good: false };
  if (read.state !== 'FRESH') return { text: `No status update since ${lastAt}; current state unknown`, good: false };
  if (status?.ready === true) return { text: 'Running', good: true };
  return { text: `Publishing status, ready: ${tri(status?.ready, 'yes', 'no')}`, good: false };
}
