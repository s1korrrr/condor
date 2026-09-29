import type { BotsPageResponse } from '@/lib/api';
import { expireNativeBotPage } from '@/lib/bot-monitoring';

export type ControllerPnlRow = { id: string; pair: string; quote: string; realized: number | null; unrealized: number | null; total: number | null; volume: number | null };
export type ControllerPnlView = { rows: ControllerPnlRow[]; reason: string | null; observedAt: number | null; quote: string | null; total: number | null; realized: number | null; unrealized: number | null };
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
    if (typeof controller.controller_id !== 'string' || !controller.controller_id.trim() || identities.has(controller.controller_id) || typeof controller.trading_pair !== 'string' || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(controller.trading_pair)) return unavailable('Controller identity or quote currency is ambiguous.');
    identities.add(controller.controller_id);
    rows.push({ id: controller.controller_id, pair: controller.trading_pair, quote: controller.trading_pair.split('-')[1], realized: finite(controller.realized_pnl_quote), unrealized: finite(controller.unrealized_pnl_quote), total: finite(controller.global_pnl_quote), volume: finite(controller.volume_traded) });
  }
  rows.sort((a, b) => a.pair.localeCompare(b.pair) || a.id.localeCompare(b.id));
  if (rows.some(row => row.total !== null && row.realized !== null && row.unrealized !== null && Math.abs(row.total - row.realized - row.unrealized) > 0.000001)) return unavailable('Native controller PnL components do not reconcile.');
  const currencies = new Set(rows.map(row => row.quote));
  const quote = currencies.size === 1 ? rows[0].quote : null;
  const sum = (key: 'total' | 'realized' | 'unrealized') => quote && rows.length > 0 && rows.every(row => row[key] !== null) ? rows.reduce((total, row) => total + row[key]!, 0) : null;
  return { rows, quote, reason: rows.length ? null : 'No current controllers reported.', observedAt: finite(selected.performance_received_at), total: sum('total'), realized: sum('realized'), unrealized: sum('unrealized') };
}
