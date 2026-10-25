import { useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";

import { api, type ConsolidatedPositionsResponse, type ExecutorInfo } from "@/lib/api";
import { computeMultiOverlays } from "@/lib/executor-overlays";

export function useMainControllerData(
  server: string | null,
  connector: string,
  pair: string,
) {
  // Fetch executors filtered server-side by controller_id + trading_pair
  const { data: cachedExecutors } = useQuery<ExecutorInfo[]>({
    queryKey: ["executors", server, "main", pair],
    queryFn: () => api.getExecutors(server!, { controller_id: "main", trading_pair: pair }),
    enabled: !!server && !!pair,
    staleTime: 30_000, // REST fetch valid for 30s, WS pushes override instantly
    refetchOnWindowFocus: false,
  });

  // connector is not a server-side filter — filter client-side (lightweight)
  const filteredExecutors = useMemo(() => {
    if (!cachedExecutors) return [];
    return cachedExecutors.filter((ex) => ex.connector === connector);
  }, [cachedExecutors, connector]);

  // The query cache and this filter already provide a stable reference while
  // the source data is unchanged. Avoid mutating a ref during render to cache it.
  const executors = filteredExecutors;

  const overlays = useMemo(() => computeMultiOverlays(executors), [executors]);

  // Fetch consolidated positions
  const { data: positionsData, isLoading: isLoadingPositions, isError: positionsQueryError } = useQuery<ConsolidatedPositionsResponse>({
    queryKey: ["consolidated-positions", server],
    queryFn: () => api.getConsolidatedPositions(server!),
    enabled: !!server,
    refetchInterval: 5_000,
    staleTime: 0,
    placeholderData: keepPreviousData, // keep showing old data during refetch/refresh
  });

  const positions = useMemo(() => {
    if (!positionsData || positionsQueryError) return [];
    const all = [
      ...(positionsData.executor_positions ?? []),
      ...(positionsData.bot_positions ?? []),
    ];
    return all.filter(
      (p) =>
        // Show positions from main controller or untagged (executor-level positions)
        (!p.controller_id || p.controller_id === "main") &&
        p.connector_name === connector &&
        p.trading_pair === pair,
    );
  }, [positionsData, positionsQueryError, connector, pair]);

  const positionsStatus: "available" | "partial" | "unavailable" = positionsQueryError || !positionsData
    ? "unavailable"
    : positionsData.executor_positions_status === "unavailable" || positionsData.bot_positions_status === "unavailable"
      ? "unavailable"
      : positionsData.executor_positions_status === "partial" || positionsData.bot_positions_status === "partial"
        ? "partial"
        : positionsData.executor_positions_status === "available" && positionsData.bot_positions_status === "available"
          ? "available"
          : "unavailable";

  return { executors, overlays, positions, isLoadingPositions, positionsStatus };
}
