/** How the Sessions page names and words a row of the dashboard's own action journal (workspace.sqlite). */
import { utcMin } from './format.mjs';

const MAX_ADVISOR_TIME_MS = 4_102_444_800_000;

/** Row kinds the journal writes (condor/v5/state.py). Anything else is shown as unreported, never guessed. */
const KINDS = { inspect: 'Source inspection', report: 'Report', loop: 'Report loop' };

export function sessionKindLabel(session) {
  const label = typeof session?.kind === 'string' && Object.hasOwn(KINDS, session.kind) ? KINDS[session.kind] : null;
  if (!label) return 'Kind not reported';
  return session.kind === 'loop' && session.loop_id ? `${label} · ${session.loop_id}` : label;
}

/** Reword only complete legacy inspect records. Snapshot IDs can contain semicolons, so match the final field. */
export function sessionSummaryText(summary, kind) {
  if (kind !== 'inspect' || typeof summary !== 'string') return summary;
  const source = /^(Inspected source snapshot [\s\S]+); availability=([1-9]\d*)$/.exec(summary);
  if (source) {
    const ms = Number(source[2]);
    return ms <= MAX_ADVISOR_TIME_MS ? `${source[1]}; available ${utcMin(ms)}` : summary;
  }
  return summary.replace(
    /^(Inspected paper status [\s\S]+); ready=(True|False)(; controllers=(?:0|[1-9]\d*); mode=PAPER \(simulated wallet\))$/,
    (_whole, prefix, ready, suffix) => `${prefix}; ${ready === 'True' ? 'ready' : 'not ready'}${suffix}`,
  );
}
