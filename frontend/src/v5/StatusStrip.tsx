import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { readCandleStore } from "./candle-store-api";
import { readHelm } from "./V5Helm";
import type { PaperRead } from "./contracts";
import { paperObservationSummary, paperRiskControllers, paperRiskHolds } from "./policy";
import { laneHealth, statusStrip } from "./status-strip-model.mjs";
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
  // Owner holds from the current risk read AND newer retained safety evidence (a hold received during a refresh):
  // operator pause, emergency halt, native latch / entry hold, or a published hold. A hold is never hidden.
  // The displayed risk read counts for holds whatever the whole snapshot's freshness (safetyReads only carries signals
  // BEYOND the displayed snapshot), scoped to this bot, as the Bots page does (Sol R2 W4 B1).
  const displayedRisk = (paper.data ?? []).filter(read => read.section === "risk" && read.bot_id === bot) as PaperRead[];
  const riskEvidence: PaperRead[] = [...displayedRisk, ...((paper.safetyReads ?? []) as PaperRead[])];
  const controllers = riskEvidence.flatMap(read => paperRiskControllers(read, now) ?? []);
  const emergency = controllers.some(controller => controller.operator.emergency === true);
  const held = emergency || riskEvidence.some(read => paperRiskHolds(read).length > 0)
    || controllers.some(controller => controller.entryHold === true || controller.operator.paused === true || controller.holds.length > 0);
  const wallet = current ? reads!.find(read => read.section === "wallet")?.data as Record<string, unknown> | undefined : undefined;
  const stamps = [paper.dataUpdatedAt, helm.dataUpdatedAt, candleConfigured ? candles.dataUpdatedAt : 0].filter(ms => ms > 0);
  const strip = statusStrip({
    nowMs: now,
    v5: { bound: !!bot, pending: !!bot && !paper.data && !paper.isError, current, entryHold: held ? true : null, emergency, lastOkMs: paper.dataUpdatedAt || null },
    helm: { read: helm.isError ? null : helm.data ?? null, failed: helm.isError, lastOkMs: helm.dataUpdatedAt || null, receivedAtMs: helm.dataUpdatedAt || null },
    data: { configured: candleConfigured, pending: candleConfigured && !candles.data && !candles.isError, failed: candles.isError, lanes: candles.isError ? null : laneHealth((candles.data as { tiles?: unknown } | undefined)?.tiles), lastOkMs: candles.dataUpdatedAt || null, receivedAtMs: candles.dataUpdatedAt || null },
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
