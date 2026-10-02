import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { authFetch } from '@/lib/auth-token';
import { projectControllerPnl, type ControllerPnlView } from '@/features/bots/controller-pnl';
import { projectFills, projectQuantBotSummary, projectQuantCycles, type FillRow, type QuantBotSummary, type QuantCycles } from '@/features/bots/quant-roster';
import { botWindow, fleetDailyBars, fleetSeries, fleetWindow, parseBotHistory, restartTimes, sameQuote, type BotHistory, type BotSample, type BotWindow, type FleetDay, type FleetPoint, type FleetWindow, type HistoryRange } from './fleet-performance';

/**
 * Fan-out reads for every registered bot. They use `useQueries`, so the bot list can change length
 * without breaking hook order, and they share query keys with the per-bot Capital reads (one cache entry
 * per bot and range). A read that fails marks only that bot; callers state "N of M bots" from the result.
 */

async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(9000)]), cache: 'no-store' });
  if (!response.ok) throw Object.assign(new Error(`Request failed (${response.status})`), { status: response.status });
  return response.json();
}

type Read = { payload: unknown; issue: string | null };
async function readOptional(path: string, signal: AbortSignal): Promise<Read> {
  try {
    const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: 'no-store' });
    if (!response.ok) return { payload: null, issue: response.status === 401 || response.status === 403 ? `Access denied (${response.status})` : response.status === 404 ? 'Endpoint unavailable (404)' : `Read failed (${response.status})` };
    return { payload: await response.json(), issue: null };
  } catch {
    return { payload: null, issue: 'Read unavailable' };
  }
}

export type FleetWindowSpec = { id: string; range: HistoryRange; from: number; to: number };

export type FleetPerformance = {
  pending: boolean;
  bots: string[];
  /** Histories for the page range, one per bot (empty samples when the read failed). */
  histories: BotHistory[];
  daily: FleetWindow;
  weekly: FleetWindow;
  monthly: FleetWindow;
  /** The selected page range. */
  range: FleetWindow;
  /** Fleet PnL per UTC day over the last 30 days (or the whole saved history for ALL), whatever the page range, for risk statistics. */
  riskBars: FleetDay[];
  /** Cumulative fleet PnL since the page range opened. */
  series: FleetPoint[];
  restarts: number[];
  bars: FleetDay[];
  /** Per-bot change over the page range, one row per registered bot that has history. */
  perBot: BotWindow[];
  /** Newest saved sample per bot (from the 24h read) with its quote, for "net now" when the live controller read is not current. */
  latest: Record<string, (BotSample & { quote: string | null }) | null>;
  /** Bots whose reads failed outright (network or HTTP error), with the reason. */
  errors: { bot: string; range: HistoryRange; message: string }[];
  /** Grid step used for `series`, seconds. */
  stepSeconds: number;
};

const SPAN: Record<'1D' | '1W' | '1M', number> = { '1D': 86_400_000, '1W': 7 * 86_400_000, '1M': 30 * 86_400_000 };

/**
 * Saved native performance of all `bots`, with 24h / 7d / 30d fleet windows and the page range.
 * `window` bounds a custom or long range; without it a named range is the trailing span from `now`.
 */
