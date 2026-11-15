import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { candleRequestedAt, candleSummaryQuery } from "./candle-store-api";
import { helmRequestedAt, readHelm } from "./V5Helm";
import type { PaperRead } from "./contracts";
import { paperNativeHolds, paperObservationSummary, paperRiskControllers, paperRiskHolds } from "./policy";
import { laneHealth, statusStrip } from "./status-strip-model.mjs";
import { usePaperClock } from "./usePaperClock";
import { usePaperObservation } from "./usePaperObservation";
import "./status-strip.css";

/**
 * Status strip shown by the shell on every V5 page. Paper observations have a separate query from Bots but share
 * bot-scoped safety evidence; Helm and candle summary use their pages' query keys. Polling pauses in hidden tabs.
 */
export function StatusStrip({ bot, candleConfigured }: { bot: string | null; candleConfigured: boolean }) {
  const now = usePaperClock();
  const paper = usePaperObservation(bot);
  const helm = useQuery({ queryKey: ["v5-helm"], queryFn: readHelm, retry: false, refetchInterval: 15_000 });
  const candles = useQuery({ ...candleSummaryQuery<{ tiles: unknown; now?: number | null; status_age_s?: number | null }>(), retry: false, refetchInterval: 30_000, enabled: candleConfigured });
  // Current only when the last read succeeded and the whole set passes the paper read contracts at this moment.
  const reads = paper.isError ? null : paper.data ?? null;
  const current = !!bot && !!reads && paperObservationSummary(reads, bot, now).label === "Available";
  // Owner holds from the current risk read AND newer retained safety evidence (a hold received during a refresh):
  // operator pause, emergency halt, native latch / entry hold, or a published hold. A hold is never hidden.
  // The displayed risk contributes holds even when stale, unless newer qualified shared evidence supersedes them.
  const displayedRisk = (paper.data ?? []).filter(read => read.section === "risk" && read.bot_id === bot) as PaperRead[];
  const riskEvidence: PaperRead[] = [...paper.reconcileSafety(displayedRisk), ...paper.safetyEvidence];
  const controllers = riskEvidence.flatMap(read => paperRiskControllers(read, now) ?? []);
  const emergency = controllers.some(controller => controller.operator.emergency === true);
  const held = emergency || riskEvidence.some(read => paperRiskHolds(read).length > 0 || paperNativeHolds(read).length > 0)
    || controllers.some(controller => controller.entryHold === true || controller.operator.paused === true || controller.holds.length > 0);
  // "Running" needs the owner's affirmative word from the displayed current risk read: at least one controller, each with
  // operator pause and emergency explicitly false and native evidence complete with no latch or entry hold (Terra R3 B1).
  const currentRisk = current ? displayedRisk.flatMap(read => paperRiskControllers(read, now) ?? []) : [];
  const runKnown = current && currentRisk.length > 0 && displayedRisk.every(read => paperRiskHolds(read).length === 0)
    && currentRisk.every(controller => controller.operator.paused === false && controller.operator.emergency === false && controller.entryHold === false);
  const helmSentMs = helm.data ? helmRequestedAt(helm.data) ?? null : null;
  const helmLastUsableMs = helm.data?._lastUsableAtMs ?? null;
  const candleSentMs = candles.data ? candleRequestedAt(candles.data) ?? null : null;
  const wallet = current ? reads!.find(read => read.section === "wallet")?.data as Record<string, unknown> | undefined : undefined;
  const stamps = [paper.lastUsableAtMs ?? 0, helmLastUsableMs ?? 0, candleConfigured ? candles.dataUpdatedAt : 0].filter(ms => ms > 0);
  const strip = statusStrip({
    nowMs: now,
    v5: { bound: !!bot, pending: !!bot && !paper.data && !paper.isError, current, runKnown, entryHold: held ? true : null, emergency, restartOrderUnknown:paper.restartOrderUnknown, lastOkMs: paper.lastUsableAtMs },
    helm: { read: helm.isError ? null : helm.data ?? null, failed: helm.isError, lastOkMs: helmLastUsableMs, receivedAtMs: helm.dataUpdatedAt || null, requestedAtMs: helmSentMs },
    data: { configured: candleConfigured, pending: candleConfigured && !candles.data && !candles.isError, failed: candles.isError, summary: candles.data, lanes: candles.isError ? null : laneHealth(candles.data?.tiles), lastOkMs: candles.dataUpdatedAt || null, receivedAtMs: candles.dataUpdatedAt || null, requestedAtMs: candleSentMs },
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
    <span className="v5-strip-updated"><span className="v5-strip-long">{strip.updated}</span><span className="v5-strip-short">{strip.updatedShort}</span></span>
    <NavLink to="/v5/readiness" className="v5-strip-link">Readiness and open gates</NavLink>
  </div>;
}
