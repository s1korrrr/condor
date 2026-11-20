import { readResearch } from './read';

export function readV5Research(fetcher: (path: string, init: RequestInit) => Promise<Response>) {
  return readResearch(async (path, init) => {
    const response = await fetcher(path, init);
    if (!response.ok) return response;
    const data: unknown = await response.json().catch(() => {
      throw new Error('Research OS returned a response the dashboard could not read.');
    });
    const server = new URLSearchParams(path.split('?', 2)[1]).get('server');
    const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const generated_at = typeof record.generated_at === 'string' ? record.generated_at : undefined;
    return new Response(JSON.stringify({ data, source: { owner: 'research_os', server, generated_at, read_only: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, 15_000, true);
}

export function researchFreshnessDecision(data: Record<string, unknown>, now: number): string {
  const freshness = data.freshness && typeof data.freshness === 'object' && !Array.isArray(data.freshness) ? data.freshness as Record<string, unknown> : {};
  const scan = typeof freshness.verification_checked_at === 'string' ? Date.parse(freshness.verification_checked_at) : NaN;
  const stamp = typeof data.generated_at === 'string' ? Date.parse(data.generated_at) : NaN;
  const explicit = typeof data.fresh_until === 'string' ? Date.parse(data.fresh_until) : NaN;
  const maxAge = typeof freshness.max_verification_age_seconds === 'number' && freshness.max_verification_age_seconds > 0 ? freshness.max_verification_age_seconds : NaN;
  const scanBased = freshness.freshness_basis === 'verified_event_scan';
  const basis = scanBased ? scan : stamp;
  if (!Number.isFinite(basis) || (Number.isFinite(explicit) && !Number.isFinite(stamp))) return 'freshness unknown · owner timestamp not published';
  if (basis > now || (Number.isFinite(stamp) && stamp > now)) return 'freshness unknown · owner clock ahead';
  if ((Number.isFinite(explicit) && now >= explicit) || (scanBased && Number.isFinite(maxAge) && now >= scan + maxAge * 1000)) return 'not current · owner deadline expired';
  if ((!Number.isFinite(explicit) && !scanBased) || (scanBased && !Number.isFinite(maxAge))) return 'not current · freshness deadline not published';
  if (freshness.state !== undefined && freshness.state !== 'CURRENT') return `not current · owner state ${String(freshness.state)}`;
  return 'within owner freshness deadline';
}

export function researchOwnerFreshness(data: Record<string, unknown>, now: number): string {
  const generated = typeof data.generated_at === 'string' ? data.generated_at : '';
  const stamp = Date.parse(generated);
  const age = Number.isFinite(stamp) && now >= stamp ? `${Math.floor((now - stamp) / 1000)}s old` : 'age unavailable';
  const status = researchFreshnessDecision(data, now);
  return `Projection generated · ${generated || 'not published'} · ${age} · ${status}`;
}
