import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { authFetch } from '@/lib/auth-token';
import { FLEET_FILLS_DEFAULT_LIMIT, fleetFillsPath, parseFleetFills, type FleetFillSide, type FleetFillsPage } from '@/lib/fleet-fills';

export type FleetFillsFilters = { bots: readonly string[]; side: FleetFillSide | null; pair: string | null };
export const NO_FLEET_FILL_FILTERS: FleetFillsFilters = { bots: [], side: null, pair: null };

/**
 * The server's merged fills of every bot for one server, newest first. Polled every 30s (the server shares one owner
 * read for 5s, so a dashboard, a phone and a watch polling together cost one). A refresh re-reads every loaded page
 * from the top, so the list never keeps a gap between new fills and an older continuation. Changing a filter keeps the
 * previous rows on screen until the filtered read arrives. The rows and their order are the server's.
 */
export function useFleetFills(server: string | null, filters: FleetFillsFilters = NO_FLEET_FILL_FILTERS, limit = FLEET_FILLS_DEFAULT_LIMIT) {
  const bots = [...filters.bots].sort();
  return useInfiniteQuery({
    queryKey: ['fleet-fills', server, limit, bots, filters.side, filters.pair],
    enabled: Boolean(server),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }): Promise<FleetFillsPage> => {
      const response = await authFetch(fleetFillsPath(server!, { limit, before: pageParam, bots, side: filters.side, pair: filters.pair }), { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) throw Object.assign(new Error(`Fleet fills request failed (${response.status})`), { status: response.status });
      return parseFleetFills(await response.json());
    },
    getNextPageParam: last => last.has_more ? last.next_cursor : undefined,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    retry: false,
  });
}
