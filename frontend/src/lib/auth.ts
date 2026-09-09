import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';

import { authFetch } from './auth-token';
import { fetchTailscaleLogin } from './auth-login';
import {
  acceptSession, beginLoginAttempt, clearSession, getSessionSnapshot, subscribeSession,
  type RecoveryReason, type User,
} from './auth-session';

export type { User } from './auth-session';
export { SERVER_KEY } from './auth-session';

export interface AuthState {
  user: User | null;
  token: string | null;
  recoveryReason: RecoveryReason;
  isAuthenticated: boolean;
  loginWithToken: (loginToken: string) => Promise<boolean>;
  loginWithTailscale: () => Promise<boolean>;
  logout: () => void;
}

async function loginWithTailscale() {
  const attempt = beginLoginAttempt();
  const session = await fetchTailscaleLogin();
  return session ? acceptSession(session, attempt) : false;
}

async function loginWithToken(loginToken: string) {
  const attempt = beginLoginAttempt();
  const response = await fetch('/api/v1/auth/token-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: loginToken }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || 'Login failed');
  }
  return acceptSession(await response.json(), attempt);
}

function logout() { clearSession('signed_out'); }

export const AuthContext = createContext<AuthState>({
  user: null, token: null, recoveryReason: null, isAuthenticated: false,
  loginWithToken, loginWithTailscale, logout,
});

export function useAuth() { return useContext(AuthContext); }

export function useAuthState(): AuthState {
  const session = useSyncExternalStore(subscribeSession, getSessionSnapshot, getSessionSnapshot);

  useEffect(() => {
    if (!session.token) return;
    const controller = new AbortController();
    // A network outage does not invalidate an identity; only a protected 401 does.
    void authFetch('/api/v1/auth/me', { signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, [session.token]);

  return {
    ...session,
    isAuthenticated: !!session.token && !!session.user,
    loginWithToken, loginWithTailscale, logout,
  };
}
