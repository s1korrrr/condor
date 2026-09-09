import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** The selector and capability gate share the same discovery/error observation. */
export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: api.getServers,
    staleTime: 10000,
    refetchInterval: 10000,
  });
}
