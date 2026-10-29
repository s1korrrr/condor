import { Activity, Bot, ChartCandlestick, ChartNoAxesCombined, Clock3, Eye, LogOut, Moon, Network, ScanSearch, Settings, ShieldCheck, Sun } from "lucide-react";
import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { v5Api } from "./api";
import { paperWorkspaceLabel } from "./policy";
import { useTheme } from "@/hooks/useTheme";
import { useAuth } from "@/lib/auth";

const nav = [
  { to: "/", label: "Market", icon: ScanSearch, end: true },
  { to: "/capital", label: "Capital", icon: ChartNoAxesCombined },
  { to: "/bots", label: "Bots", icon: Bot },
  { to: "/operations", label: "Operations", icon: Activity },
  { to: "/research", label: "Research", icon: Network },
  { to: "/backtests", label: "Tradepad", icon: ChartCandlestick },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/sessions", label: "Sessions", icon: Clock3 },
];

export function V5AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const query = useQueryClient();
  const { theme, toggleTheme } = useTheme();
  const { logout } = useAuth();
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile, refetchInterval: 15_000 });
  const paperLabel = paperWorkspaceLabel(profile.data);
  const heading = nav.find(item => item.to === pathname)?.label ?? (pathname.startsWith("/agents/") ? "Agent workspace" : pathname.startsWith("/sessions/") ? "Session record" : pathname === "/market/evidence" ? "V5 market evidence" : pathname === "/v5/readiness" ? "V5 readiness" : "RSI V5");
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  return <div className="condor-shell condor-native flex h-dvh flex-col">
    <header className="condor-topbar flex min-h-12 shrink-0 flex-wrap items-center gap-y-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 xl:flex-nowrap lg:px-4 xl:py-0">
      <div className="flex min-w-0 w-full items-center gap-3 xl:w-auto xl:gap-6">
        <NavLink to="/" className="flex shrink-0 items-center gap-2 font-bold tracking-tight"><img src="/condor_old.jpeg" alt="RSIBOT" className="h-6 w-6 rounded-full" /><span className="text-sm">RSIBOT <span className="text-[var(--color-primary)]">V5</span></span></NavLink>
        <nav ref={navRef} aria-label="Main navigation" className="flex min-w-0 items-center overflow-x-auto whitespace-nowrap">
          {nav.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => `flex shrink-0 items-center gap-1.5 px-3 py-2 text-sm rounded-md transition-colors ${isActive ? "bg-[var(--color-primary)]/15 text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"}`}><Icon className="h-3.5 w-3.5 shrink-0" />{label}</NavLink>)}
        </nav>
      </div>
      <div className="ml-auto flex items-center gap-2"><span className="text-sm text-[var(--color-text-muted)]">{heading}</span><span className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-sm text-[var(--color-text-muted)]">{paperLabel ? "Razer · PAPER" : "Razer · reports only"}</span><NavLink to="/settings" aria-label="V5 settings" title="V5 settings" className={({ isActive }) => `rounded p-1.5 ${isActive ? "bg-[var(--color-primary)]/15 text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"}`}><Settings className="h-4 w-4" /></NavLink><button onClick={toggleTheme} className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]" title={theme === "dark" ? "Switch to light mode" : theme === "light" ? "Switch to color-blind mode" : "Switch to dark mode"}>{theme === "dark" ? <Sun className="h-4 w-4" /> : theme === "light" ? <Eye className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button><button aria-label="Refresh V5 workspace" title="Refresh V5 workspace" onClick={() => { void query.invalidateQueries({ queryKey: ["v5-workspace"] }); void query.invalidateQueries({ queryKey: ["v5-sessions"] }); }} className="rounded px-2 py-1 text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]">Refresh</button><button aria-label="Sign out of RSI V5" title="Sign out" onClick={logout} className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"><LogOut className="h-4 w-4" /></button></div>
    </header>
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-muted)]"><ShieldCheck className="h-3.5 w-3.5 text-[var(--color-primary)]" />{paperLabel ?? "V5 profile · separate Razer service · execution disabled · baseline and account owners unbound"}<NavLink to="/v5/readiness" className="underline">Readiness and open gates</NavLink></div>
    <main className="relative flex-1 overflow-auto p-3 sm:p-6"><div className="mx-auto w-full max-w-[1600px]">{children}</div></main>
  </div>;
}
