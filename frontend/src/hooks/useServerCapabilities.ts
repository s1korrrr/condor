import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServer } from "@/hooks/useServer";
import { api } from "@/lib/api";
import { serverCapabilities } from "@/lib/server-capabilities";
import { useServers } from './useServers';
import { retainReadProfile, transientReadFailure } from '@/lib/read-continuity';

export function useServerCapabilities() {
  const { server } = useServer();
  const discovery = useServers();
  const client = useQueryClient();
  const serverAvailable = !discovery.isError && discovery.data?.some(item => item.name === server && item.online) === true;
  const query = useQuery({
    queryKey: ["server-capabilities", server],
    queryFn: async () => retainReadProfile(await api.getServerStatus(server!), client.getQueryData(["server-capabilities", server])),
    enabled: !!server && serverAvailable,
    staleTime: 10000,
    refetchInterval: 10000,
  });
  const data = query.data && (query.isError || !serverAvailable) ? {...query.data, status: 'error'} : query.data;
  const access = serverCapabilities(data);
  const readContinuity = !access.online && access.native
    && query.data?.capabilities?.native_status === true
    && discovery.data?.some(item => item.name === server) === true
    && (!discovery.isError || transientReadFailure(discovery.error))
    && (!query.isError || transientReadFailure(query.error));
  const unavailableReason = discovery.isError ? 'Server discovery failed. Retry to verify the selected server.'
    : discovery.isPending ? 'Checking available servers…'
    : !server ? 'Select an available server to load its capabilities.'
    : !serverAvailable ? `The selected server ${server} is not available in the current discovery result.`
    : query.isError ? 'Server capabilities could not be read. Retry to verify available actions.'
    : query.isPending ? 'Checking server capabilities…'
    : !access.online ? 'Server capabilities are unavailable or the server profile is not recognized.' : null;
  const refetch = async () => {
    const result = await discovery.refetch();
    if (!result.isError && result.data?.some(item => item.name === server && item.online)) await query.refetch();
  };
  return {
    ...query, data, access, readContinuity, unavailableReason, refetch,
    isLoading: discovery.isPending || (serverAvailable && query.isLoading),
    isFetching: discovery.isFetching || query.isFetching,
  };
}
