import { researchPath, parseResearchEnvelope } from './model.ts';

type Fetcher = (path: string, init: RequestInit) => Promise<Response>;

export class ResearchHttpError extends Error {
  readonly status: number;

  constructor(status: number, reason: string) {
    super(reason);
    this.status = status;
  }
}

export function readResearch(fetcher: Fetcher, timeoutMs = 15_000, allowTimeless = false) {
  return async (endpoint: string, server: string, params: Record<string, string>, signal: AbortSignal) => {
    const deadline = AbortSignal.timeout(endpoint === 'network' ? Math.max(timeoutMs, 60_000) : timeoutMs);
    try {
      const response = await fetcher(researchPath(endpoint, server, params), {
        signal: AbortSignal.any([signal, deadline]),
        cache: 'no-store',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new ResearchHttpError(response.status, typeof body?.detail === 'string' ? body.detail : 'The source could not return research records.');
      }
      return parseResearchEnvelope(await response.json(), server, allowTimeless);
    } catch (error) {
      if (deadline.aborted && !signal.aborted) throw new Error('Research source request timed out. Retry to load current records.');
      throw error;
    }
  };
}
