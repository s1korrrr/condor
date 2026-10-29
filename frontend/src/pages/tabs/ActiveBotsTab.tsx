import { useQuery, useMutation, useQueryClient, skipToken } from "@tanstack/react-query";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Layers,
  Pause,
  Play,
  Rocket,
  Square,
  TrendingUp,
  Volume2,
} from "lucide-react";
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import type { PaperRead } from "@/v5/contracts";
import { paperAmount, paperCompleteRecords, paperControlState, paperExactAmount, paperLifetimeTotals, paperOpenExecutorCount, paperOrderCount, paperPairObservation, paperReadState, paperRiskHold, paperRiskHolds, paperExitProjection, paperRiskUsage, paperSectionError, paperSnapshotsAgree, paperTime, paperWalletInventory, paperWalletTotals, paperWords } from "@/v5/policy";
import { DataTable, type TableColumn } from "@/features/quant-ops/kit/DataTable";
import { paperHeartbeat } from "@/features/bots/fleet-health";
import "@/components/bots/fleet-strip.css";

import { NoServerCard } from "@/components/NoServerCard";
import { AggregatedPnlChart } from "@/components/bots/AggregatedPnlChart";
import { ControllerBrowser } from "@/components/bots/ControllerBrowser";
import { DeployBotDialog } from "@/components/bots/DeployBotDialog";
import { PnlSparkline } from "@/components/bots/PnlSparkline";
import { NativeEntryControls } from "@/components/bots/NativeEntryControls";
import { BotsRoster } from "@/components/bots/BotsRoster";
import { FallbackSpinner } from "@/components/ui/FallbackSpinner";

import { useRates } from "@/hooks/useRates";
import { useServer } from "@/hooks/useServer";
import { useServerCapabilities } from "@/hooks/useServerCapabilities";
import { useCondorWebSocket } from "@/hooks/useWebSocket";
import { api, type BotLogEntry, type BotSummary, type ControllerInfo, type ControllerPerformanceSnapshot } from "@/lib/api";
import { formatCurrencyPnl, formatCurrencyVolume, pnlColor } from "@/lib/formatters";
import { botPollingPolicy, botCountLabel, expireNativeBotPage, nativeBotQuote, observedFleetCounts, observedPnlColor } from "@/lib/bot-monitoring";
import { nativeCommandOutcome, nativeControlEligibility, awaitingNativeOwnerTransition, type NativeAction } from "@/lib/native-bot-controls";
import { sessionRevision } from '@/lib/auth-session';

