import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/auth-token";
import { parseDeploymentPolicy } from "@/lib/deployment-policy";

export function useDeploymentPolicy() {
  const query = useQuery({
    queryKey: ["deployment-policy"],
    queryFn: async () => {
      const response = await authFetch("/api/v1/settings/policy", { cache: "no-store" });
      if (!response.ok) throw new Error("Deployment policy is unavailable.");
      return parseDeploymentPolicy(await response.json());
    },
    refetchInterval: 30_000,
  });
  const known = !!query.data && !query.isError;
  return {
    ...query,
    settingsMutation: known && query.data!.settings_mutation,
    accountManagement: known && query.data!.account_management,
  };
}