export function useFleetPerformance(input: {
  server: string | null; bots: string[]; now: number; pageRange: HistoryRange; window?: { start: string; end: string };
}): FleetPerformance {
  const { server, bots, now, pageRange, window } = input;
  const ranges = useMemo<HistoryRange[]>(() => [...new Set<HistoryRange>(['1D', '1W', '1M', pageRange])], [pageRange]);
  const keys = useMemo(() => bots.flatMap(bot => ranges.map(range => ({ bot, range }))), [bots, ranges]);
  const queries = useQueries({
    queries: keys.map(({ bot, range }) => ({
      queryKey: ['capital-bot-pnl-history', server, bot, range],
      enabled: Boolean(server),
      queryFn: ({ signal }: { signal: AbortSignal }) => readJson(`/api/v1/servers/${encodeURIComponent(server!)}/bots/${encodeURIComponent(bot)}/performance-history?range=${range}`, signal),
      refetchInterval: 30_000, retry: false,
    })),
  });
  const updated = queries.map(query => query.dataUpdatedAt).join(',');
  const failedKey = queries.map(query => query.isError ? 1 : 0).join('');
  return useMemo(() => {
    // The observer's newest sample can lead a polled clock by a few seconds; a later wall clock is not a future sample.
    const clock = Math.max(now, Date.now(), ...queries.map(query => query.dataUpdatedAt)) + 5_000;
    const histories = new Map<string, BotHistory>();
    const errors: FleetPerformance['errors'] = [];
    keys.forEach(({ bot, range }, index) => {
      const query = queries[index];
      histories.set(`${bot}/${range}`, parseBotHistory(query.data, bot, range, clock, query.isError));
      if (query.isError) errors.push({ bot, range, message: query.error instanceof Error ? query.error.message : 'Read failed' });
    });
    const forRange = (range: HistoryRange) => bots.map(bot => histories.get(`${bot}/${range}`) ?? parseBotHistory(null, bot, range, clock));
    const spanWindow = (range: '1D' | '1W' | '1M') => fleetWindow(forRange(range), bots, now - SPAN[range], now, clock);
    const pageHistories = forRange(pageRange);
    const from = window ? Date.parse(window.start) : pageRange === 'ALL' ? pageHistories.reduce((first, history) => history.samples.length ? Math.min(first, history.samples[0].time) : first, Infinity) : now - SPAN[pageRange];
    const to = window ? Math.min(now, Date.parse(window.end)) : now;
    const rangeWindow = fleetWindow(pageHistories, bots, from, to, clock);
    const step = Math.max(60, ...pageHistories.map(history => history.bucketSeconds ?? 0));
    return {
      pending: queries.some(query => query.isPending) && queries.every(query => query.data === undefined),
      bots, histories: pageHistories,
      daily: spanWindow('1D'), weekly: spanWindow('1W'), monthly: spanWindow('1M'), range: rangeWindow,
      series: fleetSeries(pageHistories, from, to, step),
      restarts: restartTimes(sameQuote(pageHistories), from, to),
      bars: fleetDailyBars(pageHistories, to, from),
      riskBars: pageRange === 'ALL' ? fleetDailyBars(pageHistories, to, from) : fleetDailyBars(forRange('1M'), now, now - SPAN['1M']),
      perBot: pageHistories.map(history => botWindow(history, from, to, clock)).filter(row => row.samples > 0),
      latest: Object.fromEntries(bots.map(bot => {
        const day = histories.get(`${bot}/1D`);
        const sample = day?.samples.at(-1);
        return [bot, sample && day ? { ...sample, quote: day.quote } : null];
      })),
      errors, stepSeconds: step,
    } satisfies FleetPerformance;
    // `queries` identity changes every render; the keys above capture exactly when its content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, keys, Math.floor(now / 15_000), pageRange, window?.start, window?.end, updated, failedKey]);
}

export type FleetQuantRead = {
  bot: string;
  summary: QuantBotSummary | null;
  cycles: QuantCycles | null;
  fills: FillRow[];
  issues: { summary: string | null; cycles: string | null; fills: string | null };
  pending: boolean;
};

/** Quant summary, scored cycles and the newest native fills for every bot. */
export function useFleetQuantReads(bots: string[], now: number, fillLimit = 50): FleetQuantRead[] {
  const specs = useMemo(() => bots.flatMap(bot => (['quant-summary', 'quant-cycles', 'fills'] as const).map(kind => ({ bot, kind }))), [bots]);
  const queries = useQueries({
    queries: specs.map(({ bot, kind }) => {
      const encoded = encodeURIComponent(bot);
      return {
        queryKey: [kind === 'quant-summary' ? 'capital-quant-summary' : kind === 'quant-cycles' ? 'capital-quant-cycles' : 'capital-fills', bot],
        queryFn: ({ signal }: { signal: AbortSignal }) => readOptional(kind === 'fills' ? `/api/v1/trading-visuals/fills?bot=${encoded}&limit=${fillLimit}` : `/api/v1/trading-visuals/${kind}?bot=${encoded}`, signal),
        refetchInterval: kind === 'quant-summary' ? 10_000 : 30_000, retry: false,
      };
    }),
  });
  const updated = queries.map(query => query.dataUpdatedAt).join(',');
  return useMemo(() => bots.map((bot, index) => {
    const [summary, cycles, fills] = [queries[index * 3], queries[index * 3 + 1], queries[index * 3 + 2]];
    return {
      bot,
      summary: projectQuantBotSummary((summary.data as Read | undefined)?.payload, bot, Math.max(now, summary.dataUpdatedAt)),
      cycles: projectQuantCycles((cycles.data as Read | undefined)?.payload, bot),
      fills: projectFills((fills.data as Read | undefined)?.payload, bot),
      issues: { summary: (summary.data as Read | undefined)?.issue ?? null, cycles: (cycles.data as Read | undefined)?.issue ?? null, fills: (fills.data as Read | undefined)?.issue ?? null },
      pending: summary.isPending || cycles.isPending,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [bots, Math.floor(now / 15_000), updated]);
}

/** Current controller PnL (the server's `/bots` page) projected for each registered bot from one read. */
export function useFleetControllerPnl(server: string | null, bots: string[], now: number): { views: Record<string, ControllerPnlView>; failed: boolean } {
  const query = useQuery({
    queryKey: ['overview-controller-performance', server],
    enabled: Boolean(server && bots.length),
    queryFn: async ({ signal }) => {
      const response = await authFetch(`/api/v1/servers/${encodeURIComponent(server!)}/bots`, { signal: AbortSignal.any([signal, AbortSignal.timeout(9000)]), cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error(`Controller performance request failed (${response.status})`);
      return response.json() as Promise<unknown>;
    },
    refetchInterval: 10_000, retry: false,
  });
  const views = useMemo(() => Object.fromEntries(bots.map(bot => [bot, projectControllerPnl(query.isError ? null : query.data, bot, now)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bots, query.data, query.isError, Math.floor(now / 1000)]);
  return { views, failed: query.isError };
}
