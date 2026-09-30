import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

export function useTradingRules(server: string, connector: string) {
  const { data } = useQuery({
    queryKey: ["trading-rules", server, connector],
    queryFn: () => api.getTradingRules(server, connector),
    enabled: !!server && !!connector,
    staleTime: 5 * 60 * 1000,
  });
  return data;
}
