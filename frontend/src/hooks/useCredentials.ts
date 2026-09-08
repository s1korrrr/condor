import { useQuery } from "@tanstack/react-query";

import { useServer } from "@/hooks/useServer";
import { useServerCapabilities } from "@/hooks/useServerCapabilities";
import { api } from "@/lib/api";

export function useCredentials() {
  const { server } = useServer();
  const { access } = useServerCapabilities();

  const { data, isLoading } = useQuery({
    queryKey: ["settings-credentials", server],
    queryFn: () => api.getCredentials(server!),
    enabled: !!server && access.accounts,
    staleTime: 30000,
  });

  const credentials = data?.credentials ?? [];
  const hasKeys = credentials.length > 0;

  return { hasKeys, isLoading, credentials };
}
