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

const DECIMAL = /^-?\d+(\.\d+)?$/;
const decimal = value => (typeof value === 'string' && value.length <= 64 && DECIMAL.test(value) ? Number(value) : null);
const money = (value, digits = 2) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "No report since HH:MM:SS UTC", or "No report yet" when nothing has ever been read. */
function noReport(lastOkMs) {
  const at = utcClock(lastOkMs);
  return at ? `No report since ${at}` : 'No report yet';
}

function v5Chip(v5) {
  const base = { id: 'v5', label: 'V5', to: '/bots' };
  if (!v5.bound) return { ...base, tone: 'grey', text: 'No paper bot bound', short: 'V5 n/a' };
  if (v5.pending) return { ...base, tone: 'grey', text: 'Reading the owner report', short: 'V5 …' };
  if (!v5.current) return { ...base, tone: 'grey', text: noReport(v5.lastOkMs), short: 'V5 no report' };
  if (v5.entryHold === true) return { ...base, tone: 'amber', text: 'Buying paused by an owner hold', short: 'V5 paused' };
  return { ...base, tone: 'green', text: 'Running', short: 'V5 running' };
}

function helmChip(helm) {
  const base = { id: 'helm', label: 'Helm', to: '/helm' };
  if (!helm.read) return { ...base, tone: 'grey', text: helm.failed ? noReport(helm.lastOkMs) : 'Reading Helm', short: helm.failed ? 'Helm no report' : 'Helm …' };
  // A failed refresh keeps no value as current: only the last-report time is shown.
  if (helm.failed) return { ...base, tone: 'grey', text: noReport(helm.lastOkMs), short: 'Helm no report' };
  const { text, good } = helmHeadline(helm.read);
  const stopped = !!helm.read.status?.reasons?.includes('runtime_stopped');
  const fresh = helm.read.state === 'FRESH';
  const tone = good && fresh ? 'green' : stopped ? 'red' : fresh ? 'amber' : 'grey';
  const short = tone === 'green' ? (text === 'Running' ? 'Helm running' : 'Helm waiting') : tone === 'red' ? 'Helm stopped' : tone === 'amber' ? 'Helm not buying' : 'Helm unknown';
  return { ...base, tone, text, short };
}

function dataChip(data) {
  const base = { id: 'data', label: 'Market data', to: '/' };
  if (!data.configured) return { ...base, tone: 'grey', text: 'No candle store on this deployment', short: 'Data n/a' };
  if (data.pending) return { ...base, tone: 'grey', text: 'Reading the candle store', short: 'Data …' };
  if (data.failed || !Number.isFinite(data.slowestLagS)) return { ...base, tone: 'grey', text: noReport(data.lastOkMs), short: 'Data no report' };
  const lag = Math.max(0, Math.round(data.slowestLagS));
  const late = data.slowestLagS > DATA_LAG_AMBER_S;
  return { ...base, tone: late ? 'amber' : 'green', text: `${late ? 'Late' : 'Live'} · slowest lane ${lag} s`, short: late ? 'Data late' : 'Data live' };
}

function equityChip(wallet) {
  const base = { id: 'equity', label: 'V5 equity', to: '/money' };
  const equity = wallet.current ? decimal(wallet.equity) : null;
  if (equity === null) return { ...base, tone: 'grey', text: '—', short: '—' };
  const unit = typeof wallet.unit === 'string' && wallet.unit ? ` ${wallet.unit}` : '';
  const funding = decimal(wallet.funding), flows = decimal(wallet.flows);
  // Change since start only when the start funding is published and no external cash moved in or out.
  const change = funding !== null && flows === 0 ? equity - funding : null;
  const delta = change === null ? 'change since start —' : `${change > 0 ? '+' : ''}${money(change)} since start`;
  return { ...base, tone: 'green', text: `${money(equity)}${unit} · ${delta}`, short: money(equity) };
}

/**
 * @param {{ nowMs: number,
 *   v5: { bound: boolean, pending: boolean, current: boolean, entryHold: boolean | null, lastOkMs: number | null },
 *   helm: { read: object | null, failed: boolean, lastOkMs: number | null },
 *   data: { configured: boolean, pending: boolean, failed: boolean, slowestLagS: number | null, lastOkMs: number | null },
 *   wallet: { current: boolean, equity: unknown, funding: unknown, flows: unknown, unit: unknown },
 *   updatedMs: number | null }} input
 */
export function statusStrip(input) {
  const chips = [v5Chip(input.v5), helmChip(input.helm), dataChip(input.data), equityChip(input.wallet)];
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

/** Slowest lane age in seconds across lanes that published one, or null when no lane did. */
export function slowestLaneAge(tiles) {
  if (!Array.isArray(tiles)) return null;
  const ages = tiles.filter(tile => tile && tile.available !== false).map(tile => tile.last_minute_age_s).filter(age => typeof age === 'number' && Number.isFinite(age) && age >= 0);
  return ages.length ? Math.max(...ages) : null;
}
