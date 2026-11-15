/** Authenticated V5 candle-store read; a failed or non-AVAILABLE read throws, so callers never keep an earlier success. */
/** When the request that returned this candle-store body was sent (epoch ms), so ages include delivery time. */
export const candleRequestedAt = (data: object) => (data as { _requestedAtMs?: number })._requestedAtMs;

export async function readCandleStore<T>(view: string, params?: Record<string, string>): Promise<T> {
  const sentMs = Date.now();
  const query = params ? `?${new URLSearchParams(params)}` : "";
  const response = await fetch(`/api/v5/candle-store/${view}${query}`, { credentials: "include", signal: AbortSignal.timeout(14000) });
  const body = await response.json() as { state: string; reason: string | null; data: T | null };
  if (!response.ok || body.state !== "AVAILABLE" || !body.data) throw new Error(body.reason ?? "Owner read unavailable");
  return typeof body.data === "object" && !Array.isArray(body.data) ? { ...body.data, _requestedAtMs: sentMs } : body.data;
}

const readCandleSummary = () => readCandleStore<unknown>("summary");
export const candleSummaryInterval = (query: { state: { error: Error | null } }) => query.state.error?.message === "owner_warming" ? 5_000 : 30_000;
export const candleSummaryQuery = <T,>() => ({
  queryKey: ["candle-summary"] as const,
  queryFn: readCandleSummary as () => Promise<T>,
  structuralSharing: false as const,
});
