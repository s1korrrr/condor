import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { HashRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { V5Layout } from "./V5Layout";
import { AgentsPage, AgentDetailPage, MarketPage, OverviewPage, SessionDetailPage, SessionsPage, SettingsPage } from "./V5Pages";
import { V5ApiError, v5Api } from "./api";

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
});

function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await v5Api.login(token);
      setToken("");
      await client.invalidateQueries({ queryKey: ["v5-auth"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="v5-login-wrap">
      <section className="v5-login-panel" aria-labelledby="login-title">
        <BrandMark />
        <h1 id="login-title">RSI V5</h1>
        <p>Sign in to the Razer research workspace.</p>
        <form onSubmit={submit}>
          <label htmlFor="v5-session-token">Workspace access token</label>
          <input id="v5-session-token" name="v5-workspace-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />
          {error && <p className="v5-error-text" role="alert">{error}</p>}
          <button className="v5-button v5-button-primary v5-login-button" disabled={busy || !token.trim()}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <small>Sign-in uses a secure HttpOnly cookie that expires after 24 hours.</small>
      </section>
    </main>
  );
}

function BrandMark() {
  return <div className="v5-brand-mark" aria-hidden="true"><span>R</span><i /></div>;
}

function AuthGate() {
  const auth = useQuery({ queryKey: ["v5-auth"], queryFn: v5Api.auth, retry: false });
  if (auth.isPending) return <main className="v5-loading-screen"><div className="v5-spinner" /><span>Connecting to the V5 workspace…</span></main>;
  if (auth.isError && auth.error instanceof V5ApiError && auth.error.status === 401) return <LoginPage />;
  if (auth.isError) {
    return <main className="v5-loading-screen"><div className="v5-error-panel" role="alert"><strong>Workspace connection failed</strong><span>{auth.error.message}</span><button className="v5-button" onClick={() => void auth.refetch()}>Retry connection</button></div></main>;
  }
  if (!auth.data.authenticated) return <LoginPage />;
  return <V5Layout><Outlet /></V5Layout>;
}

export function V5App() {
  return (
    <QueryClientProvider client={client}>
      <HashRouter>
        <Routes>
          <Route element={<AuthGate />}>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:id" element={<AgentDetailPage />} />
            <Route path="/market" element={<MarketPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/sessions/:id" element={<SessionDetailPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  );
}
