import { useEffect, useRef } from "react";
import {
  Activity,
  Bot,
  Brain,
  Eye,
  Moon,
  Settings,
  Sun,
  Swords,
  Wallet,
  Zap,
  ChartNoAxesCombined,
  Network,
  Wrench,
} from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { ConnectKeysOverlay } from "@/components/ConnectKeysOverlay";
import { CapabilityUnavailable } from "@/components/CapabilityUnavailable";
import { FallbackSpinner } from "@/components/ui/FallbackSpinner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ChatProvider } from "@/hooks/useChat";
import { useCredentials } from "@/hooks/useCredentials";
import { usePrefetchData } from "@/hooks/usePrefetchData";
import { useServer } from "@/hooks/useServer";
import { useServerCapabilities } from "@/hooks/useServerCapabilities";
import { unavailableServerRoute } from "@/lib/server-capabilities";
import { useTheme } from "@/hooks/useTheme";
import { CurrencySelector } from "./CurrencySelector";
import { ServerSelector } from "./ServerSelector";

const NAV_ITEMS = [
  { to: "/overview", icon: ChartNoAxesCombined, label: "Overview" },
  { to: "/research", icon: Network, label: "Research" },
  { to: "/tools", icon: Wrench, label: "Tools" },
  { to: "/", icon: Brain, label: "Agents" },
  { to: "/portfolio", icon: Wallet, label: "Portfolio" },
  { to: "/trade", icon: Swords, label: "Trade" },
  { to: "/trading-visuals", icon: Eye, label: "Trading Visuals" },
  { to: "/bots", icon: Bot, label: "Bots" },
  { to: "/executors", icon: Activity, label: "Executors" },
  { to: "/routines", icon: Zap, label: "Routines" },
] as const;

/**
 * The shell owns the chat state.
 *
 * There used to be two surfaces rendering a conversation — an overlay panel
 * docked to the right of every page, and the workspace at `/agents` — which
 * meant two doors to one thing. The panel is gone; the provider stays here so
 * the socket outlives navigation between pages and `/agents`.
 */
export function AppShell() {
  return (
    <ChatProvider>
      <AppShellBody />
    </ChatProvider>
  );
}

function AppShellBody() {
  const { server } = useServer();
  const { pathname } = useLocation();
  const navigationRef = useRef<HTMLElement>(null);
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const { hasKeys, isLoading: keysLoading } = useCredentials();
  const { data: serverStatus, access, isLoading: capabilitiesLoading } = useServerCapabilities();
  const capabilityReason = server ? unavailableServerRoute(pathname, serverStatus) : null;
  const nativeRoutes=['/overview','/portfolio','/trading-visuals','/bots','/research','/tools'];
  const navigationItems=access.native ? nativeRoutes.map(to=>NAV_ITEMS.find(item=>item.to===to)!) : NAV_ITEMS;

  // The chat workspace takes the full height and owns its own scrolling, so
  // the shell drops `main`'s padding for it. It lives at `/` — the entry point
  // — while `/agents/:slug` is an ordinary padded page, deliberately not
  // matched here.
  const isChatWorkspace = (pathname === "/" && !access.native) || pathname === "/agents";

  useEffect(() => {
    const navigation = navigationRef.current;
    if (!navigation) return;
    const revealSelectedRoute = () => {
      const selected = navigation.querySelector<HTMLElement>('[aria-current="page"]');
      if (!selected) return;
      const viewport = navigation.getBoundingClientRect();
      const link = selected.getBoundingClientRect();
      if (link.left < viewport.left) navigation.scrollLeft += link.left - viewport.left;
      else if (link.right > viewport.right) navigation.scrollLeft += link.right - viewport.right;
    };
    revealSelectedRoute();
    const observer = new ResizeObserver(revealSelectedRoute);
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [pathname]);

  // The chat is the landing page and needs no exchange keys, so the blocking
  // overlay would otherwise be the first thing every unconfigured user hits —
  // on the one surface that can talk them through connecting.
  const exemptRoutes = ["/routines", "/settings", "/trading-visuals", "/overview", "/research", "/tools"];
  const showKeysOverlay =
    server && !access.native && access.accounts && !capabilityReason && !keysLoading && !hasKeys && !isChatWorkspace &&
    !exemptRoutes.some((r) => pathname.startsWith(r));

  // ⌘K used to toggle the overlay panel. It now goes to the chat, so the
  // reflex still lands somewhere sensible instead of silently doing nothing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        navigate(access.native ? "/research" : "/agents");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, access.native]);

  // Prefetch core data (executors, bots) and subscribe to WS channels early
  usePrefetchData();

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar */}
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-y-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 lg:flex-nowrap lg:px-4 lg:py-0">
        {/* Left: logo + nav */}
        <div className="flex min-w-0 w-full items-center gap-3 lg:w-auto lg:gap-6">
          <NavLink to="/" className="flex shrink-0 items-center gap-2 font-bold tracking-tight">
            <img src="/condor_old.jpeg" alt="Condor" className="h-6 w-6 rounded-full" />
            <span className="text-sm">Condor</span>
          </NavLink>

          <nav ref={navigationRef} aria-label="Main navigation" className="flex min-w-0 items-center overflow-x-auto whitespace-nowrap">
            {navigationItems.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-1.5 px-3 py-2 text-sm rounded-md transition-colors ${
                    isActive
                      ? "bg-[var(--color-primary)]/15 text-[var(--color-primary)]"
                      : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                  }`
                }
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {label}
              </NavLink>
            ))}
          </nav>
        </div>

        {/* Right: server selector + controls */}
        <div className="ml-auto flex items-center gap-3">
          <ServerSelector />
          {pathname === "/trading-visuals" || access.native ? (
            <span className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-sm text-[var(--color-text-muted)]" title="Values retain their source units; this deployment does not convert currencies">{['/trading-visuals','/overview','/bots'].includes(pathname)?'USDC':'Source units'}</span>
          ) : <CurrencySelector />}

          <div className="flex items-center gap-1">
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `rounded p-1.5 transition-colors ${
                  isActive
                    ? "bg-[var(--color-primary)]/15 text-[var(--color-primary)]"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)]"
                }`
              }
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </NavLink>

            <button
              onClick={toggleTheme}
              className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)]"
              title={
                theme === "dark" ? "Switch to light mode" :
                theme === "light" ? "Switch to color-blind mode" :
                "Switch to dark mode"
              }
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> :
               theme === "light" ? <Eye className="h-4 w-4" /> :
               <Moon className="h-4 w-4" />}
            </button>

          </div>
        </div>
      </header>

      {/* Main content */}
      <main
        className={`relative flex-1 ${
          isChatWorkspace ? "overflow-hidden" : "overflow-auto p-3 sm:p-6"
        }`}
      >
        <ErrorBoundary resetKey={pathname + server}>
          {capabilityReason ? capabilitiesLoading ? <FallbackSpinner /> : <CapabilityUnavailable reason={capabilityReason} /> : <Outlet key={server} />}
        </ErrorBoundary>
        {showKeysOverlay && <ConnectKeysOverlay />}
      </main>
    </div>
  );
}
