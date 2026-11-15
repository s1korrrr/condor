/**
 * Status strip state: one pure function from the reads the shell already holds to the chips shown on every page.
 * Rules (dashboard UI review, sections 2 and 4): a chip whose source failed or is not current turns grey and names
 * the time of its last good report; an old value is never shown as current; a number that is not complete and
 * current is "—". Colour: green = working, amber = should be working and is not, red = stopped, grey = no data.
 */
import { helmHeadline } from './helm-model.mjs';

const MAX_DATE_MS = 8.64e15;
/** Slowest candle lane older than this is amber. */
export const DATA_LAG_AMBER_S = 180;

/** "HH:MM:SS UTC" for epoch milliseconds, or null when the value is not a representable time. */
export function utcClock(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_MS ? `${new Date(ms).toISOString().slice(11, 19)} UTC` : null;
}

/** Helm's own freshness line (condor/v5/helm.py STALE_AFTER_SECONDS). */
export const HELM_STALE_S = 30;

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
/** Exact decimal text as {neg, digits: BigInt, scale}, or null. */
function decimal(value) {
  const match = typeof value === 'string' && value.length <= 64 ? DECIMAL.exec(value) : null;
  return match ? { neg: match[1] === '-', digits: BigInt(match[2] + (match[3] ?? '')), scale: (match[3] ?? '').length } : null;
}
const scaled = (d, scale) => (d.neg ? -1n : 1n) * d.digits * 10n ** BigInt(scale - d.scale);
/** Exact a - b as cents, rounded half away from zero. */
function centsOf(value, scale) {
  const unit = 10n ** BigInt(Math.max(0, scale - 2));
  if (scale <= 2) return value * 10n ** BigInt(2 - scale);
  const neg = value < 0n, abs = neg ? -value : value;
  const cents = (abs + unit / 2n) / unit;
  return neg ? -cents : cents;
}
/** "1,234.56" from cents (BigInt), true minus for negatives. */
function money(cents) {
  const neg = cents < 0n, abs = neg ? -cents : cents;
  const int = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','), frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '−' : ''}${int}.${frac}`;
}

/** "No report since HH:MM:SS UTC", or "No report yet" when nothing has ever been read. */
function noReport(lastOkMs) {
  const at = utcClock(lastOkMs);
  return at ? `No report since ${at}` : 'No report yet';
}

function v5Chip(v5) {
  const base = { id: 'v5', label: 'V5', to: '/bots' };
  if (!v5.bound) return { ...base, tone: 'grey', text: 'No paper bot bound', short: 'V5 n/a' };
  // A received owner hold (operator pause, emergency halt, native latch or entry hold), from the current snapshot or
  // newer retained safety evidence, is shown even while the next snapshot is still loading; it is never hidden.
  if (v5.entryHold === true) return { ...base, tone: 'amber', text: v5.emergency ? 'Emergency halt reported: buying stopped' : 'Buying paused by an owner hold', short: 'V5 paused' };
  if (v5.pending) return { ...base, tone: 'grey', text: 'Reading the owner report', short: 'V5 …' };
  if (!v5.current) return { ...base, tone: 'grey', text: noReport(v5.lastOkMs), short: 'V5 no report' };
  // A complete current report is not proof of running: the owner must publish pause, emergency and latch as clear.
  if (v5.runKnown !== true) return { ...base, tone: 'grey', text: 'Report current · run state not published', short: 'V5 unknown' };
  return { ...base, tone: 'green', text: 'Running', short: 'V5 running' };
}

function helmChip(helm, nowMs) {
  const base = { id: 'helm', label: 'Helm', to: '/helm' };
  if (!helm.read) return { ...base, tone: 'grey', text: helm.failed ? noReport(helm.lastOkMs) : 'Reading Helm', short: helm.failed ? 'Helm no report' : 'Helm …' };
  // A failed refresh keeps no value as current: only the last-report time is shown.
  if (helm.failed) return { ...base, tone: 'grey', text: noReport(helm.lastOkMs), short: 'Helm no report' };
  // Age Helm's status with the clock since the read arrived, so a cached FRESH read expires at Helm's own 30 s line.
  // Counted from when the request was sent when known (delivery time is age too), else from arrival (Terra R3 B3).
  const sinceMs = Number.isFinite(helm.requestedAtMs) ? helm.requestedAtMs : helm.receivedAtMs;
  const elapsedS = Number.isFinite(sinceMs) ? Math.max(0, (nowMs - sinceMs) / 1000) : Infinity;
  const status = helm.read.status;
  const ageS = Number.isFinite(status?.age_s) ? status.age_s + elapsedS
    : Number.isFinite(status?.generated_at) ? Math.max(0, nowMs / 1000 - status.generated_at) : Infinity;
  const read = helm.read.state === 'FRESH' && ageS > HELM_STALE_S ? { ...helm.read, state: 'STALE' } : helm.read;
  const { text, good } = helmHeadline(read);
  const stopped = !!read.status?.reasons?.includes('runtime_stopped');
  const fresh = read.state === 'FRESH';
  // Helm's headline is tri-state: green only when it says so, amber when it says not buying, neutral (grey) otherwise.
  const tone = stopped ? 'red' : !fresh ? 'grey' : good === true ? 'green' : good === false ? 'amber' : 'grey';
  const short = tone === 'green' ? 'Helm waiting' : tone === 'red' ? 'Helm stopped' : tone === 'amber' ? 'Helm not buying' : fresh && good === null ? 'Helm running' : 'Helm unknown';
  return { ...base, tone, text, short };
}

function dataChip(data, nowMs) {
  const base = { id: 'data', label: 'Market data', to: '/' };
  if (!data.configured) return { ...base, tone: 'grey', text: 'No candle store on this deployment', short: 'Data n/a' };
  if (data.pending) return { ...base, tone: 'grey', text: 'Reading the candle store', short: 'Data …' };
  const lanes = data.lanes;
  if (data.failed || !lanes || !lanes.total) return { ...base, tone: 'grey', text: noReport(data.lastOkMs), short: 'Data no report' };
  // A successful summary in which no lane is live is an explicit outage, not "no report" (Sol R2 W4 S2).
  if (!Number.isFinite(lanes.lagS)) return { ...base, tone: 'amber', text: `${lanes.total - lanes.live} of ${lanes.total} lanes not live`, short: 'Data partial' };
  // The owner's age at read time plus local time since the read arrived, so the chip ages between polls.
  const sinceMs = Number.isFinite(data.requestedAtMs) ? data.requestedAtMs : data.receivedAtMs;
  const elapsedS = Number.isFinite(sinceMs) ? Math.max(0, (nowMs - sinceMs) / 1000) : 0;
  const lagS = lanes.lagS + elapsedS, lag = Math.max(0, Math.round(lagS));
  // A lane that is unavailable or does not report its age is never read as live.
  if (lanes.live < lanes.total) return { ...base, tone: 'amber', text: `${lanes.total - lanes.live} of ${lanes.total} lanes not live · slowest live lane ${lag} s`, short: 'Data partial' };
  // A recent candle is not "Live" when the owner's own lane health is amber/red or it lists partition errors (Terra R3 B2).
  if (lanes.healthy < lanes.total) return { ...base, tone: 'amber', text: `${lanes.total - lanes.healthy} of ${lanes.total} lanes not green in owner health · slowest lane ${lag} s`, short: 'Data partial' };
  const late = lagS > DATA_LAG_AMBER_S;
  return { ...base, tone: late ? 'amber' : 'green', text: `${late ? 'Late' : 'Live'} · slowest lane ${lag} s`, short: late ? 'Data late' : 'Data live' };
}

function equityChip(wallet) {
  const base = { id: 'equity', label: 'V5 equity', to: '/money' };
  const equity = wallet.current ? decimal(wallet.equity) : null;
  if (equity === null) return { ...base, tone: 'grey', text: '—', short: '—' };
  const unit = typeof wallet.unit === 'string' && wallet.unit ? ` ${wallet.unit}` : '';
  const funding = decimal(wallet.funding), flows = decimal(wallet.flows);
  const equityText = money(centsOf(scaled(equity, equity.scale), equity.scale));
  // Change since start only when the start funding is published and no external cash moved in or out; exact.
  let delta = 'change since start —';
  if (funding !== null && flows !== null && flows.digits === 0n) {
    const scale = Math.max(equity.scale, funding.scale), cents = centsOf(scaled(equity, scale) - scaled(funding, scale), scale);
    delta = `${cents > 0n ? '+' : ''}${money(cents)} since start`;
  }
  return { ...base, tone: 'green', text: `${equityText}${unit} · ${delta}`, short: equityText };
}

/**
 * @param {{ nowMs: number,
 *   v5: { bound: boolean, pending: boolean, current: boolean, runKnown?: boolean, entryHold: boolean | null, lastOkMs: number | null },
 *   helm: { read: object | null, failed: boolean, lastOkMs: number | null, receivedAtMs?: number | null, requestedAtMs?: number | null },
 *   data: { configured: boolean, pending: boolean, failed: boolean, lanes: { total: number, live: number, healthy: number, lagS: number | null } | null, lastOkMs: number | null, receivedAtMs?: number | null, requestedAtMs?: number | null },
 *   wallet: { current: boolean, equity: unknown, funding: unknown, flows: unknown, unit: unknown },
 *   updatedMs: number | null }} input
 */
export function statusStrip(input) {
  const chips = [v5Chip(input.v5), helmChip(input.helm, input.nowMs), dataChip(input.data, input.nowMs), equityChip(input.wallet)];
  // Things to check: every state-bearing chip that is not green (the equity figure carries no judgement).
  const toCheck = chips.filter(chip => chip.id !== 'equity' && chip.tone !== 'green').length;
  const at = utcClock(input.updatedMs);
  const ago = at ? Math.max(0, Math.floor((input.nowMs - input.updatedMs) / 1000)) : null;
  return {
    chips,
    toCheck,
    checkText: toCheck === 0 ? 'Nothing to check' : `${toCheck} ${toCheck === 1 ? 'thing' : 'things'} to check`,
    shortCheckText: String(toCheck),
    updated: at ? `Updated ${at} · ${ago} s ago` : 'Not updated yet',
  };
}

/**
 * Candle lanes: how many there are, how many are live (available === true with a published age), how many of those are
 * healthy by the owner (health "green" and an empty partition_errors list), and the slowest live lane's age in seconds
 * (null when none). An unavailable or unknown lane is counted, never dropped.
 */
export function laneHealth(tiles) {
  if (!Array.isArray(tiles)) return null;
  const live = tiles.filter(tile => tile && tile.available === true && typeof tile.last_minute_age_s === 'number' && Number.isFinite(tile.last_minute_age_s) && tile.last_minute_age_s >= 0);
  const healthy = live.filter(tile => tile.health === 'green' && Array.isArray(tile.partition_errors) && tile.partition_errors.length === 0);
  return { total: tiles.length, live: live.length, healthy: healthy.length, lagS: live.length ? Math.max(...live.map(tile => tile.last_minute_age_s)) : null };
}
