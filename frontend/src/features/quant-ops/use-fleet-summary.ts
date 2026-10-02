import { useQuery } from '@tanstack/react-query';
import { authFetch } from '@/lib/auth-token';
import { fleetSummaryPath, parseFleetSummary, type FleetGlance, type FleetSummary } from '@/lib/fleet-summary';

/**
 * The server's fleet summary for one server, polled every 15s (the server caches a computation for 5s, so a dashboard,
 * a phone and a watch polling together cost one). The numbers are the server's; this hook recomputes nothing.
 */
export function useFleetSummary(server: string | null, view: 'full'): ReturnType<typeof useQuery<FleetSummary>>;
export function useFleetSummary(server: string | null, view: 'glance'): ReturnType<typeof useQuery<FleetGlance>>;
export function useFleetSummary(server: string | null, view: 'full' | 'glance' = 'full') {
  return useQuery({
    queryKey: ['fleet-summary', server, view],
    enabled: Boolean(server),
    queryFn: async ({ signal }) => {
      const response = await authFetch(fleetSummaryPath(server!, view), { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: 'no-store' });
      if (!response.ok) throw Object.assign(new Error(`Fleet summary request failed (${response.status})`), { status: response.status });
      return view === 'full' ? parseFleetSummary(await response.json(), 'full') : parseFleetSummary(await response.json(), 'glance');
    },
    refetchInterval: 15_000,
    retry: false,
  });
}