function formatUptime(deployedAt: string | null): string {
  if (!deployedAt) return "—";
  try {
    const deployed = new Date(deployedAt);
    const now = new Date();
    const diffMs = now.getTime() - deployed.getTime();
    if (diffMs < 0) return "—";
    const days = Math.floor(diffMs / 86400000);
    const hours = Math.floor((diffMs % 86400000) / 3600000);
    if (days > 0) return `${days}d ${hours}h`;
    const mins = Math.floor((diffMs % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  } catch {
    return "—";
  }
}


// ── Sort types ──

type SortKey =
  | "controller_name"
  | "connector"
  | "trading_pair"
  | "realized_pnl_quote"
  | "unrealized_pnl_quote"
  | "global_pnl_quote"
  | "volume_traded"
  | "deployed_at"
  | "status";

type SortDir = "asc" | "desc";

function compareControllers(a: ControllerInfo, b: ControllerInfo, key: SortKey, dir: SortDir): number {
  let cmp = 0;
  switch (key) {
    case "controller_name":
    case "connector":
    case "trading_pair":
    case "status":
      cmp = (a[key] || "").localeCompare(b[key] || "");
      break;
    case "realized_pnl_quote":
    case "unrealized_pnl_quote":
    case "global_pnl_quote":
    case "volume_traded":
      if (a[key] === null) return b[key] === null ? 0 : 1;
      if (b[key] === null) return -1;
      cmp = a[key] - b[key];
      break;
    case "deployed_at": {
      const aTime = a.deployed_at ? new Date(a.deployed_at).getTime() : 0;
      const bTime = b.deployed_at ? new Date(b.deployed_at).getTime() : 0;
      cmp = aTime - bTime;
      break;
    }
  }
  return dir === "asc" ? cmp : -cmp;
}

// ── Stat Card ──

function StatCard({
  label,
  value,
  icon: Icon,
  valueColor,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  valueColor?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
        <span className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p
        className="text-xl font-bold tabular-nums"
        style={valueColor ? { color: valueColor } : {}}
      >
        {value}
      </p>
    </div>
  );
}

// ── Status Dot ──

function StatusDot({ status }: { status: string }) {
  const isStopping = status === "stopping";
  const color =
    status === "running"
      ? "text-[var(--color-green)]"
      : status === "stopped" || status === "error"
        ? "text-[var(--color-red)]"
        : "text-[var(--color-yellow)]";
  return isStopping ? (
    <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-[var(--color-yellow)] border-t-transparent" />
  ) : (
    <Circle className={`h-2 w-2 fill-current ${color}`} />
  );
}

// ── Sortable Header ──

function SortHeader({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right" | "center";
}) {
  const active = currentKey === sortKey;
  const alignCls =
    align === "right" ? "text-right justify-end" : align === "center" ? "text-center justify-center" : "text-left";

  return (
    <th
      className={`px-4 py-3 text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)] cursor-pointer select-none hover:text-[var(--color-text)] transition-colors ${alignCls}`}
      aria-sort={active ? currentDir === "asc" ? "ascending" : "descending" : "none"}
    >
      <button type="button" onClick={() => onSort(sortKey)} className={`flex w-full items-center gap-1 ${align === "right" ? "justify-end" : align === "center" ? "justify-center" : ""}`}>
        {label}
        {active ? (
          currentDir === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <span className="w-3" />
        )}
      </button>
    </th>
  );
}

function formatLogTime(ts?: number): string {
  if (!ts) return "";
  try {
    const d = new Date(ts * 1000);
    // UTC and labelled, like every other stamp on the Bots page; browser-local time would shift by the viewer's offset.
    return `${d.toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })} UTC`;
  } catch {
    return "";
  }
}

function LogsSection({ logs }: { logs: BotLogEntry[] }) {
  const [filter, setFilter] = useState<"all" | "error" | "general">("all");
  const filtered = filter === "all" ? logs : logs.filter((l) => l.log_category === filter);

  if (logs.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] py-2">No logs available</p>
    );
  }

  const errorCount = logs.filter((l) => l.log_category === "error").length;
  const generalCount = logs.filter((l) => l.log_category === "general").length;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        {(["all", "general", "error"] as const).map((f) => {
          const count = f === "all" ? logs.length : f === "error" ? errorCount : generalCount;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                filter === f
                  ? f === "error"
                    ? "bg-[var(--color-red)]/15 text-[var(--color-red)]"
                    : "bg-[var(--color-primary)]/15 text-[var(--color-primary)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {f} ({count})
            </button>
          );
        })}
      </div>
      <div className="max-h-[300px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] font-mono text-[11px] leading-relaxed">
        {filtered.map((log, i) => (
          <div
            key={i}
            className={`flex gap-2 px-2.5 py-1 border-b border-[var(--color-border)]/20 last:border-b-0 ${
              log.log_category === "error" ? "bg-[var(--color-red)]/5" : ""
            }`}
          >
            <span className="text-[var(--color-text-muted)] shrink-0 tabular-nums">
              {formatLogTime(log.timestamp)}
            </span>
            <span
              className={`break-all ${
                log.log_category === "error" ? "text-[var(--color-red)]" : "text-[var(--color-text)]"
              }`}
            >
              {log.msg || JSON.stringify(log)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Controller Row with actions ──

function ControllerRow({
  ctrl,
  server,
  isSelected,
  onSelect,
  formatPnlValue,
  formatValue,
  sparklineValues,
  isBotStopping,
}: {
  ctrl: ControllerInfo;
  server: string;
  isSelected: boolean;
  onSelect: () => void;
  formatPnlValue: (val: number | null, quote: string) => string;
  formatValue: (val: number | null, quote: string) => string;
  sparklineValues?: number[];
  isBotStopping?: boolean;
}) {
  const queryClient = useQueryClient();
  const { access } = useServerCapabilities();
  const isKilled = ctrl.config?.manual_kill_switch === true;
  const isStopping = ctrl.status === "stopping" || (isBotStopping && !isKilled);

  const toggleMutation = useMutation({
    mutationFn: () => {
      if (!access.controllerMutation) throw new Error("Controller controls are unavailable on this server");
      return isKilled
        ? api.startControllers(server, ctrl.bot_name, [ctrl.controller_id])
        : api.stopControllers(server, ctrl.bot_name, [ctrl.controller_id]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bots", server] });
    },
  });

  return (
    <tr
      className={`border-b border-[var(--color-border)]/30 hover:bg-[var(--color-surface-hover)]/50 cursor-pointer transition-colors ${isSelected ? "bg-[var(--color-surface-hover)]/70" : ""}`}
      onClick={onSelect}
    >
      <td className="px-4 py-2.5">
        <div className="flex flex-col">
          <button type="button" className="text-left text-sm font-medium" title={ctrl.controller_name} aria-label={`Open ${ctrl.trading_pair || ctrl.controller_name} controller details`} onClick={(event) => { event.stopPropagation(); onSelect(); }}>
            {ctrl.controller_name}
          </button>
          {ctrl.controller_id && ctrl.controller_id !== ctrl.controller_name && (
            <span className="text-xs text-[var(--color-text-muted)] font-mono truncate" title={ctrl.controller_id}>
              {ctrl.controller_id}
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-2.5 text-sm text-[var(--color-text-muted)]">
        {ctrl.connector || (access.native ? "Not reported" : "—")}
      </td>
      <td className="px-4 py-2.5 text-sm">{ctrl.trading_pair || "—"}</td>
      {(() => {
        const quote = ctrl.trading_pair?.split("-")[1] || "USDT";
        return (
          <>
            <td
              className="px-4 py-2.5 text-sm text-right tabular-nums font-medium"
              style={{ color: observedPnlColor(ctrl.realized_pnl_quote) }}
            >
              {formatPnlValue(ctrl.realized_pnl_quote, quote)}
            </td>
            <td
              className="px-4 py-2.5 text-sm text-right tabular-nums font-medium"
              style={{ color: observedPnlColor(ctrl.unrealized_pnl_quote) }}
            >
              {formatPnlValue(ctrl.unrealized_pnl_quote, quote)}
            </td>
            <td
              className="px-4 py-2.5 text-sm text-right tabular-nums font-medium"
              style={{ color: observedPnlColor(ctrl.global_pnl_quote) }}
            >
              {formatPnlValue(ctrl.global_pnl_quote, quote)}
            </td>
            <td className="px-2 py-2.5">
              <div className="flex justify-center">
                {sparklineValues && sparklineValues.length >= 2 ? (
                  <PnlSparkline values={sparklineValues} />
                ) : (
                  <span className="text-[10px] text-[var(--color-text-muted)]" title={access.native ? "The native source does not provide controller performance history" : undefined}>{access.native ? "No history" : "—"}</span>
                )}
              </div>
            </td>
            <td className="px-4 py-2.5 text-sm text-right tabular-nums text-[var(--color-text-muted)]">
              {formatValue(ctrl.volume_traded, quote)}
            </td>
          </>
        );
      })()}
      <td className="px-4 py-2.5 text-sm text-right tabular-nums text-[var(--color-text-muted)]">
        {access.native && !ctrl.deployed_at ? <span title="The native source does not provide a deployment timestamp">Not reported</span> : formatUptime(ctrl.deployed_at)}
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-1.5 justify-center">
          <StatusDot status={isKilled ? "control_requested" : isStopping ? "stopping" : ctrl.status} />
        </div>
      </td>
      <td className="px-4 py-2.5">
        <div className="flex flex-col items-center justify-center" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => toggleMutation.mutate()}
            disabled={!access.controllerMutation || toggleMutation.isPending || isStopping}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
              isStopping
                ? "text-[var(--color-yellow)]"
                : isKilled
                  ? "text-[var(--color-green)] hover:bg-[var(--color-green)]/10"
                  : "text-[var(--color-yellow)] hover:bg-[var(--color-yellow)]/10"
            }`}
            title={
              !access.controllerMutation ? "Controller controls are unavailable on this server" : toggleMutation.isError
                ? `Failed to ${isKilled ? "clear" : "set"} controller kill switch: ${toggleMutation.error instanceof Error ? toggleMutation.error.message : "Unknown error"}`
                : isStopping
                  ? "Stopping..."
                  : isKilled
                    ? "Clear controller kill switch"
                    : "Set controller kill switch"
            }
          >
            {toggleMutation.isPending || isStopping ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : isKilled ? (
              <Play className="h-3.5 w-3.5" />
            ) : (
              <Pause className="h-3.5 w-3.5" />
            )}
          </button>
          {toggleMutation.isError && (
            <span
              className="text-[10px] text-[var(--color-red)] whitespace-nowrap"
              title={toggleMutation.error instanceof Error ? toggleMutation.error.message : "Unknown error"}
            >
              Failed to {isKilled ? "clear" : "set"} switch
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Bots Collapsible Section ──

function NativeBotControls({server,botName}: {server:string;botName:string}) {
  const {access,data:capabilities}=useServerCapabilities();
  const queryClient=useQueryClient();
  const [now,setNow]=useState(Date.now);
  const [confirmation,setConfirmation]=useState<NativeAction|null>(null);
  const [authRevision]=useState(sessionRevision);
  type Submitted = {bootId:string;sequence:number;action:NativeAction}|null;
  type Receipt = {state:'verified'|'rejected'|'unknown';message:string}|null;
  type CommandSession = {submitted:Submitted;receipt:Receipt;requestId?:string;pending?:boolean};
  type CommandRequest = {action:NativeAction;requestId:string};
  const sessionKey=['native-control-session',server,botName];
  const session=useQuery<CommandSession>({queryKey:sessionKey,queryFn:skipToken,enabled:false,gcTime:Infinity});
  const submitted=session.data?.submitted ?? null;
  const receipt=session.data?.receipt ?? null;
  // Keep unknown/pending outcomes across owner navigation. Auth changes clear the query cache.
  const settleCommand=(requestId:string, outcome:NonNullable<Receipt>)=>{
    if(authRevision!==sessionRevision())return;
    queryClient.setQueryData<CommandSession>(sessionKey,prior=>
      prior?.requestId===requestId ? {...prior,pending:false,receipt:outcome,submitted:outcome.state==='rejected'?null:prior.submitted} : prior);
  };
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return ()=>window.clearInterval(timer);},[]);
  const status=useQuery({queryKey:['native-bot-status',server,botName],queryFn:()=>api.getNativeBotStatus(server,botName),refetchInterval:5000,staleTime:0,retry:false});
  const allowedStart=capabilities?.capabilities?.native_start===true;
  const eligibility=nativeControlEligibility(status.isError?undefined:status.data,botName,access.botStop,allowedStart,now);
  const waitingForOwner=awaitingNativeOwnerTransition(submitted,eligibility);
  const mutation=useMutation({
    retry:false,
    mutationFn:async({action,requestId}:CommandRequest)=>{
      if(authRevision!==sessionRevision())throw new Error('Authentication session changed.');
      const current=nativeControlEligibility(status.isError?undefined:status.data,botName,access.botStop,allowedStart,Date.now());
      const expected={botName,action,bootId:current.bootId,instanceId:current.instanceId};
      const prior=queryClient.getQueryData<CommandSession>(sessionKey);
      if (!current.allowed || current.action!==action || prior?.pending || awaitingNativeOwnerTransition(prior?.submitted??null,current)) return {result:{httpStatus:409,body:{detail:current.reason || 'Await fresh owner telemetry before requesting another transition.'}},expected};
      queryClient.setQueryData<CommandSession>(sessionKey,{submitted:{bootId:current.bootId,sequence:current.sequence,action},receipt:null,requestId,pending:true});
      const result=await api.nativeBotCommand(server,botName,action);
      return {result,expected};
    },
    onSuccess:({result,expected},{requestId})=>{
      const outcome=nativeCommandOutcome(result,expected);
      settleCommand(requestId,outcome);
      setConfirmation(null);
    },
    onError:(_error,{requestId})=>{
      settleCommand(requestId,{state:'unknown',message:'No verified command outcome was received. Await a fresh owner state transition before retrying.'});
      setConfirmation(null);
    },
    onSettled:()=>{
      if(authRevision!==sessionRevision())return;
      queryClient.invalidateQueries({queryKey:['native-bot-status',server,botName]});
      queryClient.invalidateQueries({queryKey:['bots',server]});
    },
  });
  const pending=mutation.isPending || session.data?.pending===true;
  const disabled=!eligibility.allowed || pending || waitingForOwner;
  const reason=status.isError?'Native status is unavailable. Controls require fresh owner evidence.':waitingForOwner?'Awaiting a fresh owner state transition.':eligibility.reason;
  const action=eligibility.action;
  return <div className="flex max-w-sm flex-col items-end gap-1" onClick={event=>event.stopPropagation()}>
    {confirmation ? <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-xs text-[var(--color-text-muted)]">{confirmation==='start'?'Start the registered configuration?':'Stop and reconcile this native strategy?'}</span>
      <button type="button" disabled={disabled||confirmation!==action} onClick={()=>mutation.mutate({action:confirmation,requestId:crypto.randomUUID()})} className="rounded bg-[var(--color-primary)] px-3 py-2 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40">{pending?'Awaiting owner…':`Confirm ${confirmation}`}</button>
      <button type="button" disabled={pending} onClick={()=>setConfirmation(null)} className="px-2 py-2 text-xs text-[var(--color-text-muted)] disabled:opacity-40">Cancel</button>
    </div> : <button type="button" disabled={disabled||!action} onClick={()=>action&&setConfirmation(action)} title={reason || `${action==='start'?'Start':'Stop'} native strategy using its registered configuration`} className="flex items-center gap-1 rounded px-3 py-2 text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 disabled:opacity-40">
      {action==='start'?<Play className="h-3.5 w-3.5"/>:<Square className="h-3.5 w-3.5"/>}
      {pending?'Awaiting owner…':action==='start'?'Start native':action==='stop'?'Stop native':'Lifecycle unavailable'}
    </button>}
    {reason&&<span role="status" className="max-w-xs text-right text-xs text-[var(--color-text-muted)]">{reason}</span>}
    {receipt&&<span role="status" className={`max-w-xs text-right text-xs ${receipt.state==='verified'?'text-[var(--color-green)]':receipt.state==='rejected'?'text-[var(--color-red)]':'text-[var(--color-yellow)]'}`}>{receipt.state==='unknown'&&submitted&&!waitingForOwner?`The command acknowledgement was unavailable. Fresh owner telemetry now reports ${eligibility.state}.`:receipt.message}</span>}
  </div>;
}

function BotRow({ bot, server, onStopInitiated, onStopSettled }: { bot: BotSummary; server: string; onStopInitiated?: (botName: string) => void; onStopSettled?: (botName: string) => void }) {
  const { access } = useServerCapabilities();
  const [showLogs, setShowLogs] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const queryClient = useQueryClient();
  const isStopping = bot.status === "stopping";

  const stopMutation = useMutation({
    mutationFn: () => {
      if (access.native) throw new Error("Native bots require the dedicated lifecycle control endpoint");
      if (!access.botStop) throw new Error("Bot controls are unavailable on this server");
      onStopInitiated?.(bot.bot_name);
      return api.stopBot(server, bot.bot_name);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bots", server] });
      setConfirmStop(false);
    },
    onSettled: () => {
      onStopSettled?.(bot.bot_name);
    },
  });

  const allLogs: BotLogEntry[] = useMemo(() => {
    return [
      ...(bot.error_logs || []).map((l) => ({ ...l, log_category: "error" as const })),
      ...(bot.general_logs || []).map((l) => ({ ...l, log_category: "general" as const })),
    ].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }, [bot.error_logs, bot.general_logs]);

  return (
    <div>
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-sm cursor-pointer hover:bg-[var(--color-surface-hover)]/50 transition-colors"
        onClick={() => setShowLogs(!showLogs)}
      >
        <button type="button" className="p-0.5" aria-label={`Logs for ${bot.bot_name}`} aria-expanded={showLogs} onClick={(event) => { event.stopPropagation(); setShowLogs(!showLogs); }}>
          {showLogs ? (
            <ChevronDown className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
          )}
        </button>
        <StatusDot status={bot.status} />
        <span
          className="font-medium truncate max-w-[250px]"
          title={bot.bot_name}
        >
          {bot.bot_name}
        </span>
        <span className="text-[var(--color-text-muted)]">
          {access.native && bot.controller_count_current !== true ? "Controllers UNAVAILABLE" : `${botCountLabel(bot.num_controllers, access.native, bot.controller_count_current === true)} controller${bot.num_controllers !== 1 ? "s" : ""}`}
        </span>
        {bot.error_count > 0 && (
          <span className="text-[var(--color-yellow)] text-xs">
            {bot.error_count} error{bot.error_count !== 1 ? "s" : ""}
          </span>
        )}
        <span className="ml-auto text-[var(--color-text-muted)] tabular-nums">
          {formatUptime(bot.deployed_at)}
        </span>
        {access.native ? <NativeBotControls key={`${server}:${bot.bot_name}`} server={server} botName={bot.bot_name}/> : isStopping ? (
            <div className="flex items-center gap-1.5 text-[var(--color-yellow)]" onClick={(e) => e.stopPropagation()}>
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span className="text-xs font-medium">Stopping</span>
            </div>
          ) : confirmStop ? (
            <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => stopMutation.mutate()}
                disabled={!access.botStop || stopMutation.isPending}
                className="rounded px-2 py-1 text-xs font-medium bg-[var(--color-red)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {stopMutation.isPending ? "Stopping..." : "Confirm"}
              </button>
              <button
                onClick={() => setConfirmStop(false)}
                className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              disabled={!access.botStop}
              onClick={(e) => { e.stopPropagation(); setConfirmStop(true); }}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-red)] hover:bg-[var(--color-red)]/10 transition-colors disabled:opacity-40"
              title={access.botStop ? "Stop bot" : "Bot controls are unavailable on this server"}
            >
              <Square className="h-3 w-3" />
              Stop
            </button>
          )}
      </div>
      {showLogs && (
        <div className="px-4 pb-3 pt-1">
          <LogsSection logs={allLogs} />
        </div>
      )}
      {stopMutation.isError && (
        <div className="px-4 py-2 text-xs text-[var(--color-red)]">
          Failed to stop bot: {stopMutation.error instanceof Error ? stopMutation.error.message : "Unknown error"}
        </div>
      )}
    </div>
  );
}

function BotsSection({ bots, server, onStopInitiated, onStopSettled }: { bots: BotSummary[]; server: string; onStopInitiated?: (botName: string) => void; onStopSettled?: (botName: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-[var(--color-surface-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Chevron className="h-4 w-4 text-[var(--color-text-muted)]" />
        <span className="font-medium">Bots</span>
        <span className="text-sm text-[var(--color-text-muted)]">({bots.length})</span>
      </button>
      {expanded && (
        <div className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]/30">
          {bots.map((bot) => (
            <BotRow key={bot.bot_name} bot={bot} server={server} onStopInitiated={onStopInitiated} onStopSettled={onStopSettled} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──

const PAPER_SECTIONS = {
  wallet: "fleet/summary", positions: "fleet/holdings", fills: "fleet/fills?limit=100",
  executors: "executors", risk: "risk", decisions: "decisions",
  history: "controller-performance/history?interval=5m&limit=1000",
} as const;

type PaperRow = Record<string, unknown>;
const paperObject = (value: unknown): PaperRow => value && typeof value === "object" && !Array.isArray(value) ? value as PaperRow : {};
type PaperChartsProps = { bot: string; server: string; observations: PaperRead[] };
function CollectingPaperCharts() {
  return <div className="paper-chart-collecting"><PaperBadge state="collecting">Collecting</PaperBadge><h3>Closed one-minute price series</h3><p>Waiting for the bounded paper candle export and its chart binding. Fill and executor records remain available below. Empty charts are not zero trades.</p></div>;
}
const PaperStrategyCharts = lazy<ComponentType<PaperChartsProps>>(async () => {
  const workspace = await import("@workspace-monitoring") as { PaperStrategyCharts?: ComponentType<PaperChartsProps> };
  return { default: workspace.PaperStrategyCharts ?? CollectingPaperCharts };
});

function PaperBadge({ children, state }: { children: React.ReactNode; state?: string }) {
  return <span className="paper-badge" data-state={state}>{children}</span>;
}

function PaperMetric({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return <div className="paper-metric"><dt>{label}</dt><dd>{value}</dd>{note && <small>{note}</small>}</div>;
}

function PaperRecords({ read, now, kind }: { read?: PaperRead; now: number; kind: "fills" | "executors" | "positions" }) {
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState(false);
  const completeRows = paperCompleteRecords(read, now);
  const rows = completeRows ?? [];
  const idKey = kind === "fills" ? "trade_id" : kind === "positions" ? "position_id" : "executor_id";
  const unit = (row: PaperRow) => typeof row.unit === "string" ? row.unit : "USDC";
  const base = (row: PaperRow) => String(row.trading_pair ?? "").split("-")[0] || "base units";
  const columns: TableColumn<PaperRow>[] = [
    { id: "id", header: kind === "fills" ? "Fill ID" : kind === "positions" ? "Position ID" : "Executor ID", value: row => String(row[idKey] ?? "Not published"), size: 180, cell: row => <button className="paper-copy" onClick={() => { const id = String(row[idKey] ?? ""); void navigator.clipboard.writeText(id).then(() => { setCopied(id); setCopyError(false); }, () => setCopyError(true)); }} title="Copy full owner ID">{copied === row[idKey] ? "Copied" : String(row[idKey] ?? "Not published")}</button> },
    { id: "pair", header: "Pair", value: row => String(row.trading_pair ?? "Not published"), size: 130 },
    { id: "state", header: kind === "fills" ? "Side" : "State", value: row => paperWords(row.side ?? row.state), size: 150 },
    { id: "quantity", header: kind === "executors" ? "Remaining close" : "Quantity", value: row => paperAmount(kind === "executors" ? row.remaining_close_quantity : row.quantity, base(row), 6), size: 180 },
    ...(kind === "fills" ? [
      { id: "price", header: "Fill price", value: (row: PaperRow) => paperAmount(row.price, "USDC"), size: 160 },
      { id: "fee", header: "Fee", value: (row: PaperRow) => paperAmount(row.fee_amount, String(row.fee_currency ?? "unit not published")), size: 160 },
      { id: "time", header: "Filled at · UTC", value: (row: PaperRow) => paperTime(row.event_at_ms, now), size: 330 },
    ] : [{ id: "basis", header: "Remaining basis", value: (row: PaperRow) => paperAmount(row.remaining_basis_quote, unit(row)), size: 175 }]),
    ...(kind === "executors" ? [
      { id: "realized", header: "Realized PnL", value: (row: PaperRow) => paperAmount(row.realized_pnl_quote, unit(row), 6), size: 180 },
      { id: "unrealized", header: "Unrealized PnL", value: (row: PaperRow) => paperAmount(row.unrealized_pnl_quote, unit(row), 6), size: 180 },
      { id: "closed", header: "Closed at · UTC", value: (row: PaperRow) => paperTime(row.close_at_ms, now), size: 330 },
    ] : []),
    { id: "detail", header: "Owner detail", value: row => String(row.executor_id ?? ""), size: 340, wrap: true, cell: row => <details><summary>Expand record</summary><dl className="paper-detail"><dt>Executor</dt><dd>{String(row.executor_id ?? "Not published")}</dd><dt>Controller</dt><dd>{String(row.controller_id ?? "Not published")}</dd>{kind === "positions" && <><dt>Protected exit</dt><dd>{paperWords(row.protected_exit)}</dd></>}{kind === "executors" && <><dt>Terminal receipt</dt><dd>{paperWords(row.terminal)}</dd><dt>Close reason</dt><dd>{paperWords(row.close_type)}</dd><dt>Exact owner values</dt><dd>No rounding</dd><dt>Remaining basis</dt><dd>{paperExactAmount(row.remaining_basis_quote, unit(row))}</dd><dt>Remaining close</dt><dd>{paperExactAmount(row.remaining_close_quantity, base(row))}</dd><dt>Residual inventory</dt><dd>{paperExactAmount(row.quantity, base(row))}</dd><dt>Realized PnL</dt><dd>{paperExactAmount(row.realized_pnl_quote, unit(row))}</dd><dt>Unrealized PnL</dt><dd>{paperExactAmount(row.unrealized_pnl_quote, unit(row))}</dd><dt>Fees paid</dt><dd>{paperExactAmount(row.cum_fees_quote, unit(row))}</dd></>}</dl></details> },
  ];
  return <section className="paper-section"><div className="paper-section-heading"><h2>{kind === "positions" ? "Holdings" : kind === "fills" ? "Recent fills" : "Executors"}</h2><PaperBadge state={read ? paperReadState(read, now) : "collecting"}>{paperWords(read ? paperReadState(read, now) : "collecting")}</PaperBadge></div><p className="paper-caption">{paperTime(read?.generated_at_ms, now)} · Bounded owner records, not lifetime totals. Search, filter or resize columns.</p>{read?.reason && <p className="paper-caption">{paperWords(read.reason)}</p>}{completeRows === null ? <p className="paper-caption">Incomplete or stale owner read. Record counts and totals are not published.</p> : <DataTable rows={rows} columns={columns} rowId={(row, index) => String(row[idKey] ?? index)} label={`Paper ${kind}`} pageSize={8} emptyText={read?.data == null ? "Owner records are not available in this snapshot." : "No records in this owner snapshot."} maxHeight={360} exportName={`paper-${kind}`} />}{read?.next_cursor && <p className="paper-caption">More records exist beyond this page; totals must not be inferred from these rows.</p>}{copyError && <p role="alert">Copy was unavailable. Select the owner ID to copy it manually.</p>}</section>;
}

class PaperSectionBoundary extends Component<{ name: string; resetKey: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? <section className="v5-error-panel" role="alert">{this.props.name} could not be rendered. Other owner sections remain available.</section> : this.props.children;
  }
}

function PaperSectionContent({ render }: { render: () => ReactNode }) { return render(); }

function PaperIsolatedSection({ name, resetKey, render }: { name: string; resetKey: string; render: () => ReactNode }) {
  return <PaperSectionBoundary name={name} resetKey={resetKey}><PaperSectionContent render={render} /></PaperSectionBoundary>;
}

export function PaperWorkspace({ reads, accountingRead, accountingError = false, now, reportAt, heartbeat, bot }: { reads: PaperRead[]; accountingRead?: PaperRead; accountingError?: boolean; now: number; reportAt: number | null; heartbeat: string; bot: string }) {
  const errors = reads.map(read => paperSectionError(read) ?? (typeof read.reason === "string" && read.reason.includes("schema invalid") ? read.reason : null)).filter(Boolean);
  reads = reads.map(read => paperSectionError(read) ? { schema: "rsibot.v5-paper.read.v1", section: typeof read.section === "string" ? read.section : "unknown", state: "degraded", execution_mode: "paper", simulated: true, bot_id: null, snapshot_id: null, generated_at_ms: null, data: null, reason: paperSectionError(read), completeness: "unavailable" } : read);
  const bySection = Object.fromEntries(reads.map(read => [read.section, read]));
  const resetKey = reads.map(read => `${read.section}:${read.snapshot_id}:${read.state}`).join("|");
  const wallet = paperObject(bySection.wallet?.data);
  const walletTotals = paperWalletTotals(bySection.wallet, now);
  const inventory = paperWalletInventory(bySection.wallet, now);
  const accounting = paperLifetimeTotals(accountingRead, reads[0], now);
  const accountingState = accountingRead ? paperReadState(accountingRead, now) : "collecting";
  const accountingNote = accounting ? "Lifetime · native receipts" : accountingError ? "Lifetime · owner read unavailable" : accountingState === "stale" ? "Lifetime · owner snapshot is stale" : accountingState === "degraded" ? "Lifetime · owner totals are incomplete" : "Lifetime · awaiting coherent owner totals";
  const openExecutors = paperOpenExecutorCount(bySection.executors, now);
  const decisions = paperObject(bySection.decisions?.data);
  const risk = paperObject(bySection.risk?.data);
  const rails = paperRiskUsage(bySection.risk, now) ?? [];
  const hold = paperRiskHold(bySection.risk);
  const holds = paperRiskHolds(bySection.risk);
  return <>
    {errors.map(error => <section className="v5-error-panel" role="alert" key={error}>{error}</section>)}
    {hold && <PaperIsolatedSection name="Entry hold" resetKey={resetKey} render={() => <aside className="paper-fleet" role="status"><div className="paper-section-heading"><h2>New acquisitions held</h2><PaperBadge state="degraded">Owner maintenance required</PaperBadge></div><div className="paper-rails">{holds.map(item => <article key={item.reason}><h3>{paperWords(item.reason)}</h3><p>{item.explanation}</p><p className="paper-caption">{item.action}</p></article>)}</div><p className="paper-caption">{paperWords(risk.control_hold)}. Clock high-water mark: {paperTime(paperObject(risk.clock_recovery).high_water_ms, now)}. Protective exits: {paperWords(risk.protected_exits)}.</p></aside>} /> }
    <PaperIsolatedSection name="Paper fleet" resetKey={resetKey} render={() => <section className="paper-fleet"><div className="paper-section-heading"><div><span className="paper-eyebrow">SIMULATED ACCOUNT</span><h2>Paper fleet</h2></div><PaperBadge state={heartbeat === "Fresh" ? "available" : "stale"}>{heartbeat} · heartbeat</PaperBadge></div><p className="paper-caption">{bot} · Valuation: {paperWords(wallet.valuation_policy)}. Book freshness and completeness are separate from process heartbeat.</p><dl className="paper-metrics">
      <PaperMetric label="Wallet equity" value={paperAmount(walletTotals?.equity, "USDC")} note={walletTotals ? "Fresh complete owner wallet" : "Fresh complete wallet required"} />
      <PaperMetric label="Available cash" value={paperAmount(walletTotals?.cash, "USDC")} />
      <PaperMetric label="Holdings value" value={inventory ? paperAmount(inventory.value, inventory.unit, 2) : "Not published"} note={inventory ? `${paperReadState(bySection.wallet, now) === "stale" ? "Stale valuation · " : ""}Valuation: ${inventory.basis} · As of ${paperTime(inventory.asOf, now)} · Wallet marks, excluding cash` : "Complete current wallet marks not published"} />
      <PaperMetric label="Open executors" value={openExecutors ?? "Not published"} note={openExecutors === null ? "Incomplete or stale owner read · count not inferred" : "Fresh complete owner snapshot · excludes terminal receipts"} />
      <PaperMetric label="Realized PnL" value={paperAmount(accounting?.realized_pnl_quote, "USDC")} note={accountingNote} />
      <PaperMetric label="Unrealized PnL" value={paperAmount(accounting?.unrealized_pnl_quote, "USDC")} note={accountingNote} />
      <PaperMetric label="Fees paid" value={paperAmount(accounting?.fees_paid_quote, "USDC")} note={accountingNote} />
      <PaperMetric label="Traded volume" value={paperAmount(accounting?.volume_traded_quote, "USDC")} note={accountingNote} />
      <PaperMetric label="Last report" value={paperTime(reportAt, now)} note="Native process heartbeat" />
    </dl><p className="paper-caption">{accounting ? <>Filled orders: {paperOrderCount(accounting.entry_count, "entry")} · {paperOrderCount(accounting.exit_count, "exit")}. Accounting since: {paperTime(accounting.accounting_since_ms, now)}. Counts are distinct filled orders, not actions.</> : <>Lifetime accounting: {accountingError ? "Owner read unavailable; no totals are inferred from recent fills." : paperWords(accountingRead?.reason ?? "Collecting the snapshot-bound owner aggregate; no totals are inferred from recent fills.")}</>}</p></section>} />
    <PaperIsolatedSection name="Pair workspace" resetKey={resetKey} render={() => <section className="paper-section"><div className="paper-section-heading"><h2>Pair workspace</h2><span className="paper-caption">5 pairs · same fixed-target recipe</span></div><div className="paper-pairs">{["BNB-USDC", "BTC-USDC", "ETH-USDC", "SOL-USDC", "XRP-USDC"].map(pair => {
      const { position, executor, knownFlat, lastReportedFlat, decision } = paperPairObservation(pair, bySection.positions, bySection.executors, bySection.decisions, now);
      const exit = paperExitProjection(position, executor);
      const pairStates = [paperReadState(bySection.positions, now), paperReadState(bySection.executors, now)];
      const pairState = pairStates.includes("stale") ? "stale" : pairStates.every(state => state === "available") ? "available" : "degraded";
      return <article className="paper-pair" key={pair}><div className="paper-section-heading"><h3>{pair}</h3><PaperBadge state={pairState}>{pairState === "stale" ? "Stale · " : pairState === "degraded" ? "Incomplete · " : ""}{position ? paperWords(position.state) : knownFlat ? "No position" : lastReportedFlat ? "No position in last report" : executor ? paperWords(executor.state) : "Not published"}</PaperBadge></div><p className="paper-caption">As of {paperTime(bySection.positions?.source_at_ms ?? bySection.positions?.generated_at_ms, now)}</p>{knownFlat ? <p className="paper-caption">No position · waiting for entry signal</p> : lastReportedFlat ? <p className="paper-caption">No position in last report · stale since {paperTime(Math.min(bySection.positions!.generated_at_ms!, bySection.executors!.generated_at_ms!) + 30_000, now)}</p> : <dl className="paper-detail"><dt>Position</dt><dd>{position ? paperAmount(position.quantity, pair.split("-")[0], 6) : "Not published"}</dd><dt>Target price</dt><dd>{exit.targetPrice != null ? <>{paperAmount(exit.targetPrice, "USDC")}<span className="paper-caption" style={{ display: "block" }}>{exit.basis}</span></> : exit.reason}</dd><dt>Exit progress</dt><dd>{exit.order ? <>{paperWords(exit.order.state)} · {paperExactAmount(exit.remainingAmount, pair.split("-")[0])} remaining<span className="paper-caption" style={{ display: "block" }}>Order {String(exit.order.order_id ?? "pending")} · LIMIT {paperExactAmount(exit.order.price, "USDC")}<br />Placed {paperTime(exit.order.placed_at_ms, now)}</span></> : "Owner protected exit order not published"}</dd><dt>Protected exit</dt><dd>{paperWords(position?.protected_exit)}</dd></dl>}{decision && <p className="paper-caption">Latest decision: {paperWords(decision.status)}{decision.reason ? ` · ${paperWords(decision.reason)}` : ""}{decision.event_at_ms != null ? ` · ${paperTime(decision.event_at_ms, now)}` : ""}</p>}</article>;
    })}</div></section>} />
    <PaperIsolatedSection name="Pair charts" resetKey={resetKey} render={() => <section className="paper-section" id={`paper-charts-${bot}`} aria-label="Paper strategy charts"><div className="paper-section-heading"><h2>Pair charts</h2><span className="paper-caption">Native closed candles only · no inferred prices</span></div><Suspense fallback={<p role="status">Loading paper chart workspace…</p>}><PaperStrategyCharts bot={bot} server="rsibot-v5" observations={reads} /></Suspense></section>} />
    <PaperIsolatedSection name="Positions" resetKey={resetKey} render={() => <PaperRecords read={bySection.positions} kind="positions" now={now} />} />
    <PaperIsolatedSection name="Fills" resetKey={resetKey} render={() => <PaperRecords read={bySection.fills} kind="fills" now={now} />} />
    <PaperIsolatedSection name="Executors" resetKey={resetKey} render={() => <PaperRecords read={bySection.executors} kind="executors" now={now} />} />
    <PaperIsolatedSection name="Risk rails" resetKey={resetKey} render={() => <section className="paper-section"><div className="paper-section-heading"><h2>Risk rails & entry latch</h2><PaperBadge state="degraded">{paperWords(bySection.risk?.state ?? "collecting")}</PaperBadge></div><p className="paper-caption">{paperWords(bySection.risk?.reason ?? "controls_not_integrated")}. Loss rails stop new acquisitions, never force a sale.</p><div className="paper-rails">{rails.length ? rails.map((rail, index) => <article className="paper-pair" key={index}><h3>{paperWords(rail.label)}</h3><p>{paperAmount(rail.used_quote, "USDC")} of {paperAmount(rail.limit_quote, "USDC")}</p>{typeof rail.used_percent === "number" && Number.isFinite(rail.used_percent) && rail.used_percent >= 0 && rail.used_percent <= 100 ? <progress max={100} value={rail.used_percent} aria-label={`${paperWords(rail.label)} use`} /> : <p className="paper-caption">Use not published</p>}</article>) : ["Pair exposure", "Program exposure", "New acquisitions"].map(label => <article className="paper-pair" key={label}><h3>{label}</h3><PaperBadge>{hold && label === "New acquisitions" ? "Held by owner" : "Not connected"}</PaperBadge><div className="paper-empty-rail" aria-hidden="true" /><p className="paper-caption">{hold && label === "New acquisitions" ? "See the owner clearing action above. Protective exits remain enabled." : "No owner limit or latch observation. No use bar is inferred."}</p></article>)}</div></section>} />
    <PaperIsolatedSection name="Decisions and paper control" resetKey={resetKey} render={() => <section className="paper-section"><h2>Decisions & paper control</h2><div className="paper-rails"><article><h3>Exit policy</h3><p>{paperWords(paperObject(decisions.trailing).reason)}</p><p>Underwater positions remain held. Protective exits must survive entry halt.</p></article><article><h3>Acquisition plan</h3><p>{paperWords(paperObject(decisions.dca).reason)}</p><p>Comparable history: {paperWords(paperObject(bySection.history?.data).reason)}</p></article><article><h3>{paperControlState(null)}</h3><p>Read-only dashboard. A separately authenticated owner path must acknowledge paper commands before controls can appear here.</p></article></div><details className="paper-provenance"><summary>Observation provenance</summary><p>Snapshot: {reads[0]?.snapshot_id ?? "Not published"}</p><p>Observed: {paperTime(reads[0]?.generated_at_ms, now)}</p></details></section>} />
  </>;
}

async function readPaper(path: string, section: string): Promise<PaperRead> {
  const response = await fetch(`/api/v5/dashboard/read?${new URLSearchParams({ path })}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 502 && body?.detail?.reason === "schema_invalid" && typeof body.detail.section === "string") throw new PaperSectionSchemaError(body.detail.section);
    throw new Error(response.status === 409 ? "The owner snapshot changed. Refresh to read a coherent snapshot." : response.status === 401 ? "Your workspace session expired. Sign in again." : `Paper read failed (${response.status}). Check the observation service; no empty wallet is substituted.`);
  }
  const value = await response.json() as PaperRead;
  if (!value || value.section !== section || paperSectionError(value)) throw new PaperSectionSchemaError(section);
  return value;
}

class PaperSectionSchemaError extends Error {
  section: string;
  constructor(section: string) { super(`${paperWords(section)} owner schema invalid; this section is unavailable.`); this.section = section; }
}

export function V5PaperBots({ bot, generatedAt, ownerState }: { bot: string; generatedAt: number | null; ownerState: string }) {
  const [layout, setLayout] = useState<"grid" | "compact">("grid");
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const query = useQuery({
    queryKey: ["v5-paper-bots", bot], retry: false, refetchInterval: 15_000,
    queryFn: async () => {
      const prefix = `/api/v1/servers/rsibot-v5/`;
      const status = await readPaper(`${prefix}bots/${encodeURIComponent(bot)}/native/status`, "status");
      const sections = await Promise.all(Object.entries(PAPER_SECTIONS).map(async ([section, suffix]) => {
        const path = ["executors", "risk", "decisions"].includes(section) ? `${prefix}bots/${encodeURIComponent(bot)}/${suffix}` : `${prefix}${suffix}`;
        const snapshot = status.snapshot_id ? `${path.includes("?") ? "&" : "?"}snapshot_id=${encodeURIComponent(status.snapshot_id)}` : "";
        try { return await readPaper(path + snapshot, section); }
        catch (error) {
          if (!(error instanceof PaperSectionSchemaError) || error.section !== section) throw error;
          return { ...status, section, state: "degraded" as const, reason: error.message, data: null, completeness: "unavailable" };
        }
      }));
      if (status.snapshot_id && !paperSnapshotsAgree([status, ...sections])) throw new Error("Mixed owner snapshots were refused. Refresh; totals are not combined.");
      return [...sections, status];
    },
  });
  const snapshot = query.data?.[0];
  const accounting = useQuery({
    queryKey: ["v5-paper-accounting", bot, snapshot?.snapshot_id], enabled: Boolean(snapshot?.snapshot_id), retry: false,
    queryFn: () => readPaper(`/api/v1/servers/rsibot-v5/fleet/accounting?snapshot_id=${encodeURIComponent(snapshot!.snapshot_id!)}`, "accounting"),
  });
  const clock = paperHeartbeat(generatedAt === null ? null : Math.floor(generatedAt * 1000), ownerState, now);
  const heartbeat = clock.current ? "Fresh" : ownerState === "UNAVAILABLE" ? "Unavailable" : "Stale";
  return <div className="v5-paper-bots" data-layout={layout}>
    <header className="v5-page-heading"><div><h1>Paper bots</h1><p>{bot} · simulated wallet · live disabled</p></div><div className="v5-button-row"><button className="v5-button" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}>Grid</button><button className="v5-button" aria-pressed={layout === "compact"} onClick={() => setLayout("compact")}>Compact</button><button className="v5-button" onClick={() => void query.refetch()}>Refresh paper data</button></div></header>
    {query.isPending && <p role="status">Reading bounded native paper observations…</p>}
    {query.isError && <section className="v5-error-panel" role="alert">{query.error.message}</section>}
    {query.data && <PaperWorkspace reads={query.data} accountingRead={accounting.data} accountingError={accounting.isError} now={now} reportAt={generatedAt === null ? null : Math.floor(generatedAt * 1000)} heartbeat={heartbeat} bot={bot} />}
  </div>;
}

export function ActiveBotsTab({ allowDrafts = true, ownerUnavailableReason }: { allowDrafts?: boolean; ownerUnavailableReason?: string } = {}) {
  const { server } = useServer();
  const { access } = useServerCapabilities();
  const polling = botPollingPolicy(access.native);
  const [observationClock,setObservationClock]=useState(Date.now);
  useEffect(()=>{if(!access.native)return;const timer=window.setInterval(()=>setObservationClock(Date.now()),1000);return()=>window.clearInterval(timer);},[access.native]);
  const [sortKey, setSortKey] = useState<SortKey>("global_pnl_quote");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showDeploy, setShowDeploy] = useState(false);
  const [pendingStopBots, setPendingStopBots] = useState<Set<string>>(new Set());

  const onStopInitiated = useCallback((botName: string) => {
    setPendingStopBots((prev) => new Set(prev).add(botName));
  }, []);
  const onStopSettled = useCallback((botName: string) => {
    setPendingStopBots((prev) => {
      const next = new Set(prev);
      next.delete(botName);
      return next;
    });
  }, []);

  // Subscribe to real-time bots updates via WS
  useCondorWebSocket(polling.channels, server);

  const { data: rawData, isLoading, error } = useQuery({
    queryKey: ["bots", server],
    queryFn: () => api.getBots(server!),
    enabled: !!server,
    refetchInterval: polling.interval,
  });
  const data=useMemo(()=>expireNativeBotPage(rawData,access.native,observationClock),[rawData,access.native,observationClock]);

  // Compute earliest deploy time from active bots for filtering perf history
  const earliestDeploy = useMemo(() => {
    if (!data?.bots?.length) return undefined;
    let earliest: number | undefined;
    for (const bot of data.bots) {
      if (bot.deployed_at) {
        const ms = Date.parse(bot.deployed_at);
        if (!isNaN(ms) && (earliest === undefined || ms < earliest)) earliest = ms;
      }
    }
    return earliest ? new Date(earliest).toISOString() : undefined;
  }, [data?.bots]);

  // Fetch performance history for sparklines (all controllers at once)
  const { data: perfHistory } = useQuery({
    queryKey: ["controller-perf-history-all", server, earliestDeploy],
    queryFn: () =>
      api.getControllerPerformanceHistory(server!, {
        interval: "5m",
        limit: 1000,
        start_time: earliestDeploy,
      }),
    enabled: !!server && polling.controllerHistory && (data?.controllers?.length ?? 0) > 0,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const bots = useMemo(() => data?.bots ?? [], [data?.bots]);

  // Track which bots are stopping (server-side status + optimistic pending mutations)
  const stoppingBotNames = useMemo(() => {
    const names = new Set(pendingStopBots);
    for (const bot of bots) {
      if (bot.status === "stopping") names.add(bot.bot_name);
    }
    return names;
  }, [bots, pendingStopBots]);

  // Deduplicate controllers by bot_name + controller_id (WS updates can cause duplicates)
  const controllers = useMemo(() => {
    const raw = data?.controllers ?? [];
    const seen = new Map<string, ControllerInfo>();
    for (const ctrl of raw) {
      const key = `${ctrl.bot_name}:${ctrl.controller_id || ctrl.controller_name}`;
      seen.set(key, ctrl); // last wins (most recent data)
    }
    return Array.from(seen.values());
  }, [data?.controllers]);

  const sortedControllers = useMemo(
    () => [...controllers].sort((a, b) => compareControllers(a, b, sortKey, sortDir)),
    [controllers, sortKey, sortDir],
  );

  // Filter performance snapshots to only active controllers and current run
  const activeSnapshots = useMemo(() => {
    if (!perfHistory?.snapshots || controllers.length === 0) return [];

    // Build set of active controller IDs and their deploy times
    const activeControllers = new Map<string, number>(); // id -> deployedAt ms
    for (const ctrl of controllers) {
      const cid = ctrl.controller_id || ctrl.controller_name;
      const deployMs = ctrl.deployed_at ? Date.parse(ctrl.deployed_at) : 0;
      activeControllers.set(cid, deployMs);
    }

    return perfHistory.snapshots.filter((snap) => {
      const key = snap.controller_id || snap.controller_name;
      if (!key || !activeControllers.has(key)) return false;
      const deployMs = activeControllers.get(key)!;
      if (!deployMs) return true; // no deploy time known, keep it
      const snapMs = Date.parse(snap.timestamp) || 0;
      return snapMs >= deployMs;
    });
  }, [perfHistory, controllers]);

  // Build a map: controller_id -> sorted pnl values for sparklines
  const sparklineMap = useMemo(() => {
    const map: Record<string, number[]> = {};
    if (activeSnapshots.length === 0) return map;
    // Group by controller_id
    const grouped: Record<string, ControllerPerformanceSnapshot[]> = {};
    for (const snap of activeSnapshots) {
      const key = snap.controller_id || snap.controller_name;
      if (!key) continue;
      (grouped[key] ??= []).push(snap);
    }
    for (const [key, snaps] of Object.entries(grouped)) {
      const sorted = snaps.sort((a, b) => {
        const ta = Date.parse(a.timestamp) || 0;
        const tb = Date.parse(b.timestamp) || 0;
        return ta - tb;
      });
      if (sorted.some(snapshot => snapshot.global_pnl_quote === null)) continue;
      map[key] = sorted.flatMap((snapshot) => snapshot.global_pnl_quote === null ? [] : [snapshot.global_pnl_quote]);
    }
    return map;
  }, [activeSnapshots]);

  // Currency conversion
  const quoteCurrencies = useMemo(
    () => controllers.map((c) => c.trading_pair?.split("-")[1] || "USDT"),
    [controllers],
  );
  const rates = useRates(access.native ? [] : quoteCurrencies);
  const currencySymbol = access.native ? "USDC " : rates.resolvedSymbol;
  const convert = access.native ? nativeBotQuote : rates.convert;
  const formatPnlValue = (value: number | null, quote: string) => {
    if (value === null || !Number.isFinite(value)) return "UNAVAILABLE";
    return access.native ? (nativeBotQuote(value, quote).converted ? formatCurrencyPnl(value, "USDC ") : "UNAVAILABLE") : rates.formatPnlValue(value, quote);
  };
  const formatValue = (value: number | null, quote: string) => {
    if (value === null || !Number.isFinite(value)) return "UNAVAILABLE";
    return access.native ? (nativeBotQuote(value, quote).converted ? formatCurrencyVolume(value, "USDC ") : "UNAVAILABLE") : rates.formatValue(value, quote);
  };

  if (!server) {
    return <NoServerCard message="Select a server from the sidebar to view active bots." />;
  }
  if (access.native) return <BotsRoster allowDrafts={allowDrafts} ownerUnavailableReason={ownerUnavailableReason} page={error ? undefined : data}
    renderControls={botName=><div key={`${server}:${botName}`}><NativeBotControls server={server} botName={botName}/><NativeEntryControls server={server} botName={botName}/></div>}
    renderLogs={botName=>{const bot=bots.find(item=>item.bot_name===botName);return bot ? <LogsSection logs={[
      ...(bot.error_logs ?? []).map(log=>({...log,log_category:'error' as const})),
      ...(bot.general_logs ?? []).map(log=>({...log,log_category:'general' as const})),
    ].sort((a,b)=>(b.timestamp??0)-(a.timestamp??0))}/> : null;}}/>;
  if (isLoading) return <FallbackSpinner />;
  if (error)
    return (
      <p className="text-[var(--color-red)]">
        {error instanceof Error ? error.message : "Error"}
      </p>
    );

  const serverOnline = data?.server_online !== false;
  const metricsAvailable = data?.metrics_available !== false && (!access.native || quoteCurrencies.every(quote => quote === "USDC"));
  const observedCounts = observedFleetCounts(bots);
  const errorHint = data?.error_hint;
  const activeBots = bots.filter((b) => b.status === "running" || b.status === "stopping").length;

  // Compute totals with currency conversion
  let totalPnl = 0;
  let totalVolume = 0;
  for (const ctrl of controllers) {
    const quote = ctrl.trading_pair?.split("-")[1] || "USDT";
    totalPnl += ctrl.global_pnl_quote === null ? Number.NaN : convert(ctrl.global_pnl_quote, quote).value;
    totalVolume += ctrl.volume_traded === null ? Number.NaN : convert(ctrl.volume_traded, quote).value;
  }

  const isEmpty = controllers.length === 0 && bots.length === 0;

  if (!serverOnline) {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border border-[var(--color-yellow)]/40 bg-[var(--color-yellow)]/10 px-4 py-3">
          <p className="text-sm font-medium text-[var(--color-yellow)]">
            Unable to reach server
          </p>
          {errorHint && (
            <p className="text-xs text-[var(--color-text-muted)] mt-1">{errorHint}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!metricsAvailable && <p role="status" className="rounded-lg border border-[var(--color-yellow)]/40 bg-[var(--color-yellow)]/10 px-4 py-3 text-sm text-[var(--color-text)]">{data?.metrics_unavailable_reason || "Current bot performance is unavailable."}</p>}
      {/* Summary stat cards + deploy button */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]">
        <StatCard
          label={access.native ? "Tracked executor PnL" : "Total PnL"}
          value={metricsAvailable ? (totalPnl >= 0 ? "+" : "") + formatCurrencyVolume(totalPnl, currencySymbol) : "UNAVAILABLE"}
          icon={TrendingUp}
          valueColor={metricsAvailable ? pnlColor(totalPnl) : undefined}
        />
        <StatCard label="Volume" value={metricsAvailable ? formatCurrencyVolume(totalVolume, currencySymbol) : "UNAVAILABLE"} icon={Volume2} />
        <StatCard label="Active Bots" value={access.native ? observedCounts.active : String(activeBots)} icon={Bot} />
        <StatCard label="Controllers" value={access.native ? observedCounts.controllers : String(controllers.length)} icon={Layers} />
        <button
          disabled={!access.deployment}
          title={access.deployment ? "Deploy bot" : "Deployment is unavailable on this server"}
          onClick={() => setShowDeploy(true)}
          className="flex items-center gap-2 justify-center rounded-lg bg-[var(--color-primary)] px-5 py-2 text-sm font-medium text-white transition-all hover:shadow-lg hover:shadow-[var(--color-primary)]/20 h-full col-span-2 lg:col-span-1 disabled:opacity-40"
        >
          <Rocket className="h-4 w-4" />
          Deploy Bot
        </button>
      </div>

      {/* Aggregated PnL chart */}
      {activeSnapshots.length > 0 && (!access.native || metricsAvailable) && (
        <AggregatedPnlChart
          snapshots={activeSnapshots}
          controllers={controllers}
          currencySymbol={currencySymbol}
          convert={convert}
        />
      )}

      {isEmpty ? (
        <div className="flex flex-col items-center gap-2 py-16 text-[var(--color-text-muted)]">
          <Bot className="h-10 w-10" />
          <p>No bots running</p>
        </div>
      ) : (
        <>
          {/* Controllers table */}
          {controllers.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
                      <SortHeader label="Controller" sortKey="controller_name" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Connector" sortKey="connector" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Pair" sortKey="trading_pair" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Realized" sortKey="realized_pnl_quote" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Unrealized" sortKey="unrealized_pnl_quote" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Total PnL" sortKey="global_pnl_quote" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" />
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)] text-center">
                        Trend
                      </th>
                      <SortHeader label="Volume" sortKey="volume_traded" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Age" sortKey="deployed_at" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Status" sortKey="status" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="center" />
                      <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)] text-center">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedControllers.map((ctrl) => {
                      const cid = ctrl.controller_id || ctrl.controller_name;
                      return (
                        <ControllerRow
                          key={`${ctrl.bot_name}-${cid}`}
                          ctrl={ctrl}
                          server={server!}
                          isSelected={selectedKey === `${ctrl.bot_name}-${ctrl.controller_id || ctrl.controller_name}`}
                          onSelect={() => setSelectedKey(`${ctrl.bot_name}-${ctrl.controller_id || ctrl.controller_name}`)}
                          formatPnlValue={formatPnlValue}
                          formatValue={formatValue}
                          sparklineValues={sparklineMap[cid]}
                          isBotStopping={stoppingBotNames.has(ctrl.bot_name)}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Bots collapsible section */}
          {bots.length > 0 && <BotsSection bots={bots} server={server} onStopInitiated={onStopInitiated} onStopSettled={onStopSettled} />}
        </>
      )}


      {/* Fullscreen controller overlay */}
      {selectedKey && controllers.length > 0 && (!access.native || quoteCurrencies.every(quote => quote === "USDC")) && (
        <ControllerBrowser
          controllers={sortedControllers}
          server={server}
          initialControllerKey={selectedKey}
          onClose={() => setSelectedKey(null)}
          convert={convert}
          currencySymbol={currencySymbol}
        />
      )}

      {/* Deploy dialog */}
      {access.deployment && <DeployBotDialog
        open={showDeploy}
        onClose={() => setShowDeploy(false)}
        server={server}
      />}
    </div>
  );
}
