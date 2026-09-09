import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '@/lib/auth';
import { safeLoginRedirect } from '@/lib/auth-login';

export function Login() {
  const { isAuthenticated, recoveryReason, loginWithToken, loginWithTailscale } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const loginToken = searchParams.get('token');
  const redirectTo = safeLoginRedirect(searchParams.get('redirect') ?? searchParams.get('next'), loginToken ? '/' : '/trading-visuals');
  const [error, setError] = useState('');
  const [loggingIn, setLoggingIn] = useState(Boolean(loginToken || !recoveryReason));
  const attempted = useRef(false);
  const inFlight = useRef(false);
  const navigated = useRef(false);

  const returnToDestination = useCallback(() => {
    if (navigated.current) return;
    navigated.current = true;
    navigate(redirectTo, { replace: true });
  }, [navigate, redirectTo]);

  const signIn = useCallback(async (token?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoggingIn(true);
    setError('');
    try {
      const authenticated = token ? await loginWithToken(token) : await loginWithTailscale();
      if (authenticated) returnToDestination();
      else setError('Private sign-in is unavailable. Try again or request a new login link.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Login failed');
    } finally {
      inFlight.current = false;
      setLoggingIn(false);
    }
  }, [loginWithToken, loginWithTailscale, returnToDestination]);

  useEffect(() => {
    if (isAuthenticated) returnToDestination();
  }, [isAuthenticated, returnToDestination]);

  useEffect(() => {
    if (isAuthenticated || attempted.current || (!loginToken && recoveryReason)) return;
    attempted.current = true;
    if (loginToken) {
      const clean = new URLSearchParams(searchParams);
      clean.delete('token');
      const query = clean.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }
    void signIn(loginToken ?? undefined);
  }, [isAuthenticated, loginToken, recoveryReason, searchParams, signIn]);

  const recoveryMessage = recoveryReason === 'expired' ? 'Your session expired. Sign in again to return to your view.'
    : recoveryReason === 'changed' ? 'The session changed in another tab. Sign in again to return to this view.'
    : recoveryReason === 'invalid' ? 'The saved session could not be read. Sign in again to continue.'
    : recoveryReason === 'signed_out' ? 'You are signed out.' : null;

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
        <img src="/condor_old.jpeg" alt="Condor" className="mx-auto mb-4 h-16 w-16 rounded-full" />
        <h1 className="mb-2 text-2xl font-bold">Condor</h1>
        {recoveryMessage && <p role="status" className="mb-4 text-sm text-[var(--color-text-muted)]">{recoveryMessage}</p>}
        {loggingIn ? <p role="status" className="text-sm text-[var(--color-text-muted)]">Signing in…</p> : <>
          <button type="button" onClick={() => signIn()} className="mb-4 rounded bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-bg)]">Sign in again</button>
          <p className="text-sm text-[var(--color-text-muted)]">You can also request a new login link with the <code className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-xs">/web</code> command in your Telegram bot.</p>
        </>}
        {error && <p role="alert" className="mt-4 text-sm text-[var(--color-red)]">{error}</p>}
      </div>
    </div>
  );
}
