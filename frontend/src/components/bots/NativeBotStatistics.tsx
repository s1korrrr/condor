import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { authFetch } from '@/lib/auth-token';
import { loadRecordedBotStatistics } from '@/lib/native-bot-statistics';
import { NativeBotActivityCharts } from './NativeBotActivityCharts';

type Source = { bot: string; server: string };
async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]), cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error(`Recorded statistics request failed (${response.status})`);
  return response.json();
}

function amount(value: number | null, quote: string | null) {
  return value === null || quote === null ? 'Unavailable' : `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${quote}`;
}

function SourceStatistics({ source }: { source: Source }) {
  const query = useQuery({
    queryKey: ['native-recorded-statistics', source.server, source.bot],
    queryFn: ({ signal }) => loadRecordedBotStatistics(source.bot, readJson, signal),
    refetchInterval: 30_000,
    retry: false,
  });
  const stats = query.data;
  return <section className="rounded-lg border border-[var(--color-border)] p-4 space-y-4" aria-label={`${source.bot} recorded statistics`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-sm font-semibold">{source.bot}</h3><p className="text-xs text-[var(--color-text-muted)] mt-1">All events in monitored databases · native Hummingbot</p></div>
      <Link className="text-sm text-[var(--color-primary)] underline underline-offset-4" to={`/trading-visuals?bot=${encodeURIComponent(source.bot)}`}>Inspect charts and records</Link>
    </div>
    {query.isPending ? <p role="status" className="text-sm">Loading recorded statistics…</p> : query.isError ? <p role="alert" className="text-sm text-[var(--color-yellow)]">{query.error.message}. <button className="underline" onClick={() => void query.refetch()}>Retry</button></p> : stats ? <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
        {[
          ['Fill events', stats.fillCount], ['Orders with fills', stats.executedOrderCount ?? 'Unavailable'],
          ['Recorded orders', stats.orderCount], ['Canceled orders', stats.canceledOrderCount],
          ['Fully filled orders', stats.fullyFilledOrderCount], ['Fully filled order share', stats.fullyFilledOrderShare === null ? 'Unavailable' : `${(stats.fullyFilledOrderShare * 100).toFixed(1)}%`],
          ['Failed orders', stats.failedOrderCount], ['Terminated executors', stats.closedExecutorCount],
          ['Open DB executors', stats.openExecutorCount], ['Filled volume', amount(stats.volume, stats.quote)],
          ['Recorded fill fees', amount(stats.fees, stats.quote)],
        ].map(([label, value]) => <div key={label}><dt className="text-xs text-[var(--color-text-muted)]">{label}</dt><dd className="mt-1 text-sm font-semibold tabular-nums">{value}</dd></div>)}
      </dl>
      <p className="text-xs text-[var(--color-text-muted)]">{stats.firstFillAt ? `Recorded fills: ${new Date(stats.firstFillAt).toISOString()} to ${new Date(stats.lastFillAt!).toISOString()}.` : 'No fills recorded in this source.'} Read at {new Date(query.dataUpdatedAt).toISOString()}. Refreshes every 30 seconds.</p>
      <NativeBotActivityCharts stats={stats} />
      {stats.pairs.length > 0 && <div className="overflow-x-auto"><table className="w-full text-sm text-left">
        <caption className="text-left text-xs text-[var(--color-text-muted)] pb-2">Recorded activity by pair</caption>
        <thead><tr className="border-b border-[var(--color-border)]">{['Pair', 'Connector', 'Buy fills', 'Sell fills', 'Filled orders', 'Canceled', 'Executors', 'Volume', 'Fill fees'].map(label => <th key={label} className="py-2 pr-5 font-medium whitespace-nowrap">{label}</th>)}</tr></thead>
        <tbody>{stats.pairs.map(pair => <tr key={pair.pair} className="border-b border-[var(--color-border)]/30">{[pair.pair, pair.connectors.join(', ') || 'Not recorded', pair.buyFills, pair.sellFills, pair.fullyFilledOrderCount, pair.canceledOrderCount, pair.executorCount, amount(pair.volume, pair.quote), amount(pair.fees, pair.quote)].map((value, index) => <td key={index} className="py-2 pr-5 whitespace-nowrap tabular-nums">{value}</td>)}</tr>)}</tbody>
      </table></div>}
    </> : null}
  </section>;
}

export function NativeBotStatistics({ server }: { server: string }) {
  const query = useQuery({
    queryKey: ['native-statistics-sources', server],
    queryFn: async ({ signal }) => {
      const payload = await readJson('/api/v1/trading-visuals/sources', signal);
      if (!payload || typeof payload !== 'object' || !('sources' in payload) || !Array.isArray(payload.sources)) throw new Error('Monitoring source discovery is invalid');
      const sources: Source[] = [];
      const seen = new Set<string>();
      for (const source of payload.sources) {
        if (!source || typeof source.bot !== 'string' || !/^[A-Za-z0-9_-]+$/.test(source.bot) || typeof source.server !== 'string') throw new Error('Monitoring source identity is invalid');
        if (source.server === server && !seen.has(source.bot)) { sources.push(source); seen.add(source.bot); }
      }
      return sources;
    },
    retry: false,
    refetchInterval: 30_000,
  });
  return <section className="space-y-3" aria-label="Recorded bot activity">
    <h2 className="text-base font-semibold">Recorded bot activity</h2>
    <p className="text-sm text-[var(--color-text-muted)]">A fill event is one execution; several fills can belong to one order. A terminated executor may have no fills. Database history can span multiple process runs.</p>
    {query.isPending ? <p role="status">Discovering monitoring sources…</p> : query.isError ? <p role="alert">{query.error.message}</p> : query.data?.length ? query.data.map(source => <SourceStatistics key={`${source.server}:${source.bot}`} source={source} />) : <p role="status">No recorded monitoring source is available for this server.</p>}
    <details className="text-sm text-[var(--color-text-muted)]"><summary className="cursor-pointer">Backtest-style metrics and evidence limits</summary><p className="mt-2">Completed round trips, trade win rate, profit factor and average trade return are unavailable until entries, exits, fees and retained inventory are reconciled. Account return, Sharpe, Sortino and equity drawdown require a capital and cash-flow history. The tracked executor PnL above and zero-opening-inventory fill replay are separate measures. Neither establishes account performance.</p></details>
  </section>;
}
