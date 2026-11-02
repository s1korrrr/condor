export async function readStockOwner<T>(view: 'stocks' | 'stock-market' | 'stock-candles', params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const deadline = AbortSignal.timeout(14000);
  const response = await fetch(`/api/v5/candle-store/${view}?${new URLSearchParams(params)}`, {
    credentials: 'include',
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    cache: 'no-store',
  });
  const body = await response.json() as { state?: string; reason?: unknown; data?: T | null };
  if (!response.ok || body.state !== 'AVAILABLE' || !body.data) {
    throw new Error(typeof body.reason === 'string' ? body.reason : `Stock owner read unavailable (${response.status})`);
  }
  return body.data;
}
