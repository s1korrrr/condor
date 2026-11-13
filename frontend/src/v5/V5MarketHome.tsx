import { NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { v5Api } from "./api";
import { V5Market } from "./V5Market";
import { V5Stocks } from "./V5Stocks";

/**
 * Market is one page. The former "V5 multi-venue context", "Condor Market Picture" and "Candle store" views are
 * folded into it (old links land here). OKX stocks stay a separate view: different instruments, not the five coins.
 */
export function V5MarketHome() {
  const location = useLocation();
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile, retry: false });
  const candleConfigured = profile.data?.candle_store?.configured === true;
  if (location.pathname === "/market/stocks") return <section>
    <nav aria-label="Market views" className="mb-4 text-sm"><NavLink to="/" className="underline">← Market</NavLink></nav>
    <V5Stocks configured={candleConfigured} profilePending={profile.isPending} profileError={profile.error} />
  </section>;
  if (profile.isPending) return <p role="status">Loading market…</p>;
  if (!candleConfigured) return <section className="v5-panel"><h1>Market</h1><p>The candle store is not configured for this deployment, so no prices, coverage or market moves can be shown. No values are inferred.</p></section>;
  return <><V5Market /><p className="mt-4 text-sm text-[var(--color-text-muted)]"><NavLink to="/market/stocks" className="underline">OKX stocks capture</NavLink> · separate instruments, kept on their own page.</p></>;
}
