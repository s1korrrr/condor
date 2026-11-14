import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { readCandleStore } from "./candle-store-api";
import { readHelm } from "./V5Helm";
import { paperObservationSummary, paperRiskControllers } from "./policy";
import { slowestLaneAge, statusStrip } from "./status-strip-model.mjs";
import { usePaperClock } from "./usePaperClock";
import { usePaperObservation } from "./usePaperObservation";
import "./status-strip.css";

/**
 * Status strip shown by the shell on every V5 page. It reads nothing of its own that a page does not already read:
 * the paper observation (Bots/Settings), Helm (Helm page) and the candle-store summary (Market) share their
 * react-query keys, so one request serves both. Polling is TanStack's default: it pauses in hidden tabs.
 */
export function StatusStrip({ bot, candleConfigured }: { bot: string | null; candleConfigured: boolean }) {
  const now = usePaperClock();
  const paper = usePaperObservation(bot);
  const helm = useQuery({ queryKey: ["v5-helm"], queryFn: readHelm, retry: false, refetchInterval: 15_000 });
  const candles = useQuery({ queryKey: ["candle-summary"], queryFn: () => readCandleStore<{ tiles: unknown }>("summary"), retry: false, refetchInterval: 30_000, enabled: candleConfigured });
  // Current only when the last read succeeded and the whole set passes the paper read contracts at this moment.
  const reads = paper.isError ? null : paper.data ?? null;
  const current = !!bot && !!reads && paperObservationSummary(reads, bot, now).label === "Available";
  const risk = current ? paperRiskControllers(reads!.find(read => read.section === "risk"), now) : null;
  const wallet = current ? reads!.find(read => read.section === "wallet")?.data as Record<string, unknown> | undefined : undefined;
  const stamps = [paper.dataUpdatedAt, helm.dataUpdatedAt, candleConfigured ? candles.dataUpdatedAt : 0].filter(ms => ms > 0);
  const strip = statusStrip({
    nowMs: now,
    v5: { bound: !!bot, pending: !!bot && !paper.data && !paper.isError, current, entryHold: risk?.some(controller => controller.entryHold === true) ? true : null, lastOkMs: paper.dataUpdatedAt || null },
    helm: { read: helm.isError ? null : helm.data, failed: helm.isError, lastOkMs: helm.dataUpdatedAt || null },
    data: { configured: candleConfigured, pending: candleConfigured && !candles.data && !candles.isError, failed: candles.isError, slowestLagS: candles.isError ? null : slowestLaneAge((candles.data as { tiles?: unknown } | undefined)?.tiles), lastOkMs: candles.dataUpdatedAt || null },
    wallet: { current, equity: wallet?.equity_quote, funding: wallet?.initial_funding_quote, flows: wallet?.external_cash_flows_quote, unit: wallet?.quote_asset },
    updatedMs: stamps.length ? Math.max(...stamps) : null,
  });
  return <div role="status" aria-label="V5 status" className="v5-strip">
    {strip.chips.map(chip => <NavLink key={chip.id} to={chip.to} className={`v5-strip-chip is-${chip.tone} is-${chip.id}`} title={`${chip.label}: ${chip.text}`}>
      <i aria-hidden="true" />
      <span className="v5-strip-long"><b>{chip.label}</b> {chip.text}</span>
      <span className="v5-strip-short">{chip.short}</span>
    </NavLink>)}
    <NavLink to="/operations" className={`v5-strip-count${strip.toCheck ? " has-items" : ""}`} title={strip.checkText}><span className="v5-strip-long">{strip.checkText}</span><span className="v5-strip-short">{strip.shortCheckText}</span></NavLink>
    <span className="v5-strip-updated">{strip.updated}</span>
    <NavLink to="/v5/readiness" className="v5-strip-link">Readiness and open gates</NavLink>
  </div>;
}
