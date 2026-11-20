/** How the Sessions page names and words a row of the dashboard's own action journal (workspace.sqlite). */
import { utcMin } from './format.mjs';

/** Row kinds the journal writes (condor/v5/state.py). Anything else is shown as unreported, never guessed. */
const KINDS = { inspect: 'Source inspection', report: 'Report', loop: 'Report loop' };

export function sessionKindLabel(session) {
  const label = typeof session?.kind === 'string' && Object.hasOwn(KINDS, session.kind) ? KINDS[session.kind] : null;
  if (!label) return 'Kind not reported';
  return session.kind === 'loop' && session.loop_id ? `${label} · ${session.loop_id}` : label;
}

/**
 * Summaries stored before the inspect handler wrote plain words hold `availability=<epoch ms>` and `ready=True|False`.
 * Only those two exact patterns are rewritten; every other text, and any value that is not a time, is left as stored.
 */
export function sessionSummaryText(summary) {
  if (typeof summary !== 'string') return summary;
  return summary
    .replace(/(?<=; )availability=(\d{1,16})(?=;|$)/, (whole, ms) => {
      const time = utcMin(Number(ms));
      return time ? `available ${time}` : whole;
    })
    .replace(/(?<=; )ready=(True|False)(?=;|$)/, (_whole, value) => (value === 'True' ? 'ready' : 'not ready'));
}
