import type { CurrentPortfolio, HistoryPoint, Holding } from '@/features/portfolio/model';
import { portfolioSummary } from '@/features/portfolio/model';

function asAmount(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return value;
  return null;
}

/** Connector balances from a live bot runtime_status. Shared-wallet observation, not V2-owned capital. */
export function nativeWalletFromRuntime(input: { balances: unknown; observedAt: string | null }): CurrentPortfolio | null {
  if (!Array.isArray(input.balances) || input.balances.length === 0) return null;
  if (!input.observedAt || !Number.isFinite(Date.parse(input.observedAt))) return null;
  const holdings: Holding[] = [];
  let priced = 0;
  const unpriced: string[] = [];
  for (const row of input.balances) {
    if (!row || typeof row !== 'object') return null;
    const token = typeof (row as { asset?: unknown }).asset === 'string' ? (row as { asset: string }).asset.trim() : '';
    const total = asAmount((row as { total_balance?: unknown }).total_balance);
    const available = asAmount((row as { available_balance?: unknown }).available_balance) ?? total;
    const value = asAmount((row as { value_quote?: unknown }).value_quote);
    if (!token || total == null) return null;
    const valueNum = value == null ? NaN : Number(value);
    if (!Number.isFinite(valueNum) || valueNum < 0) {
      unpriced.push(token);
      holdings.push({
        token, total, available: available ?? total, locked: '0', price: null, value: null,
        quote_currency: 'USDT', valuation_source: 'native-runtime-status', price_observed_at: input.observedAt,
      });
      continue;
    }
    priced += valueNum;
    const totalNum = Number(total);
    const availableNum = Number(available);
    const lockedNum = Number.isFinite(totalNum) && Number.isFinite(availableNum) ? totalNum - availableNum : 0;
    holdings.push({
      token, total, available: available ?? total,
      locked: Number.isFinite(lockedNum) && lockedNum > 0 ? String(lockedNum) : '0',
      price: totalNum > 0 ? String(valueNum / totalNum) : '0',
      value,
      quote_currency: 'USDT', valuation_source: 'native-runtime-status', price_observed_at: input.observedAt,
    });
  }
  return {
    observed_at: input.observedAt,
    priced_total: String(priced),
    valuation_complete: unpriced.length === 0,
    unpriced_assets: unpriced,
    holdings,
  };
}

function availableUsdc(current: CurrentPortfolio | null, fresh: boolean): string | null {
  if (!fresh || !current) return null;
  const rows = current.holdings.filter(holding => holding.token === 'USDC');
  if (rows.length !== 1) return null;
  const value = rows[0].available;
  return /^\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? value : null;
}

export type CapitalModel = {
  equity: { value: string | null; complete: boolean; unpriced: number; unit: string };
  periodPnl: { value: string | null; reason: string };
  todayPnl: { value: string | null; reason: string };
  availableQuote: { value: string | null; unit: string };
  deployed: { value: string | null; reason: string };
  allocation: { token: string; value: number; weight: number | null }[];
  cashValue: number | null;
  nonCashValue: number | null;
  holdings: Holding[];
  flows: { observed_at: string; token: string; delta: string; kind: string }[];
  drawdown: number | null;
  volatility: number | null;
  sharpe: number | null;
  sampleDays: number;
  concentration: { top3: number | null; top5: number | null };
  history: HistoryPoint[];
};

export type CapitalDashboardOverlay = {
  period_pnl?: { value: string | null; reason_code?: string | null };
  today_pnl?: { value: string | null; reason_code?: string | null };
  drawdown?: string | null;
  volatility?: string | null;
  sharpe?: string | null;
  sample_days?: number;
  concentration?: { top3?: string | null; top5?: string | null };
};

function n(value: string | null | undefined): number | null {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

/** Observed drawdown on admitted complete observations. Not a daily statistic. */
export function observedDrawdown(points: HistoryPoint[]): number | null {
  const values = points.filter(point => point.valuation_complete).map(point => n(point.priced_total)).filter((value): value is number => value != null && value > 0);
  if (values.length < 2) return null;
  let peak = values[0], worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    worst = Math.min(worst, value / peak - 1);
  }
  return worst;
}

export function concentration(holdings: Holding[], pricedTotal: number | null) {
  const nonCash = holdings.filter(row => row.token !== 'USDC' && row.token !== 'USDT' && n(row.value) != null && n(row.value)! > 0)
    .map(row => n(row.value)!)
    .sort((a, b) => b - a);
  const denom = nonCash.reduce((sum, value) => sum + value, 0);
  if (denom <= 0) return { top3: null, top5: null };
  const share = (count: number) => nonCash.slice(0, count).reduce((sum, value) => sum + value, 0) / denom;
  void pricedTotal;
  return { top3: share(3), top5: share(5) };
}

export function observedEquityChanges(points: HistoryPoint[]): number[] {
  const complete = points.filter(point => point.valuation_complete && Number.isFinite(Number(point.priced_total)));
  const values: number[] = [];
  for (let index = 1; index < complete.length; index += 1) {
    values.push(Number(complete[index].priced_total) - Number(complete[index - 1].priced_total));
  }
  return values;
}

export function projectCapitalModel(input: {
  current: CurrentPortfolio | null;
  history: HistoryPoint[] | null;
  changes?: { observed_at: string; token: string; delta: string; kind: string }[];
  now: number;
  failed?: boolean;
  accountPerformanceAvailable?: boolean;
  dashboard?: CapitalDashboardOverlay | null;
  unit?: string;
}): CapitalModel {
  const summary = portfolioSummary(input.current, input.now, input.failed);
  const holdings = summary.current && input.current ? input.current.holdings : [];
  const cash = availableUsdc(input.current, summary.current);
  const cashValue = cash == null || !summary.current ? null : n(cash);
  const equity = summary.pricedTotal;
  const deployed = equity == null || cashValue == null ? null : equity - cashValue;
  const dash = input.dashboard;
  const dashNum = (value: string | null | undefined) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    equity: { value: equity == null ? null : String(equity), complete: summary.complete, unpriced: summary.unpricedCount, unit: input.unit ?? 'USDT' },
    periodPnl: {
      value: dash?.period_pnl?.value ?? null,
      reason: dash?.period_pnl?.reason_code === 'FLOW_COVERAGE_INCOMPLETE' || !dash?.period_pnl?.value
        ? 'Account net PnL needs opening equity, closing equity and a complete signed flow journal.'
        : 'Flow-adjusted owner projection.',
    },
    todayPnl: { value: dash?.today_pnl?.value ?? null, reason: 'Today is a partial UTC day. No admitted midnight snapshot exists.' },
    availableQuote: { value: cash, unit: 'USDC' },
    deployed: { value: deployed == null ? null : String(deployed), reason: deployed == null ? 'Non-cash exposure needs complete cash and equity observations.' : 'Non-cash account exposure. Not V2-owned capital.' },
    allocation: summary.allocation,
    cashValue,
    nonCashValue: deployed,
    holdings,
    flows: input.changes ?? [],
    drawdown: dashNum(dash?.drawdown) ?? observedDrawdown(input.history ?? []),
    volatility: dashNum(dash?.volatility),
    sharpe: dashNum(dash?.sharpe),
    sampleDays: dash?.sample_days ?? 0,
    concentration: {
      top3: dashNum(dash?.concentration?.top3) ?? concentration(holdings, equity).top3,
      top5: dashNum(dash?.concentration?.top5) ?? concentration(holdings, equity).top5,
    },
    history: input.history ?? [],
  };
}
