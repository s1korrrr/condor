import { Activity, Bot, Eye, LogOut, Menu, Moon, Network, ScanSearch, Settings, ShieldCheck, Sun, Wallet, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { v5Api } from "./api";
import { paperWorkspaceLabel } from "./policy";
import { useTheme } from "@/hooks/useTheme";
import { useAuth } from "@/lib/auth";

/**
 * Five menu groups (Fable UI review, Falco 12:08Z). Each group owns the older pages it replaces; they stay reachable
 * from the group's sub-row, so no address stops working.
 */
type NavGroup = { to: string; label: string; icon: typeof Wallet; pages: [to: string, label: string][] };

const nav: NavGroup[] = [
  { to: "/", label: "Overview", icon: Wallet, pages: [["/", "Overview"], ["/capital", "Capital"]] },
  { to: "/bots", label: "Bots", icon: Bot, pages: [["/bots", "V5"], ["/helm", "Helm"]] },
  { to: "/market", label: "Market", icon: ScanSearch, pages: [["/market", "Market"], ["/market/stocks", "OKX stocks"]] },
  { to: "/operations", label: "System", icon: Activity, pages: [["/operations", "Operations"], ["/v5/readiness", "Readiness"], ["/settings", "Settings"]] },
  { to: "/research", label: "Research", icon: Network, pages: [["/research", "Research"], ["/backtests", "Tradepad"], ["/learning", "Learning"], ["/research-factory", "Research factory"], ["/decision-lineage", "Decision history"], ["/agents", "Agents"], ["/sessions", "Sessions"]] },
];

/** The group a path belongs to: its own page, or a sub-page (e.g. /agents/x under Research). */
function groupOf(pathname: string): NavGroup | null {
  return nav.find(group => group.pages.some(([to]) => to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`))) ?? null;
}

export function V5AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [navOpen, setNavOpen] = useState(false);
  const query = useQueryClient();
  const { theme, toggleTheme } = useTheme();
  const { logout } = useAuth();
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile, refetchInterval: 15_000 });
  const paperLabel = paperWorkspaceLabel(profile.data);
  const group = groupOf(pathname);
  // The one most specific sub-page that matches (exact, else the longest prefix): /market/stocks marks only OKX stocks,
  // /market/BTC marks Market, /agents/x marks Agents; "/" matches only exactly.
  const subActive = group?.pages.map(([to]) => to).filter(to => pathname === to || (to !== "/" && pathname.startsWith(`${to}/`))).sort((x, y) => y.length - x.length)[0] ?? null;
  const heading = group?.pages.find(([to]) => to === pathname)?.[1] ?? (pathname.startsWith("/agents/") ? "Agent workspace" : pathname.startsWith("/sessions/") ? "Session record" : pathname === "/market/stocks" ? "Stocks" : pathname === "/v5/readiness" ? "V5 readiness" : "RSI V5");
  useEffect(() => {
    setNavOpen(false);
    const el = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el?.offsetParent) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  return <div className="condor-shell condor-native flex h-dvh flex-col">
    <header className="condor-topbar v5-shell-header">
      <div className="v5-shell-primary">
        <NavLink to="/" className="v5-shell-brand flex shrink-0 items-center gap-2 font-bold tracking-tight"><img src="/condor_old.jpeg" alt="RSIBOT" className="h-6 w-6 rounded-full" /><span className="text-sm">RSIBOT <span className="text-[var(--color-primary)]">V5</span></span></NavLink>
        <span className="v5-shell-scope" title={paperLabel ?? "Razer · advisor reports only · live disabled"}>{paperLabel ? "PAPER · live disabled" : "ADVISOR · live disabled"}</span>
        <button className="v5-shell-menu" aria-label={navOpen ? "Close navigation" : "Open navigation"} aria-expanded={navOpen} aria-controls="v5-main-navigation" onClick={() => setNavOpen(open => !open)}>{navOpen ? <X size={16} /> : <Menu size={16} />}Menu</button>
      </div>
      <nav ref={navRef} id="v5-main-navigation" aria-label="Main navigation" className={`v5-shell-nav${navOpen ? " is-open" : ""}`}>
        {nav.map(item => { const { to, label, icon: Icon } = item; const current = item === group; return <Link key={to} to={to} aria-current={current ? "page" : undefined} onClick={() => setNavOpen(false)} className={`v5-shell-link ${current ? "bg-[var(--color-primary)]/15 text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"}`}><Icon className="h-3.5 w-3.5 shrink-0" />{label}</Link>; })}
      </nav>
      <div className="v5-shell-tools"><span className="v5-shell-route text-sm text-[var(--color-text-muted)]">{heading}</span><NavLink to="/settings" aria-label="V5 settings" title="V5 settings" className={({ isActive }) => `rounded p-1.5 ${isActive ? "bg-[var(--color-primary)]/15 text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"}`}><Settings className="h-4 w-4" /></NavLink><button onClick={toggleTheme} className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]" title={theme === "dark" ? "Switch to light mode" : theme === "light" ? "Switch to color-blind mode" : "Switch to dark mode"}>{theme === "dark" ? <Sun className="h-4 w-4" /> : theme === "light" ? <Eye className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button><button aria-label="Refresh V5 workspace" title="Refresh V5 workspace" onClick={() => { void query.invalidateQueries({ queryKey: ["v5-workspace"] }); void query.invalidateQueries({ queryKey: ["v5-sessions"] }); }} className="rounded px-2 py-1 text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]">Refresh</button><button aria-label="Sign out of RSI V5" title="Sign out" onClick={logout} className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"><LogOut className="h-4 w-4" /></button></div>
    </header>
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-muted)]"><ShieldCheck className="h-3.5 w-3.5 text-[var(--color-primary)]" />{pathname === "/market/stocks" ? "OKX stocks · public market observations · execution disabled" : paperLabel ?? "V5 profile · separate Razer service · execution disabled · baseline and account owners unbound"}<NavLink to="/v5/readiness" className="underline">Readiness and open gates</NavLink></div>
    {group && group.pages.length > 1 && <nav aria-label={`${group.label} pages`} className="v5-shell-subnav flex flex-wrap gap-1 border-b border-[var(--color-border)] px-4 py-1.5 text-sm">{group.pages.map(([to, label]) => { const isActive = to === subActive; return <Link key={to} to={to} aria-current={isActive ? "page" : undefined} className={`rounded-md px-2.5 py-1 ${isActive ? "bg-[var(--color-primary)]/15 text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"}`}>{label}</Link>; })}</nav>}
    <main className="relative flex-1 overflow-auto p-3 sm:p-6"><div className="mx-auto w-full max-w-[1600px]">{children}</div></main>
  </div>;
}
