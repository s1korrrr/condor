import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";

import { AppShell } from "@/components/layout/AppShell";
import { ServerContext } from "@/hooks/useServer";
import { AuthContext, SERVER_KEY, useAuth, useAuthState } from "@/lib/auth";
import { queryClient } from "@/lib/queryClient";
import { AgentDetail } from "@/pages/AgentDetail";
import { Agents } from "@/pages/Agents";
import { BotDetail } from "@/pages/BotDetail";
import { Bots } from "@/pages/Bots";
import { CreateExecutor } from "@/pages/CreateExecutor";
import { Executors } from "@/pages/Executors";
import { Login } from "@/pages/Login";
import { Portfolio } from "@/pages/Portfolio";
import { Routines } from "@/pages/Routines";
import { Settings } from "@/pages/Settings";
import { StrategyDetail } from "@/pages/StrategyDetail";
import { useServerCapabilities } from "@/hooks/useServerCapabilities";
import { WorkspaceTools } from "@/pages/WorkspaceTools";
import { CapabilityUnavailable } from '@/components/CapabilityUnavailable';
const Overview = lazy(() => import("@/pages/Overview").then(module => ({default:module.Overview})));
const Research = lazy(() => import("@/pages/Research").then(module => ({default:module.Research})));
const TradingVisuals = lazy(() => import("@/pages/TradingVisuals").then(module => ({ default: module.TradingVisuals })));

function Home() {
  const {access,isLoading}=useServerCapabilities();
  if(isLoading) return <p role="status">Loading workspace…</p>;
  if(!access.online) return <CapabilityUnavailable reason="Server capabilities are unavailable. Select or reconnect a server to open its workspace."/>;
  return access.native ? <Navigate to="/overview" replace/> : <Agents/>;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search + location.hash)}`} replace />;
  return <>{children}</>;
}

/**
 * Holds the selected server for the current session.
 *
 * Mounted with a key derived from the logged-in user, so a session change tears
 * this state down and re-reads `localStorage` — which `logout` has just cleared.
 * Without the remount the selection would outlive the session (logging out and
 * back in never reloads the page) and the next user would inherit it.
 */
function ServerProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<{server: string | null; persistenceError: string | null}>(() => {
    try { return {server: localStorage.getItem(SERVER_KEY), persistenceError: null}; }
    catch { return {server: null, persistenceError: 'Browser storage is unavailable. Select a server for this tab.'}; }
  });
  const handleSetServer = useCallback((s: string) => {
    let persistenceError: string | null = null;
    try { localStorage.setItem(SERVER_KEY, s); }
    catch { persistenceError = 'The server selection could not be saved. It remains selected for this tab.'; }
    setSelection({server: s, persistenceError});
    queryClient.invalidateQueries();
  }, []);

  return (
    <ServerContext value={{ ...selection, setServer: handleSetServer }}>
      {children}
    </ServerContext>
  );
}

export default function App() {
  const auth = useAuthState();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext value={auth}>
        <ServerProvider key={auth.user?.id ?? "anon"}>
          <BrowserRouter useTransitions={false}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route
                element={
                  <ProtectedRoute>
                    <AppShell />
                  </ProtectedRoute>
                }
              >
                <Route path="/" element={<Home />} />
                <Route path="/overview" element={<Suspense fallback={<p role="status">Loading overview…</p>}><Overview/></Suspense>} />
                <Route path="/research" element={<Suspense fallback={<p role="status">Loading research…</p>}><Research/></Suspense>} />
                <Route path="/tools" element={<WorkspaceTools/>} />
                <Route path="/portfolio" element={<Portfolio />} />
                <Route path="/bots" element={<Bots />} />
                <Route path="/bots/:id" element={<BotDetail />} />
                <Route path="/trade" element={<CreateExecutor />} />
                <Route path="/trading-visuals" element={<Suspense fallback={<p role="status">Loading Trading Visuals…</p>}><TradingVisuals /></Suspense>} />
                <Route path="/executors" element={<Executors />} />
                <Route path="/executors/new" element={<Navigate to="/trade" replace />} />
                <Route path="/executors/new-grid" element={<Navigate to="/trade?type=grid" replace />} />
                <Route path="/backtest" element={<Navigate to="/bots?tab=backtest" replace />} />
                <Route path="/archived" element={<Navigate to="/bots?tab=archived" replace />} />
                <Route path="/routines" element={<Routines />} />
                <Route path="/reports" element={<Navigate to="/routines?tab=reports" replace />} />
                <Route path="/agents" element={<Agents />} />
                <Route path="/agents/:slug" element={<AgentDetail />} />
                <Route path="/agents/:slug/strategies/:sslug" element={<StrategyDetail />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/market" element={<Navigate to="/trade" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ServerProvider>
      </AuthContext>
    </QueryClientProvider>
  );
}
