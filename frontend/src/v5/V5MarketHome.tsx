import { lazy, Suspense } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { MarketPage } from "./V5Pages";

const ExistingMarketPicture = lazy(() => import("@/features/market-picture/MarketPicture").then(m => ({ default: m.MarketPicture })));

export function V5MarketHome() {
  const location = useLocation();
  const evidenceTab = location.pathname === "/market/evidence";
  return <section>
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-border)] pb-4">
      <div><h1 className="text-2xl font-semibold tracking-tight">Market</h1><p className="mt-1 text-sm text-[var(--color-text-muted)]">Market monitoring for the V5 stack on Razer.</p></div>
      <nav aria-label="Market views" className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1"><NavLink end to="/" className={({isActive}) => `rounded-md px-3 py-1.5 text-sm ${isActive ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>Condor Market Picture</NavLink><NavLink to="/market/evidence" className={({isActive}) => `rounded-md px-3 py-1.5 text-sm ${isActive ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>V5 multi-venue context</NavLink></nav>
    </div>
    {evidenceTab ? <MarketPageInline /> : <><div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-muted)]">V5 Market Picture is waiting for its market source. Open multi-venue context to inspect the available feed.</div><Suspense fallback={<p role="status">Loading Condor Market Picture…</p>}><ExistingMarketPicture /></Suspense></>}
  </section>;
}

function MarketPageInline() { return <MarketPage />; }
