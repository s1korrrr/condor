import { FleetFillsError, mergeFleetFillPages, type FleetFillItem, type FleetFillReceipt, type FleetFillsBot, type FleetFillsPage } from '@/lib/fleet-fills';
import type { PanelState } from '@/features/quant-ops/panel-state';

/** Pure projection of the loaded fleet-fills pages into what the B40 panel shows. Nothing here fetches or recomputes a number. */

const REASON_TEXT: Record<string, string> = {
  SOURCE_UNAVAILABLE: 'the owner read failed or timed out',
  NOT_CONFIGURED: 'no reporting source configured',
  INVALID: 'invalid reader response',
  PAPER_EXCLUDED: 'paper bot, never read',
  NO_REGISTRY: 'no bot registry',
  PARTIAL_COVERAGE: 'at least one bot could not be read',
};
/** Known reason codes get words; a code this client does not know is shown as sent. */
export const fleetFillsReasonText = (reason: string | null): string => reason === null ? 'no reason given' : REASON_TEXT[reason] ?? reason;

const PAIR = /^[A-Za-z0-9]{1,20}[-/][A-Za-z0-9]{1,20}$/;
/** The pair filter the server accepts: BASE-QUOTE (a slash is accepted for the dash). An empty draft is "no filter"; a partial one is not sent. */
export function pairFilterFromDraft(draft: string): { pair: string | null; valid: boolean } {
  const text = draft.trim();
  if (!text) return { pair: null, valid: true };
  return PAIR.test(text) ? { pair: text.toUpperCase().replace('/', '-'), valid: true } : { pair: null, valid: false };
}

export type UnavailableBot = { bot: string; label: string; reason: string };

export type FleetFillsView = {
  rows: FleetFillItem[];
  state: PanelState;
  /** Visible lines naming what the feed does not contain. They never replace the glyph; they explain it. */
  notices: string[];
  /** The honest end of the list, or null while more pages follow. */
  footnote: string | null;
  emptyText: string;
  /** Rows matching the filters across the whole window, and whether another page can be loaded. */
  matched: number | null;
  hasMore: boolean;
  unavailable: UnavailableBot[];
  /** True when the feed has no usable answer at all (no rows were ever read, or every reader is down). */
  missing: boolean;
};

/** Bot name for a row: the generation is its own badge, so a name that already starts with it ("V1 · ok_rsi") drops it. */
export function fleetFillBotName(item: Pick<FleetFillItem, 'bot' | 'display_name' | 'generation'>): string {
  const prefix = item.generation ? `${item.generation} · ` : '';
  return prefix && item.display_name.startsWith(prefix) && item.display_name.length > prefix.length ? item.display_name.slice(prefix.length) : item.display_name;
}

export const RECEIPT_LABEL: Record<FleetFillReceipt, string> = { exact: 'Exact', legacy_6dp: 'Legacy 6dp', unavailable: 'No receipt', unrecognised: 'Unrecognised' };
export const RECEIPT_TITLE: Record<FleetFillReceipt, string> = {
  exact: 'Amount and price are the exchange-receipt strings.',
  legacy_6dp: 'This row predates exact receipts: the owner kept only 6-decimal values. They are shown as stored, not promoted to exact.',
  unavailable: 'No usable amount and price were recorded.',
  unrecognised: 'The server sent a receipt kind this dashboard does not know.',
};

/** `2026-10-02 09:30:15`, UTC; null when the owner stamp had no timezone offset. */
export const fleetFillTime = (timeMs: number | null): string | null => timeMs === null ? null : new Date(timeMs).toISOString().replace('T', ' ').slice(0, 19);

/** Generation and name for a notice: "V3 meridian_v3". */
const botName = (bot: FleetFillsBot) => `${bot.generation ? `${bot.generation} ` : ''}${fleetFillBotName(bot)}`;

