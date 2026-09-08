import type { User } from './auth';

type LoginSession = { token: string; user: User };

export async function fetchTailscaleLogin(request: typeof fetch = fetch): Promise<LoginSession | null> {
  const response = await request('/api/v1/auth/tailscale', { method: 'POST', cache: 'no-store' });
  if (response.status === 404) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Private Tailscale sign-in failed: ${response.status}${typeof payload?.detail === 'string' ? ` ${payload.detail}` : ''}`);
  }
  if (typeof payload?.token !== 'string' || !payload.token || typeof payload?.user?.id !== 'number' ||
      typeof payload.user.username !== 'string' || typeof payload.user.first_name !== 'string' || typeof payload.user.role !== 'string') {
    throw new Error('Private Tailscale sign-in returned an invalid session');
  }
  return payload as LoginSession;
}

export function safeLoginRedirect(raw: string | null, fallback: string): string {
  if (!raw?.startsWith('/')) return fallback;
  try {
    const url = new URL(raw, 'https://condor.invalid');
    return url.origin === 'https://condor.invalid' ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}
