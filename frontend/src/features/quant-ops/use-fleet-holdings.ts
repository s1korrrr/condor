import { useQuery } from '@tanstack/react-query';
import { authFetch } from '@/lib/auth-token';
import { fleetHoldingsPath, parseFleetHoldings, type FleetHoldingsRead } from '@/lib/fleet-holdings';

/**
 * The server's fleet holdings for one server, polled every 10s (the server caches one owner read for 5s, so every card,
 * the command desk, a phone and a widget polling together cost one). Every bot card of a server shares this one query.
 * The response is stamped with its local receipt time for the contract's age rule; nothing here recomputes inventory.
 */
export function useFleetHoldings(server: string | null) {
  return useQuery<FleetHoldingsRead>({
    queryKey: ['fleet-holdings', server],
    enabled: Boolean(server),
    queryFn: async ({ signal }) => {
      const response = await authFetch(fleetHoldingsPath(server!), { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: 'no-store' });
      if (!response.ok) throw Object.assign(new Error(`Fleet holdings request failed (${response.status})`), { status: response.status });
      const body = parseFleetHoldings(await response.json());
      return { body, receivedAtMs: Date.now() };
    },
    refetchInterval: 10_000,
    retry: false,
  });
}

/** Why a bot has no holdings entry to render: the read is pending, failed, or does not list the bot. */
export function holdingsIssue(query: { isPending: boolean; isError: boolean; error: unknown; data?: FleetHoldingsRead }, bot: string): string | null {
  if (query.data?.body.bots.some(row => row.bot === bot)) return null;
  if (query.isError) return query.error instanceof Error ? query.error.message : 'Fleet holdings read failed';
  if (query.isPending) return 'Fleet holdings not read yet';
  return 'Bot not listed in fleet holdings';
}
