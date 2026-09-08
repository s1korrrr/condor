import { useQuery } from "@tanstack/react-query";
import { useServer } from "@/hooks/useServer";
import { api } from "@/lib/api";
import { serverCapabilities } from "@/lib/server-capabilities";

export function useServerCapabilities() {
  const { server } = useServer();
  const query = useQuery({
    queryKey: ["server-capabilities", server],
    queryFn: () => api.getServerStatus(server!),
    enabled: !!server,
    staleTime: 10000,
    refetchInterval: 10000,
  });
  const data = query.isError && query.data ? {...query.data, status: 'error'} : query.data;
  return { ...query, data, access: serverCapabilities(data) };
}