function errorState(error: unknown): { state: PanelState; reason: string } {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : null;
  if (status === 401 || status === 403) return { state: { kind: 'unauthorized', reason: 'Not allowed to read fills on this server.' }, reason: 'not allowed to read fills' };
  const reason = error instanceof FleetFillsError ? error.message : error instanceof Error ? error.message : 'Fleet fills request failed.';
  return { state: { kind: 'error', reason }, reason };
}

export function projectFleetFills({ pages, error = null, pending = false, filtered = false }: {
  pages: readonly FleetFillsPage[] | undefined; error?: unknown; pending?: boolean; filtered?: boolean;
}): FleetFillsView {
  const base = { rows: [] as FleetFillItem[], notices: [] as string[], footnote: null, matched: null, hasMore: false, unavailable: [] as UnavailableBot[], missing: false };
  if (!pages?.length) {
    if (error) { const { state, reason } = errorState(error); return { ...base, state, notices: [reason], emptyText: `Fills could not be read: ${reason}.`, missing: true }; }
    return { ...base, state: { kind: 'collecting', reason: pending ? 'Reading the fleet fills feed' : 'Waiting for a server' }, emptyText: 'Reading fills…' };
  }
  const first = pages[0], last = pages[pages.length - 1];
  const rows = mergeFleetFillPages(pages);
  const unavailable = first.bots.filter(bot => bot.status === 'unavailable').map(bot => ({ bot: bot.bot, label: botName(bot), reason: fleetFillsReasonText(bot.reason) }));
  const notices: string[] = [];
  let state: PanelState;
  let emptyText: string;
  const missing = first.status === 'missing';
  if (missing) {
    const why = fleetFillsReasonText(first.reason);
    state = { kind: 'unavailable', reason: `The fleet fills feed has no answer: ${why}.` };
    notices.push(...unavailable.map(bot => `${bot.label}: ${bot.reason}.`));
    emptyText = `No fill reader answered: ${why}. This is not "no fills".`;
  } else if (first.status === 'partial') {
    state = { kind: 'incomplete', reason: unavailable.length ? `Not in this feed: ${unavailable.map(bot => `${bot.label} (${bot.reason})`).join('; ')}.` : `Coverage is partial: ${fleetFillsReasonText(first.reason)}.` };
    notices.push(...(unavailable.length ? unavailable.map(bot => `${bot.label} fills are not in this feed: ${bot.reason}.`) : [`Coverage is partial: ${fleetFillsReasonText(first.reason)}.`]));
    emptyText = filtered ? 'No fill from the bots that answered matches these filters.' : 'The bots that answered have recorded no fills.';
  } else {
    state = { kind: 'fresh' };
    emptyText = filtered ? 'No fill matches these filters.' : 'No fills recorded by any bot.';
  }
  for (const bot of first.bots) {
    const rejected = Object.entries(bot.rejected).filter(([, count]) => count > 0);
    if (rejected.length) notices.push(`${botName(bot)}: ${rejected.reduce((sum, [, count]) => sum + count, 0)} owner rows could not be attributed and are not listed (${rejected.map(([why, count]) => `${why} ${count}`).join(', ')}).`);
  }
  if (error) state = { kind: 'stale', reason: `Showing the last successful read; the latest refresh failed: ${errorState(error).reason}.` };
  const hasMore = last.has_more;
  const excluded = first.bots.filter(bot => bot.status === 'excluded');
  const saturated = first.bots.filter(bot => bot.saturated);
  const footnoteParts: string[] = [];
  if (first.window.truncated && !hasMore) footnoteParts.push(`Older fills are not part of this feed: each bot's newest ${first.window.owner_limit} rows were read${saturated.length ? ` (${saturated.map(botName).join(', ')} reached that limit)` : ''}. Per-bot history stays in each bot's fill records.`);
  if (excluded.length) footnoteParts.push(`Not read (paper): ${excluded.map(botName).join(', ')}.`);
  return { rows, state, notices, footnote: footnoteParts.join(' ') || null, emptyText, matched: first.matched, hasMore, unavailable, missing };
}
