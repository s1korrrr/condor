/** Authenticated V5 candle-store read; a failed or non-AVAILABLE read throws, so callers never keep an earlier success. */
export async function readCandleStore<T>(view: string, params?: Record<string, string>): Promise<T> {
  const query = params ? `?${new URLSearchParams(params)}` : "";
  const response = await fetch(`/api/v5/candle-store/${view}${query}`, { credentials: "include", signal: AbortSignal.timeout(14000) });
  const body = await response.json() as { state: string; reason: string | null; data: T | null };
  if (!response.ok || body.state !== "AVAILABLE" || !body.data) throw new Error(body.reason ?? "Owner read unavailable");
  return body.data;
}
