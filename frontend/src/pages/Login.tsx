import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useAuth } from "@/lib/auth";
import { safeLoginRedirect } from "@/lib/auth-login";

export function Login() {
  const { isAuthenticated, loginWithToken, loginWithTailscale } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState("");
  const [loggingIn, setLoggingIn] = useState(true);
  const attempted = useRef(false);

  // Where to land after login. Only allow internal paths to avoid open redirects.
  const loginToken = searchParams.get("token");
  const redirectTo = safeLoginRedirect(searchParams.get("redirect") ?? searchParams.get("next"), loginToken ? "/" : "/trading-visuals");

  useEffect(() => {
    if (isAuthenticated) {
      navigate(redirectTo, { replace: true });
    }
  }, [isAuthenticated, navigate, redirectTo]);

  // Keep the existing one-time token flow; private deployments can authenticate
  // the trusted Tailscale identity without putting another credential in a URL.
  useEffect(() => {
    if (isAuthenticated || attempted.current) return;
    attempted.current = true;

    // Strip the one-time token from the URL so it does not linger in browser
    // history or get leaked via the Referer header. The token is consumed via
    // a POST below; the address bar should not keep it.
    if (loginToken) window.history.replaceState(null, "", window.location.pathname);

    const signIn = loginToken ? loginWithToken(loginToken).then(() => true) : loginWithTailscale();
    signIn
      .then(authenticated => { if (authenticated) navigate(redirectTo, { replace: true }); })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Login failed");
      })
      .finally(() => setLoggingIn(false));
  }, [isAuthenticated, loginToken, loginWithToken, loginWithTailscale, navigate, redirectTo]);

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
        <img src="/condor_old.jpeg" alt="Condor" className="mx-auto mb-4 h-16 w-16 rounded-full" />
        <h1 className="mb-2 text-2xl font-bold">Condor</h1>
        {loggingIn ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            Signing in...
          </p>
        ) : (
          <>
            <p className="mb-6 text-sm text-[var(--color-text-muted)]">
              Run the <code className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-xs">/web</code> command in your Telegram bot to get a login link.
            </p>
          </>
        )}
        {error && (
          <p className="mt-4 text-sm text-[var(--color-red)]">{error}</p>
        )}
      </div>
    </div>
  );
}
