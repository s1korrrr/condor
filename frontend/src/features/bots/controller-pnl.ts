import type { BotsPageResponse } from '@/lib/api';
import { expireNativeBotPage } from '@/lib/bot-monitoring';
import { isPaperBot } from '@/features/trading-visuals/sources';

export type ControllerPnlRow = { id: string; pair: string; quote: string; realized: number | null; unrealized: number | null; total: number | null; volume: number | null };
export type ControllerPnlView = { rows: ControllerPnlRow[]; reason: string | null; observedAt: number | null; quote: string | null; total: number | null; realized: number | null; unrealized: number | null;
  /** True for a paper bot: simulated PnL that never counts as capital. */
  simulated?: boolean };
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Native controller performance includes active executors and retained positions.
 * The retained-position runtime summary is a separate diagnostic and does not gate this scope. */
export function projectControllerPnl(payload: unknown, bot: string, now: number): ControllerPnlView {
  const unavailable = (reason: string): ControllerPnlView => ({ rows: [], reason, observedAt: null, quote: null, total: null, realized: null, unrealized: null });
  if (!payload || typeof payload !== 'object') return unavailable('Waiting for native controller performance.');
  const data = payload as BotsPageResponse;
  if (!Array.isArray(data.bots) || !Array.isArray(data.controllers) || data.bots.some(row => !row || typeof row.bot_name !== 'string') || data.controllers.some(row => !row || typeof row.bot_name !== 'string')) return unavailable('Controller performance response is invalid.');
  const bots = data.bots.filter(row => row.bot_name === bot);
  if (bots.length !== 1) return unavailable('Selected bot performance identity is unavailable.');
  const selected = bots[0];
  const rawRows = data.controllers.filter(row => row.bot_name === bot);
  const current = expireNativeBotPage({ ...data, bots, controllers: rawRows }, true, now)!;
  if (!current.bots[0].controller_count_current || !Number.isInteger(selected.num_controllers) || selected.num_controllers < 0 || current.controllers.length !== selected.num_controllers) return unavailable('Native controller performance is missing, incomplete or expired.');
  const identities = new Set<string>();
  const rows: ControllerPnlRow[] = [];
  for (const controller of current.controllers) {
    if (typeof controller.controller_id !== 'string' || !controller.controller_id.trim() || identities.has(controller.controller_id)) return unavailable('Controller identity or quote currency is ambiguous.');
    let pairs = typeof controller.trading_pair === 'string' && /^[A-Z0-9]+-[A-Z0-9]+$/.test(controller.trading_pair) ? [controller.trading_pair] : [];
    const symbols = controller.custom_info?.symbols;
    const entries = symbols && typeof symbols === 'object' && !Array.isArray(symbols) ? Object.entries(symbols) : [];
    if (entries.length >= 2 || !pairs.length) {
      if (entries.length < 2 || entries.some(([pair, row]) => !/^[A-Z0-9]+-[A-Z0-9]+$/.test(pair) || !row || typeof row !== 'object' || Array.isArray(row))) return unavailable('Controller identity or quote currency is ambiguous.');
      pairs = entries.map(([pair]) => pair).sort();
    }
    const quotes = new Set(pairs.map(pair => pair.split('-')[1]));
    if (quotes.size !== 1) return unavailable('Controller identity or quote currency is ambiguous.');
    identities.add(controller.controller_id);
    // A multi-symbol controller publishes one aggregate PnL. Do not duplicate it per pair.
    rows.push({ id: controller.controller_id, pair: pairs.join(', '), quote: pairs[0].split('-')[1], realized: finite(controller.realized_pnl_quote), unrealized: finite(controller.unrealized_pnl_quote), total: finite(controller.global_pnl_quote), volume: finite(controller.volume_traded) });
  }
  rows.sort((a, b) => a.pair.localeCompare(b.pair) || a.id.localeCompare(b.id));
  if (rows.some(row => row.total !== null && row.realized !== null && row.unrealized !== null && Math.abs(row.total - row.realized - row.unrealized) > 0.000001)) return unavailable('Native controller PnL components do not reconcile.');
  const currencies = new Set(rows.map(row => row.quote));
  const quote = currencies.size === 1 ? rows[0].quote : null;
  const sum = (key: 'total' | 'realized' | 'unrealized') => quote && rows.length > 0 && rows.every(row => row[key] !== null) ? rows.reduce((total, row) => total + row[key]!, 0) : null;
  return { rows, quote, reason: rows.length ? null : 'No current controllers reported.', observedAt: finite(selected.performance_received_at), total: sum('total'), realized: sum('realized'), unrealized: sum('unrealized') };
}

