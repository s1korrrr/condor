import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, ChevronRight, CircleHelp, Clock3, Compass, Database, LogOut, Menu, RefreshCw, Settings2, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { v5Api } from "./api";

const navigation = [
  { to: "/", label: "Overview", icon: Compass, end: true },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/market", label: "Market", icon: Activity },
  { to: "/sessions", label: "Sessions", icon: Clock3 },
  { to: "/settings", label: "Settings", icon: Settings2 },
];

export function V5Layout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["v5-workspace"], queryFn: v5Api.workspace, refetchInterval: 30_000 });
  const logout = useMutation({
    mutationFn: v5Api.logout,
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(["v5-auth"], { authenticated: false });
    },
  });
  const heading = navigation.find((item) => item.to === location.pathname)?.label ??
    (location.pathname.startsWith("/agents/") ? "Agent workspace" : location.pathname.startsWith("/sessions/") ? "Session record" : "RSI V5");
  const identity = workspace.data?.identity;

  return (
    <div className="v5-app-shell">
      {mobileOpen && <button className="v5-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <aside className={`v5-sidebar${mobileOpen ? " v5-sidebar-open" : ""}`}>
        <div className="v5-brand-row">
          <div className="v5-brand-mark" aria-hidden="true"><span>R</span><i /></div>
          <div><strong>RSI V5</strong><small>Research workspace</small></div>
          <button className="v5-icon-button v5-mobile-close" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><X size={18} /></button>
        </div>
        <div className="v5-side-context"><span className="v5-live-dot" />RAZER · REPORTS ONLY</div>
        <nav className="v5-nav" aria-label="V5 workspace">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} onClick={() => setMobileOpen(false)} className={({ isActive }) => `v5-nav-link${isActive ? " is-active" : ""}`}>
              <Icon size={17} strokeWidth={1.8} /><span>{label}</span><ChevronRight className="v5-nav-chevron" size={14} />
            </NavLink>
          ))}
        </nav>
        <div className="v5-sidebar-bottom">
          <div className="v5-safety-rail"><ShieldCheck size={16} /><div><strong>Execution disabled</strong><span>Reports and inspection only</span></div></div>
          <button className="v5-nav-link v5-logout" onClick={() => logout.mutate()} disabled={logout.isPending}><LogOut size={17} /><span>{logout.isPending ? "Signing out…" : "Sign out"}</span></button>
          <div className="v5-sidebar-foot"><span>RSI V5</span><span>Isolated from Condor</span></div>
        </div>
      </aside>

      <div className="v5-main-column">
        <header className="v5-topbar">
          <button className="v5-icon-button v5-mobile-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={19} /></button>
          <div className="v5-breadcrumb"><span>RSI V5</span><ChevronRight size={13} /><strong>{heading}</strong></div>
          <div className="v5-topbar-meta">
            <span className="v5-mode"><span className="v5-live-dot" />{identity?.mode ?? "reports-only"}</span>
            <button className="v5-icon-button" aria-label="Refresh workspace" title="Refresh workspace" onClick={() => void queryClient.invalidateQueries({ queryKey: ["v5-workspace"] })}><RefreshCw size={16} /></button>
            <button className="v5-icon-button v5-help" aria-label="About RSI V5" title="RSI V5 is an isolated reports-only workspace"><CircleHelp size={16} /></button>
          </div>
        </header>
        <div className="v5-content" key={location.pathname}>{children}</div>
        <footer className="v5-footer"><span><Database size={13} />Owner data from the Razer V5 service</span><span>Not a trading surface</span></footer>
      </div>
    </div>
  );
}
