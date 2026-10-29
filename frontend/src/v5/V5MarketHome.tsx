import { lazy, Suspense } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { MarketPage } from "./V5Pages";
import { useQuery } from "@tanstack/react-query";
import { v5Api } from "./api";
import { V5CandleStore } from "./V5CandleStore";

const ExistingMarketPicture = lazy(() => import("@/features/market-picture/MarketPicture").then(m => ({ default: m.MarketPicture })));

export function V5MarketHome() {
  const location = useLocation();
  const evidenceTab = location.pathname === "/";
  const candleTab = location.pathname === "/market/candles";
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile, retry: false });
  const candleConfigured = profile.data?.candle_store?.configured === true;
  return <section>
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-border)] pb-4">
      <div><h1 className="text-2xl font-semibold tracking-tight">Market</h1><p className="mt-1 text-sm text-[var(--color-text-muted)]">Market monitoring for the V5 stack on Razer.</p></div>
      <nav aria-label="Market views" className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1"><NavLink end to="/" className={({isActive}) => `rounded-md px-3 py-1.5 text-sm ${isActive ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>V5 multi-venue context</NavLink><NavLink to="/market/evidence" className={({isActive}) => `rounded-md px-3 py-1.5 text-sm ${isActive ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>Condor Market Picture</NavLink>{candleConfigured && <NavLink to="/market/candles" className={({isActive}) => `rounded-md px-3 py-1.5 text-sm ${isActive ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>Candle store</NavLink>}</nav>
    </div>
    {candleTab ? (candleConfigured ? <V5CandleStore /> : <p>Candle store is not configured for this deployment.</p>) : evidenceTab ? <MarketPageInline /> : <><div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-muted)]">The legacy Condor Market Picture frame has no V5 native frame binding. It is kept separate from the V5 multi-venue evidence feed.</div><Suspense fallback={<p role="status">Loading Condor Market Picture…</p>}><ExistingMarketPicture /></Suspense></>}
  </section>;
}

function MarketPageInline() { return <MarketPage />; }