/** A paper bot's runtime observation older than this no longer stands for its current simulated PnL. */
const PAPER_RUNTIME_STALE_MS = 120_000;
const numeric = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
};

/** A paper bot publishes no controller performance to the API. Its simulated PnL comes from the reporting
 * runtime summary, which has the live shape (`summary.realized_pnl_quote` + `unrealized_pnl_quote`, the same
 * total as a live controller's `global_pnl_quote`). Always `simulated`; a live bot never reads this. */
export function projectPaperRuntimePnl(payload: unknown, bot: string, now: number): ControllerPnlView {
  const unavailable = (reason: string): ControllerPnlView => ({ rows: [], reason, observedAt: null, quote: null, total: null, realized: null, unrealized: null, simulated: true });
  if (!isPaperBot(bot)) return unavailable('Only a paper bot reads simulated runtime PnL.');
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const runtime = root.runtime_status && typeof root.runtime_status === 'object' ? root.runtime_status as Record<string, unknown> : null;
  if (!runtime || runtime.bot_name !== bot) return unavailable('Waiting for the paper runtime observation.');
  if (runtime.simulated === false || root.simulated === false) return unavailable('The paper runtime observation is not marked simulated.');
  const summary = runtime.summary && typeof runtime.summary === 'object' ? runtime.summary as Record<string, unknown> : null;
  if (!summary || summary.pnl_available === false) return unavailable('Paper PnL is not available yet.');
  const realized = numeric(summary.realized_pnl_quote), unrealized = numeric(summary.unrealized_pnl_quote);
  const observed = typeof runtime.updated_at === 'string' ? Date.parse(runtime.updated_at) : NaN;
  if (realized === null || unrealized === null) return unavailable('Paper PnL is not available yet.');
  if (!Number.isFinite(observed) || observed > now + 5_000) return unavailable('The paper runtime observation has no usable time.');
  if (now - observed > PAPER_RUNTIME_STALE_MS) return unavailable('The paper runtime observation is stale.');
  const pairs = Array.isArray(runtime.controllers) ? runtime.controllers.flatMap(row => row && typeof row === 'object' && typeof (row as { pair?: unknown }).pair === 'string' && /^[A-Z0-9]+-[A-Z0-9]+$/.test((row as { pair: string }).pair) ? [(row as { pair: string }).pair] : []) : [];
  const quotes = new Set(pairs.map(pair => pair.split('-')[1]));
  if (quotes.size !== 1) return unavailable('Paper quote currency is ambiguous.');
  return { rows: [], reason: null, observedAt: observed / 1000, quote: [...quotes][0], total: realized + unrealized, realized, unrealized, simulated: true };
}

/** The PnL a bot card shows: native controller performance, or for a paper bot (which has none in the API)
 * its simulated runtime PnL. A paper view is always marked `simulated`. */
export function projectBotPnl(page: unknown, bootstrap: unknown, bot: string, now: number): ControllerPnlView {
  const native = projectControllerPnl(page, bot, now);
  if (!isPaperBot(bot)) return native;
  return native.total !== null ? { ...native, simulated: true } : projectPaperRuntimePnl(bootstrap, bot, now);
}
