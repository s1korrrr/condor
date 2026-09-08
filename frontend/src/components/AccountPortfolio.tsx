import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { KeyRound, RefreshCw, Wallet } from 'lucide-react';

import { useServer } from '@/hooks/useServer';
import { api } from '@/lib/api';
import { accountFreshness } from '@/lib/account-balances';

export function AccountPortfolio() {
  const { server } = useServer();
  const queryClient = useQueryClient();
  const [now, setNow] = useState(Date.now);
  const queryKey = ['account-balances', server];
  const query = useQuery({
    queryKey,
    queryFn: () => api.getAccountBalances(server!),
    enabled: !!server,
    refetchInterval: 10000,
    retry: 1,
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = () => {
    if (!server) return;
    // fetchQuery updates the visible error state. Failed refreshes cannot
    // make a retained observation current, even while its timestamp is recent.
    void queryClient.fetchQuery({ queryKey, queryFn: () => api.getAccountBalances(server, true), staleTime: 0 }).catch(() => {});
  };

  return <div className="space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-bold">Portfolio</h1><p className="mt-1 text-sm text-[var(--color-text-muted)]">Connected exchange balances</p></div>
      <div className="flex items-center gap-2">
        <Link to="/settings?tab=keys" className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"><KeyRound className="h-4 w-4" />Connections</Link>
        <button type="button" onClick={refresh} disabled={query.isFetching} className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)] disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />Refresh</button>
      </div>
    </header>
    {query.error && <div role="alert" className="rounded-lg border border-[var(--color-red)]/30 bg-[var(--color-red)]/5 p-4 text-sm text-[var(--color-red)]">{query.error.message} Retained amounts are unavailable until a fresh observation succeeds.</div>}
    {query.isLoading && <p role="status" className="py-8 text-sm text-[var(--color-text-muted)]">Loading account balances…</p>}
    {!query.isLoading && !query.error && query.data?.accounts.length === 0 && <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center">
      <Wallet className="mx-auto mb-3 h-6 w-6 text-[var(--color-text-muted)]" />
      <h2 className="text-base font-semibold">Connect an exchange account</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--color-text-muted)]">Add your OKX Spot API key, secret and passphrase to see its balances here. Bot observations remain available in Trading Visuals.</p>
      <Link to="/settings?tab=keys" className="mt-5 inline-flex items-center gap-2 rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-bg)]"><KeyRound className="h-4 w-4" />Add API key</Link>
    </div>}
    {query.data?.accounts.map(account => {
      const freshness = accountFreshness(account, now, !!query.error);
      return <section key={`${account.account}:${account.connector}`} className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="text-sm font-semibold">{account.connector === 'okx' ? 'OKX Spot · EU / EEA' : account.connector}</h2>
          <span className={`text-xs tabular-nums ${freshness.current ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-red)]'}`}>{freshness.current ? 'Fresh' : 'Unavailable'}{freshness.ageSeconds !== null ? ` · ${freshness.ageSeconds}s ago` : ''}</span>
        </header>
        {freshness.current ? account.balances.length === 0 ? <p className="p-6 text-sm text-[var(--color-text-muted)]">OKX returned no asset balances for this account.</p> : <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]"><tr><th className="px-4 py-3 font-medium">Asset</th><th className="px-4 py-3 text-right font-medium">Total</th><th className="px-4 py-3 text-right font-medium">Available</th>{account.valuation_available && <th className="px-4 py-3 text-right font-medium">Value (USD)</th>}</tr></thead>
            <tbody className="divide-y divide-[var(--color-border)]">{account.balances.map(balance => <tr key={balance.token} className="hover:bg-[var(--color-surface-hover)]"><td className="px-4 py-3 font-medium">{balance.token}</td><td className="px-4 py-3 text-right tabular-nums">{balance.total}</td><td className="px-4 py-3 text-right tabular-nums">{balance.available}</td>{account.valuation_available && <td className="px-4 py-3 text-right tabular-nums">{balance.value ?? 'Unavailable'}</td>}</tr>)}</tbody>
          </table>
        </div> : <p className="p-6 text-sm text-[var(--color-text-muted)]">This account observation is no longer current. Refresh the connection to view balances.</p>}
      </section>;
    })}
    {!!query.data?.accounts.length && <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">Account holdings include assets outside bot-managed positions. USD valuation and account PnL are unavailable for this connection.</p>}
  </div>;
}
