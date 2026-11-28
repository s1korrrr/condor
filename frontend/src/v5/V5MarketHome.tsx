import { Link, useLocation, useParams } from "react-router-dom";
import { ReadNotice } from "@/components/ReadNotice";
import { MARKET_COINS } from "./market-model.mjs";
import { V5NotFound } from "./V5NotFound";
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
  const { coin } = useParams();
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile, retry: false });
  const candleConfigured = profile.data?.candle_store?.configured === true;
  if (coin && !MARKET_COINS.includes(coin)) return <V5NotFound />;
  if (location.pathname === "/market/stocks") return <V5Stocks configured={candleConfigured} profilePending={profile.isPending} profileError={profile.error} />;
  if (profile.isPending) return <ReadNotice kind="loading" title="Loading market…" />;
  if (profile.isError) return <ReadNotice kind="error" title="Market settings could not be loaded" reason={profile.error.message} onRetry={() => void profile.refetch()} />;
  if (!candleConfigured) return <section className="v5-panel"><h1>Market</h1><ReadNotice kind="unavailable" title="Not connected" reason="This dashboard has no candle store connection, so prices and market changes are unavailable." onRetry={() => void profile.refetch()} /><p>See <Link to="/system/data-feeds">System data feeds</Link> for connection details.</p></section>;
  return <V5Market />;
}
