import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useMatch } from "react-router-dom";
import { ServerContext } from "@/hooks/useServer";
import { AuthContext, type AuthState } from "@/lib/auth";
import type { User } from "@/lib/auth-session";
import { V5ApiError, v5Api } from "./api";
import { botsOwnerUnavailableReason, paperWorkspaceReads } from "./policy";
import { AgentsPage, AgentDetailPage, SessionDetailPage, SessionsPage } from "./V5Pages";
import { AgentDecisionsPage } from "./AgentDecisionsPage";
import { SystemPauseProvider, V5System } from "./V5System";
import { V5MarketHome } from "./V5MarketHome";
import { V5AppShell } from "./V5AppShell";
import { clearSessionCache, confirmLogout, dropSessionReads, sessionEnded } from "./session-policy.mjs";
import { V5PaperBots } from "@/pages/tabs/ActiveBotsTab";
import { LearningPage } from './LearningPanel';
import { ResearchFactoryPage } from './ResearchFactoryPanel';
import { DecisionLineagePage } from './DecisionLineagePanel';
import { V5Helm } from "./V5Helm";
import { V5Overview } from "./V5Overview";
import { V5NotFound } from "./V5NotFound";
import { usePaperWorkspace } from "./usePaperObservation";
import { PaperJournalNotice } from './OwnerJournalCondition';

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } } });
const Capital = lazy(() => import("@workspace-monitoring").then(m => ({ default: function V5CapitalPage() {
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile });
  const paper = Boolean(profile.data?.readiness.paper_owner);
  const read = usePaperWorkspace("capital", profile.data?.readiness.paper_owner?.bot_name);
  if (paper) return <m.Overview {...{...paperWorkspaceReads("capital"), paperRead:read}} />;
  return <m.Overview accountPresentation={{ description: paper ? "Simulated paper wallet · live exchange balances are not applicable." : "V5 account owner is unbound; no account valuation is available.", unavailable: paper ? "The native paper wallet read is unavailable. Check the observation binding; no zero balance is substituted." : "Bind the V5 account owner to view capital. This V5 service cannot select the existing stack account.", valuationNote: paper ? "Simulated wallet · native owner valuation" : "V5 owner valuation", registryUnavailable: paper ? "Paper owner · registration is read-only" : "V5 native owner unbound · bot registration unavailable" }} />;
} })));
const Tradepad = lazy(() => import("@workspace-monitoring").then(m => ({ default: function V5TradepadPage() {
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile });
  if (profile.isPending) return <main role="status">Loading Tradepad configuration…</main>;
  if (profile.isError) return <main role="alert">Not connected: dashboard configuration is unavailable.</main>;
  return <m.Tradepad {...paperWorkspaceReads("tradepad", profile.data?.tradepad_campaign_id)} />;
} })));
const Bots = lazy(() => import("@/pages/Bots").then(m => ({ default: function V5BotsPage() {
  // Only a fresh read-only paper status lifts the unbound notice; capabilities stay read-only.
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile, retry: false, refetchInterval: 15_000 });
  const paper = profile.data?.readiness.paper_owner;
  if (paper?.bot_name) return <V5PaperBots bot={paper.bot_name} generatedAt={paper.generated_at} ownerState={paper.state} />;
  return <m.Bots allowDrafts={false} ownerUnavailableReason={botsOwnerUnavailableReason(profile.data)} />;
} })));
const Research = lazy(() => import("@/pages/Research").then(m => ({ default: function V5ResearchPage() {
  return <m.Research v5Paper />;
} })));

function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await v5Api.login(token); setToken(""); await client.invalidateQueries({ queryKey: ["v5-auth"] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Sign in failed."); }
    finally { setBusy(false); }
  }
  return <main className="v5-login-wrap"><section className="v5-login-panel" aria-labelledby="login-title"><div className="v5-brand-mark" aria-hidden="true"><span>R</span><i /></div><h1 id="login-title">RSI V5</h1><p>Sign in to the Razer workspace. If your session expired, sign in again to continue.</p><form onSubmit={submit}><label htmlFor="v5-session-token">Workspace access token</label><input id="v5-session-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required />{error && <p className="v5-error-text" role="alert">{error}</p>}<button className="v5-button v5-button-primary v5-login-button" disabled={busy || !token.trim()}>{busy ? "Signing in…" : "Sign in"}</button></form><small>Sign-in uses the V5 workspace cookie.</small></section></main>;
}

