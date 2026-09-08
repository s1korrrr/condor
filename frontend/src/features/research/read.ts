import { researchPath, parseResearchEnvelope } from './model.ts';

type Fetcher = (path: string, init: RequestInit) => Promise<Response>;

export function readResearch(fetcher: Fetcher, timeoutMs = 15_000) {
  return async (endpoint: string, server: string, params: Record<string, string>, signal: AbortSignal) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetcher(researchPath(endpoint, server, params), {
        signal: AbortSignal.any([signal, deadline]),
        cache: 'no-store',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.detail === 'string' ? body.detail : `Research request failed (${response.status})`);
      }
      return parseResearchEnvelope(await response.json(), server);
    } catch (error) {
      if (deadline.aborted && !signal.aborted) throw new Error('Research source request timed out. Retry to load current records.');
      throw error;
    }
  };
}