function AuthGate() {
  const auth = useQuery({ queryKey: ["v5-auth"], queryFn: v5Api.auth, retry: false, refetchInterval: 15_000, refetchOnWindowFocus: true });
  useEffect(() => { if (sessionEnded({ data: auth.data, isError: auth.isError, error: auth.error }, error => error instanceof V5ApiError && error.status === 401)) dropSessionReads(client); }, [auth.isError, auth.error, auth.data]);
  if (auth.isPending) return <main className="v5-loading-screen"><div className="v5-spinner" /><span>Connecting to the V5 workspace…</span></main>;
  if (auth.isError && auth.error instanceof V5ApiError && auth.error.status === 401) return <LoginPage />;
  if (auth.isError) return <main className="v5-loading-screen"><div className="v5-error-panel" role="alert"><strong>Workspace connection failed</strong><span>{auth.error.message}</span><button className="v5-button" onClick={() => void auth.refetch()}>Retry connection</button></div></main>;
  if (!auth.data.authenticated) return <LoginPage />;
  return <Outlet />;
}

function ProfileGate() {
  const onBots = useMatch("/bots");
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile, retry: false });
  if (profile.isPending) return <main className="v5-loading-screen" role="status"><div className="v5-spinner" /><span>Loading RSIBOT V5…</span></main>;
  if (profile.isError) return <main className="v5-loading-screen"><div className="v5-error-panel" role="alert"><strong>V5 profile unavailable</strong><span>{profile.error.message}</span><button className="v5-button" onClick={() => void profile.refetch()}>Retry</button></div></main>;
  if (profile.data.schema_version !== "v5-dashboard-profile.v1" || profile.data.server.server_id !== "rsibot-v5" || profile.data.server.host !== "razer" || profile.data.server.mode !== "reports-only" || profile.data.server.execution_enabled !== false || profile.data.condor.base_revision !== "ff8858df765cffe4d325fde384f7a2eecdf51641") return <main className="v5-loading-screen"><div className="v5-error-panel" role="alert"><strong>V5 profile rejected</strong><span>The server returned an unexpected identity, baseline, mode, or execution state.</span></div></main>;
  return <V5Providers><V5AppShell>{!onBots && profile.data.readiness.paper_owner?.bot_name && <PaperJournalNotice bot={profile.data.readiness.paper_owner.bot_name} />}<SystemPauseProvider><Suspense fallback={<p role="status">Loading page…</p>}><Outlet /></Suspense></SystemPauseProvider></V5AppShell></V5Providers>;
}

function V5Providers({ children }: { children: React.ReactNode }) {
  const [logoutError, setLogoutError] = useState(false);
  const user: User | null = null;
  const auth: AuthState = useMemo(() => ({ user, token: null, recoveryReason: null, isAuthenticated: true, loginWithToken: async () => false, loginWithTailscale: async () => false, logout: () => { setLogoutError(false); void confirmLogout(v5Api.logout, () => clearSessionCache(client), () => setLogoutError(true)); } }), []);
  return <AuthContext value={auth}><ServerContext value={{ server: "rsibot-v5", setServer: () => {} }}>{logoutError && <div role="alert" className="fixed right-4 top-16 z-50 rounded-md border border-[var(--color-red)] bg-[var(--color-surface)] p-4 text-sm">Sign out failed. Your session is still active; please retry.</div>}{children}</ServerContext></AuthContext>;
}

export function V5App() {
  return <QueryClientProvider client={client}><BrowserRouter><Routes><Route element={<AuthGate />}><Route element={<ProfileGate />}><Route path="/" element={<V5Overview />} /><Route path="/market" element={<V5MarketHome />} /><Route path="/market/evidence" element={<Navigate to="/market" replace />} /><Route path="/market/candles" element={<Navigate to="/market" replace />} /><Route path="/market/:coin" element={<V5MarketHome />} /><Route path="/capital" element={<Capital />} /><Route path="/bots" element={<Bots />} /><Route path="/helm" element={<V5Helm />} /><Route path="/money" element={<Navigate to="/" replace />} /><Route path="/operations" element={<V5System initialTab="checks" />} /><Route path="/system" element={<V5System />} /><Route path="/system/:tab" element={<V5System />} /><Route path="/research" element={<Research />} /><Route path="/learning" element={<LearningPage />} /><Route path="/research-factory" element={<ResearchFactoryPage />} /><Route path="/decision-lineage" element={<DecisionLineagePage />} /><Route path="/backtests" element={<Tradepad />} /><Route path="/market/stocks" element={<V5MarketHome />} /><Route path="/v5/readiness" element={<V5System initialTab="readiness" />} /><Route path="/agents" element={<AgentsPage />} /><Route path="/agents/decisions" element={<AgentDecisionsPage />} /><Route path="/agents/:id" element={<AgentDetailPage />} /><Route path="/sessions" element={<SessionsPage />} /><Route path="/sessions/:id" element={<SessionDetailPage />} /><Route path="/settings" element={<V5System initialTab="settings" />} /><Route path="*" element={<V5NotFound />} /></Route></Route></Routes></BrowserRouter></QueryClientProvider>;
}
