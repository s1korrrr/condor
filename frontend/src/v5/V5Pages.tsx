import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, Check, ChevronRight, CircleDot, Database, FileSearch, FileText, GitBranch, LockKeyhole, Play, RotateCw, Save, ShieldAlert, Sparkles, Square, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router-dom";
import { v5Api } from "./api";
import type { MarketEvidence, V5Agent, V5Session, V5SessionDetail, V5TaskReport, V5Workspace } from "./contracts";
import { formatUsdAmount, marketFeatures, qualifiedFeatureValue, selectedCohortCoverage, strategyAssessmentLabel, timestampAgeMs } from "./evidence";
import { boundedLoopParameters, canRequestReport } from "./policy";

function useWorkspace() {
  return useQuery({ queryKey: ["v5-workspace"], queryFn: v5Api.workspace, refetchInterval: 30_000 });
}

function Loading({ label = "Loading owner data" }: { label?: string }) {
  return <div className="v5-state v5-loading-state"><div className="v5-spinner" /><span>{label}…</span></div>;
}

function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="v5-error-panel" role="alert"><AlertTriangle size={18} /><div><strong>Data is unavailable</strong><span>{message}</span></div>{retry && <button className="v5-button" onClick={retry}>Retry</button>}</div>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="v5-empty"><span className="v5-empty-icon"><FileSearch size={20} /></span><strong>{title}</strong><p>{body}</p></div>;
}

function PageHeading({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return <div className="v5-page-heading"><div><h1>{title}</h1><p>{description}</p></div>{actions}</div>;
}

function Status({ state, label }: { state: "ready" | "blocked" | "completed" | "running" | "failed" | "stopped" | "unknown"; label?: string }) {
  return <span className={`v5-status is-${state}`}><i />{label ?? state}</span>;
}

function formatTime(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(ms) + " UTC";
}

function duration(seconds: number) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = seconds / 3600;
  return `${hours % 1 ? hours.toFixed(1) : hours} hr`;
}

function reasonList(agent: V5Agent) {
  if (agent.blockers.length) return agent.blockers;
  if (agent.status === "blocked") return ["Owner reported this agent is blocked; no blocker details were supplied."];
  return [];
}

function QueryError({ query, retry }: { query: { error: Error | null }; retry: () => void }) {
  return <ErrorState message={query.error?.message ?? "The V5 service did not return this record."} retry={retry} />;
}

export function OverviewPage() {
  const query = useWorkspace();
  if (query.isPending) return <Loading label="Loading V5 workspace" />;
  if (query.isError) return <QueryError query={query} retry={() => void query.refetch()} />;
  const data = query.data;
  return <>
    <PageHeading title="Research overview" description="A reports-only workspace for structured market review." actions={<button className="v5-button" onClick={() => void query.refetch()}><RotateCw size={15} />Refresh data</button>} />
    <IdentityStrip name={data.identity.name} host={data.identity.host} mode={data.identity.mode} executionEnabled={data.identity.execution_enabled} baseline={data.identity.baseline_binding} revision={data.identity.upstream_revision} />
    <section className="v5-overview-grid" aria-label="Workspace readiness">
      <div className="v5-overview-main">
        <div className="v5-section-heading"><div><h2>Agent readiness</h2><p>Source analysis and independent review roles</p></div><Link className="v5-text-link" to="/agents">View agents <ChevronRight size={15} /></Link></div>
        {data.agents.length ? <div className="v5-agent-list">
          {data.agents.map((agent) => <Link className="v5-agent-row" to={`/agents/${encodeURIComponent(agent.id)}`} key={agent.id}>
            <div className="v5-agent-glyph"><Bot size={18} /></div><div className="v5-agent-row-copy"><strong>{agent.name}</strong><span>{agent.description}</span></div>
            <Status state={agent.status} label={agent.status === "ready" ? "Ready" : "Blocked"} /><ChevronRight className="v5-row-chevron" size={16} />
          </Link>)}
        </div> : <EmptyState title="No agents are registered" body="The service returned an empty agent catalog. Agent identities are never seeded by this page." />}
        {data.source_error && <div className="v5-source-warning"><AlertTriangle size={16} /><span>Some owner sources are unavailable: {data.source_error}</span></div>}
      </div>
      <div className="v5-overview-side">
        <ReadinessPanel data={data} />
        <AdvisorPanel profile={data.advisor} />
      </div>
    </section>
    <section className="v5-lower-grid">
      <div className="v5-panel v5-market-summary"><div className="v5-section-heading"><div><h2>Market evidence</h2><p>Owner-provided source context</p></div><Link className="v5-text-link" to="/market">Inspect <ChevronRight size={15} /></Link></div><EvidenceSummary evidence={data.context} /></div>
      <div className="v5-panel v5-session-summary"><div className="v5-section-heading"><div><h2>Recent sessions</h2><p>Reports and source inspections</p></div><Link className="v5-text-link" to="/sessions">Journal <ChevronRight size={15} /></Link></div>
        {data.sessions.length ? <SessionRows sessions={data.sessions.slice(0, 4)} /> : <p className="v5-muted">No sessions have been recorded.</p>}
      </div>
    </section>
    <TaskLatestReports reports={data.advisor.latest_by_task} agents={data.agents} />
  </>;
}

function IdentityStrip({ name, host, mode, executionEnabled, baseline, revision }: { name: string; host: string; mode: string; executionEnabled: boolean; baseline: string | null; revision?: string | null }) {
  return <div className="v5-identity-strip"><div className="v5-identity-name"><span className="v5-live-dot" /><strong>{name}</strong><span>on {host}</span></div><div className="v5-identity-flags">
    <span className={executionEnabled ? "v5-flag is-alert" : "v5-flag is-safe"}><LockKeyhole size={14} />{executionEnabled ? "Execution enabled" : "Execution disabled"}</span>
    <span className="v5-flag"><GitBranch size={14} />{baseline ?? "Baseline unbound"}</span>
    <span className="v5-flag"><CircleDot size={13} />{mode}</span>
    {revision && <span className="v5-revision">rev {revision.slice(0, 12)}</span>}
  </div></div>;
}

function ReadinessPanel({ data }: { data: V5Workspace }) {
  const items = [
    { label: "Execution", value: data.identity.execution_enabled ? "Enabled" : "Disabled", note: data.identity.execution_enabled ? "Owner reports an enabled execution surface" : "No order routing is exposed by V5", state: data.identity.execution_enabled ? "alert" : "safe" },
    { label: "Baseline", value: data.identity.baseline_binding ?? "Unbound", note: data.identity.baseline_binding ? "Bound by the owner service" : "No strategy or account binding", state: data.identity.baseline_binding ? "safe" : "unknown" },
    { label: "Market context", value: data.context ? (data.context.schema_version ?? "Available") : "Unavailable", note: data.context ? "Source evidence returned by owner" : "No market evidence was returned", state: data.context ? "safe" : "unknown" },
  ];
  return <div className="v5-panel v5-readiness-panel"><div className="v5-section-heading"><div><h2>Environment</h2><p>Runtime bindings and safety</p></div><ShieldAlert size={17} /></div>{items.map((item) => <div className="v5-readiness-row" key={item.label}><span className={`v5-readiness-icon is-${item.state}`}>{item.state === "safe" ? <Check size={15} /> : <AlertTriangle size={15} />}</span><div><strong>{item.label}</strong><span>{item.note}</span></div><b className={`is-${item.state}`}>{item.value}</b></div>)}</div>;
}

function AdvisorPanel({ profile }: { profile: V5Workspace["advisor"] }) {
  return <div className="v5-panel v5-advisor-panel"><div className="v5-section-heading"><div><h2>Advisor</h2><p>Task-scoped model access</p></div><Sparkles size={17} /></div>
    <div className="v5-advisor-summary"><span>Provider state</span><strong>{profile.enabled ? "Enabled" : "Disabled"}</strong></div>
    <div className="v5-advisor-summary"><span>Configured model</span><strong>{profile.model ?? "Unavailable"}</strong></div>
    <div className="v5-advisor-budget"><div><span>Calls today</span><strong>{profile.calls_today == null ? "Unavailable" : profile.calls_today}</strong></div><div><span>Spent</span><strong>{money(profile.spent_usd)}</strong></div><div><span>Reserved</span><strong>{money(profile.reserved_usd)}</strong></div></div>
    <div className="v5-advisor-summary"><span>Shared pilot cap remaining</span><strong>{money(profile.budget_policy?.remaining_pilot_usd ?? null)}</strong></div>
    <div className="v5-advisor-summary"><span>Authorized ceiling</span><strong>{money(profile.budget_policy?.authorized_ceiling_usd ?? null)}</strong></div>
    <Link className="v5-text-link" to="/settings">View task profiles <ChevronRight size={15} /></Link>
  </div>;
}

const taskNames: Record<string, string> = { market_context: "Market analyst", source_quality: "Source auditor" };

function TaskLatestReports({ reports, agents, taskId }: { reports?: Record<string, V5TaskReport>; agents: V5Agent[]; taskId?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  const tasks = taskId ? [taskId] : Object.keys(taskNames);
  return <section className="v5-panel v5-task-reports"><div className="v5-section-heading"><div><h2>Latest task reports</h2><p>Advisor records are matched by the request and result task IDs.</p></div><Sparkles size={16} /></div>
    <div className="v5-task-report-list">{tasks.map((id) => {
      const report = reports?.[id];
      const record = report?.record;
      const result = record?.result;
      const agent = agents.find((row) => row.task_id === id);
      const expired = result?.expires_at_ms != null && result.expires_at_ms <= now;
      return <article className="v5-task-report" key={id}><div className="v5-section-heading"><div><h3>{taskNames[id] ?? id}</h3><p>Task <code>{id}</code> · {agent?.name ?? "No matching agent"}</p></div><Status state={report?.status === "CURRENT_REPORT" && !expired ? "completed" : report?.status === "HISTORICAL_REPORT" || expired ? "unknown" : "blocked"} label={expired ? "EXPIRED" : report?.status ?? "UNAVAILABLE"} /></div>
        {result ? <><div className="v5-task-report-meta"><DataValue label="Assessment" value={result.advice?.assessment} /><DataValue label="Coverage basis" value={result.coverage_status === "COMPLETE_OBSERVED_COHORT" ? "Complete observed cohort" : result.coverage_status === "PARTIAL_OR_UNKNOWN" ? "PARTIAL SOURCE" : "Unavailable"} /><DataValue label="Model" value={result.model} /><DataValue label="Cost" value={result.actual_usd == null ? "Unavailable" : money(result.actual_usd)} /><DataValue label="Requested" value={formatTime(result.requested_at_ms)} /><DataValue label="Received" value={formatTime(result.received_at_ms)} /><DataValue label="Expires" value={formatTime(result.expires_at_ms)} />{result.rejection && <DataValue label="Rejected because" value={result.rejection} />}{report?.status !== "CURRENT_REPORT" && report?.validity_watermark && <DataValue label="Not current since" value={`${formatTime(report.validity_watermark.watermark_ms)} · ${report.validity_watermark.reason}`} />}</div><p className="v5-task-report-summary">{result.advice?.summary || result.reason || "The owner returned no report summary."}</p>{agent && <Link className="v5-text-link" to={`/agents/${encodeURIComponent(agent.id)}`}>Open agent <ChevronRight size={14} /></Link>}</> : <p className="v5-muted">{report?.status === "SOURCE_UNAVAILABLE" ? "The advisor source is unavailable." : "No report is available for this task."}</p>}
      </article>;
    })}</div>
  </section>;
}

function money(value: number | string | null | undefined) {
  return formatUsdAmount(value);
}

function EvidenceSummary({ evidence }: { evidence: MarketEvidence | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!evidence) return <div className="v5-market-unavailable"><span><Database size={18} /></span><strong>Market context unavailable</strong><p>No current market evidence was returned from the owner service.</p><DataValue label="Native position state" value="Unavailable" /><div className="v5-market-split"><FeatureGroup label="Spot" prefix="spot." evidence={null} /><FeatureGroup label="Perpetual · derivatives" prefix="derivatives." evidence={null} /></div></div>;
  const spotRows = marketFeatures(evidence, "spot.");
  const perpetualRows = marketFeatures(evidence, "derivatives.");
  const age = timestampAgeMs(evidence.available_at_ms, now);
  const assessment = strategyAssessmentLabel(evidence);
  const baseline = evidence.baseline_binding_hash === null ? "Unbound" : evidence.baseline_binding_hash ?? "Unavailable";
  return <>
    <div className="v5-evidence-meta">
      <DataValue label="Schema" value={evidence.schema_version} />
      <DataValue label="Snapshot" value={evidence.snapshot_id} />
      <DataValue label="Cutoff" value={formatTime(evidence.cutoff_ms)} />
      <DataValue label="Available at" value={formatTime(evidence.available_at_ms)} />
      <DataValue label="Snapshot age" value={age == null ? "Unavailable" : formatAge(age)} />
      <DataValue label="Baseline binding" value={baseline} />
      <DataValue label="Strategy assessment" value={assessment} />
      <DataValue label="Native position state" value="Unavailable" />
    </div>
    <CohortCoverageNotice evidence={evidence} />
    <div className="v5-market-split">
      <FeatureGroup label="Spot" prefix="spot." features={spotRows} evidence={evidence} />
      <FeatureGroup label="Perpetual · derivatives" prefix="derivatives." features={perpetualRows} evidence={evidence} />
    </div>
    <QualitySummary quality={evidence.quality} />
    <p className="v5-qualified-note">QUALIFIED means a feature value is available for the observations used. It does not mean the selected asset and venue cohort is complete; check the coverage status above.</p>
    <EvidenceFields evidence={evidence} />
  </>;
}

function CohortCoverageNotice({ evidence }: { evidence: MarketEvidence }) {
  const coverage = selectedCohortCoverage(evidence);
  return <section className={`v5-cohort-coverage${coverage.complete ? " is-complete" : " is-partial"}`} aria-label="Selected market cohort coverage">
    <div className="v5-cohort-coverage-heading"><div><strong>{coverage.complete ? "Complete observed cohort" : "PARTIAL SOURCE"}</strong><p>{coverage.complete ? "All selected spot assets and spot/perpetual venue pairs have qualified coverage." : "Selected asset or venue coverage is incomplete or unknown. Qualified feature values may describe only the observed subset."}</p></div><Status state={coverage.complete ? "ready" : "blocked"} label={coverage.complete ? "COMPLETE" : "PARTIAL / UNKNOWN"} /></div>
    <div className="v5-cohort-coverage-grid">{coverage.dimensions.map((row) => <div className="v5-cohort-coverage-row" key={row.key}><span>{row.label}</span><strong>{row.valid == null || row.expected == null ? "Unavailable" : `${row.valid} / ${row.expected}`}</strong><small>{row.fraction == null ? "Coverage unknown" : `${(row.fraction * 100).toFixed(1)}%`}</small></div>)}</div>
  </section>;
}

function formatAge(ms: number) {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} seconds`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} minutes`;
  return `${Math.floor(ms / 3_600_000)} hours`;
}

function FeatureGroup({ label, prefix, features, evidence }: { label: string; prefix: "spot." | "derivatives."; features?: ReturnType<typeof marketFeatures>; evidence: MarketEvidence | null }) {
  const rows = features ?? (evidence ? marketFeatures(evidence, prefix) : []);
  return <section className="v5-domain-block"><span className="v5-domain-label">{label}</span>{rows.length ? <div className="v5-feature-list">{rows.map((feature) => <div className="v5-feature-row" key={feature.id}>
    <span className="v5-feature-name" title={feature.id}>{feature.label}</span><strong className={feature.status === "QUALIFIED" ? "is-qualified" : "is-unavailable"}>{qualifiedFeatureValue(feature)}</strong><span className="v5-feature-unit">{feature.unit}</span><span className={`v5-feature-state${feature.status === "QUALIFIED" ? " is-qualified" : ""}`}>{feature.status}</span>
  </div>)}</div> : <span className="v5-muted">Unavailable · no {label.toLowerCase()} feature rows</span>}</section>;
}

function QualitySummary({ quality }: { quality: Record<string, unknown> | undefined }) {
  if (!quality || !Object.keys(quality).length) return <div className="v5-source-warning"><AlertTriangle size={14} />Source quality details unavailable.</div>;
  const spotCoverage = quality.spot_venue_coverage_fraction;
  const perpetualCoverage = quality.perpetual_venue_coverage_fraction;
  const quoteCohorts = quality.quote_cohort_by_market;
  return <section className="v5-quality-summary"><div className="v5-quality-title"><strong>Source quality & coverage</strong><span>owner-reported</span></div>
    <div className="v5-quality-grid"><DataValue label="Spot venue coverage" value={spotCoverage} /><DataValue label="Perpetual venue coverage" value={perpetualCoverage} /><DataValue label="Source-wide rows seen" value={quality.target_rows_seen} /><DataValue label="Source-wide missing rows" value={recordField(quality.target_row_states, "missing")} /><DataValue label="Spot quote cohort" value={recordField(quoteCohorts, "spot")} /><DataValue label="Perpetual quote cohort" value={recordField(quoteCohorts, "perpetual")} /><DataValue label="Quote conversion" value={quality.quote_conversion} /><DataValue label="Volume features" value={quality.volume_features} /></div>
  </section>;
}

function recordField(record: unknown, field: string) {
  if (record == null || typeof record !== "object" || !(field in record)) return "Unavailable";
  const value = (record as Record<string, unknown>)[field];
  return Array.isArray(value) ? value.join(", ") : displayEvidenceValue(value);
}

function EvidenceFields({ evidence }: { evidence: MarketEvidence }) {
  const entries = Object.entries(evidence).filter(([key]) => !["features", "quality"].includes(key));
  if (!entries.length) return null;
  return <details className="v5-evidence-raw"><summary>Full source evidence · {entries.length} fields</summary><dl>{entries.map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{displayEvidenceValue(value)}</dd></div>)}</dl></details>;
}

function displayEvidenceValue(value: unknown): string {
  if (value == null || value === "") return "Unavailable";
  if (typeof value === "number" && Number.isFinite(value) && value > 1_000_000_000_000) return formatTime(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function DataValue({ label, value }: { label: string; value: unknown }) {
  const display = value == null || value === "" ? "Unavailable" : displayEvidenceValue(value);
  return <div className="v5-data-value"><span>{label}</span><strong>{display}</strong></div>;
}

export function AgentsPage() {
  const query = useWorkspace();
  if (query.isPending) return <Loading label="Loading agent catalog" />;
  if (query.isError) return <QueryError query={query} retry={() => void query.refetch()} />;
  return <><PageHeading title="Agent catalog" description="The workspace roles and their owner-reported readiness." />
    {query.data.agents.length ? <div className="v5-agent-catalog">{query.data.agents.map((agent) => <AgentCatalogRow agent={agent} key={agent.id} />)}</div> : <EmptyState title="No agents are registered" body="The service returned an empty catalog. No demo or placeholder agents are shown." />}
    {query.data.source_error && <div className="v5-source-warning"><AlertTriangle size={16} />Some catalog sources are unavailable: {query.data.source_error}</div>}
  </>;
}

function AgentCatalogRow({ agent }: { agent: V5Agent }) {
  const blockers = reasonList(agent);
  return <Link to={`/agents/${encodeURIComponent(agent.id)}`} className="v5-catalog-row">
    <div className="v5-agent-glyph"><Bot size={19} /></div><div className="v5-catalog-main"><div className="v5-catalog-title"><h2>{agent.name}</h2><Status state={agent.status} label={agent.status === "ready" ? "Ready" : "Blocked"} /></div><p>{agent.description}</p>
      <div className="v5-catalog-meta"><span>Task <b>{agent.task_id ?? "Unavailable"}</b></span><span>Model <b>{agent.model || "Unavailable"}</b></span><span>Tools <b>{agent.tools.length}</b></span><span>Skills <b>{agent.skills.length}</b></span><span>Loops <b>{agent.loops.length}</b></span></div>
      {blockers.length > 0 && <div className="v5-blocker-inline"><AlertTriangle size={14} /><span>{blockers.join(" · ")}</span></div>}
    </div><ChevronRight className="v5-row-chevron" size={17} />
  </Link>;
}

export function AgentDetailPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"playbook" | "skills" | "tools" | "notes">("playbook");
  const detailQuery = useQuery({ queryKey: ["v5-agent", id], queryFn: () => v5Api.agent(id), enabled: !!id });
  const workspace = useWorkspace();
  const [notes, setNotes] = useState<string | null>(null);
  const inspect = useMutation({ mutationFn: () => v5Api.inspect(id), onSuccess: (session) => { cacheSession(queryClient, session); navigate(`/sessions/${encodeURIComponent(session.id)}`); } });
  const report = useMutation({ mutationFn: () => v5Api.report(id), onSuccess: (session) => { cacheSession(queryClient, session); navigate(`/sessions/${encodeURIComponent(session.id)}`); } });
  const startLoop = useMutation({ mutationFn: () => {
    const loop = detailQuery.data?.loops[0];
    if (!loop?.id) throw new Error("No valid report loop is defined for this agent.");
    const bounds = boundedLoopParameters(loop.frequency_sec, loop.max_ticks);
    if (!bounds) throw new Error("The owner returned invalid loop limits.");
    return v5Api.startLoop(id, loop.id, bounds.frequency_sec, bounds.max_ticks);
  }, onSuccess: (session) => { cacheSession(queryClient, session); navigate(`/sessions/${encodeURIComponent(session.id)}`); } });
  const saveNotes = useMutation({ mutationFn: (text: string) => v5Api.saveNotes(id, text), onSuccess: (result) => { setNotes(result.notes); void queryClient.invalidateQueries({ queryKey: ["v5-agent", id] }); } });
  const actionError = inspect.error ?? report.error ?? startLoop.error ?? saveNotes.error;
  const profile = detailQuery.data?.task_id == null ? undefined : workspace.data?.advisor.task_profiles.find((row) => row.task_id === detailQuery.data?.task_id);
  const effectiveModel = profile?.model ?? workspace.data?.advisor.model ?? null;
  const canRequest = !!detailQuery.data && !!workspace.data && canRequestReport({
    agentReady: detailQuery.data.status === "ready",
    advisorEnabled: workspace.data.advisor.enabled,
    taskEnabled: !!profile?.enabled,
    modelAvailable: !!effectiveModel,
    mode: workspace.data.identity.mode,
    executionEnabled: workspace.data.identity.execution_enabled,
    agentExecutionEnabled: detailQuery.data.policy.execution_enabled,
  });
  const canStartLoop = canRequest && !!detailQuery.data?.loops.some((loop) => !!loop.id);

  if (detailQuery.isPending) return <Loading label="Loading agent record" />;
  if (detailQuery.isError) return <QueryError query={detailQuery} retry={() => void detailQuery.refetch()} />;
  const agent = detailQuery.data;
  const blockers = reasonList(agent);
  const displayNotes = notes ?? agent.notes;
  const tabs = ["playbook", "skills", "tools", "notes"] as const;
  return <>
    <div className="v5-back-row"><Link to="/agents">Agents</Link><ChevronRight size={14} /><span>{agent.name}</span></div>
    <PageHeading title={agent.name} description={agent.description} actions={<Status state={agent.status} label={agent.status === "ready" ? "Ready" : "Blocked"} />} />
    <div className="v5-agent-meta-line"><span>Task <b>{agent.task_id ?? "Unavailable"}</b></span><span>Model <b>{agent.model || "Unavailable"}</b></span><span>Mode <b>{agent.mode}</b></span><span>Policy <b>{agent.policy.execution_enabled ? "Execution enabled" : "Execution disabled"}</b></span></div>
    {blockers.length > 0 && <section className="v5-blocker-panel"><AlertTriangle size={18} /><div><strong>Agent readiness is blocked</strong><ul>{blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul></div></section>}
    {actionError && <div className="v5-action-error" role="alert"><AlertTriangle size={15} />{actionError.message}</div>}
    <section className="v5-agent-actions" aria-label="Agent actions">
      <div className="v5-safe-action"><button className="v5-button v5-button-primary" onClick={() => inspect.mutate()} disabled={inspect.isPending}><FileSearch size={16} />{inspect.isPending ? "Inspecting sources…" : "Inspect sources"}</button><span>Deterministic owner inspection; no model call.</span></div>
      <div className="v5-safe-action"><button className="v5-button" onClick={() => report.mutate()} disabled={!canRequest || report.isPending}><FileText size={16} />{report.isPending ? "Requesting report…" : "Request report"}</button><span>{canRequest ? `Bounded to ${effectiveModel} and this agent’s configured task profile.` : unavailableReason(agent, workspace.data?.advisor.enabled, profile?.enabled, !!effectiveModel)}</span></div>
      <div className="v5-safe-action"><button className="v5-button" onClick={() => startLoop.mutate()} disabled={!canStartLoop || startLoop.isPending}><Play size={16} />{startLoop.isPending ? "Starting report loop…" : "Start report loop"}</button><span>{agent.loops[0] ? `${agent.loops[0].name}: ≥ ${duration(boundedLoopParameters(agent.loops[0].frequency_sec, agent.loops[0].max_ticks)?.frequency_sec ?? 900)}, ≤ ${boundedLoopParameters(agent.loops[0].frequency_sec, agent.loops[0].max_ticks)?.max_ticks ?? 1} ticks` : "No report loop is configured."}</span></div>
    </section>
    {agent.task_id && <TaskLatestReports reports={workspace.data?.advisor.latest_by_task} agents={[agent]} taskId={agent.task_id} />}
    <div className="v5-agent-layout">
      <section className="v5-panel v5-agent-content-panel">
        <div className="v5-tabs" role="tablist" aria-label="Agent details">{tabs.map((key) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "is-selected" : ""} onClick={() => setTab(key)}>{key === "playbook" ? "Playbook" : key === "skills" ? `Skills (${agent.skills.length})` : key === "tools" ? "Tools & policy" : "Notes"}</button>)}</div>
        <div className="v5-tab-content" role="tabpanel">
          {tab === "playbook" && <MarkdownContent value={agent.playbook} empty="No playbook content was returned by the owner service." />}
          {tab === "skills" && (agent.skills.length ? <div className="v5-skill-list">{agent.skills.map((skill) => <details className="v5-skill" key={skill.id}><summary><span><Sparkles size={15} />{skill.name}</span><ChevronRight size={15} /></summary><div className="v5-skill-body"><MarkdownContent value={skill.content ?? ""} empty="No skill content was returned." /></div></details>)}</div> : <EmptyState title="No skills are listed" body="This agent has no owner-reported skills." />)}
          {tab === "tools" && <ToolsPolicy agentTools={agent.tools} allowedTools={agent.policy.allowed_tools} emptyAllowlistMeans={agent.policy.empty_allowlist_means} />}
          {tab === "notes" && <NotesEditor key={`${agent.id}:${displayNotes}`} initial={displayNotes} onSave={(text) => saveNotes.mutate(text)} saving={saveNotes.isPending} />}
        </div>
      </section>
      <aside className="v5-agent-side">
        <div className="v5-panel v5-agent-spec"><h2>Loop recipes</h2>{agent.loops.length ? agent.loops.map((loop) => <div className="v5-loop-spec" key={loop.id}><strong>{loop.name}</strong><span>Every {duration(loop.frequency_sec)}</span><span>Maximum {loop.max_ticks} ticks</span></div>) : <p className="v5-muted">No loop recipe is configured.</p>}</div>
        <div className="v5-panel v5-agent-spec"><h2>Effective V5 tools</h2>{agent.policy.allowed_tools.length ? <ul className="v5-tool-list">{agent.policy.allowed_tools.map((tool) => <li key={tool}><Check size={14} />{tool}</li>)}</ul> : <p className="v5-muted">{emptyPolicyMessage(agent.policy.empty_allowlist_means)}</p>}<p className="v5-policy-note"><LockKeyhole size={13} />Execution capability: {agent.policy.execution_enabled ? "enabled by owner" : "disabled by owner"}</p></div>
      </aside>
    </div>
  </>;
}

function unavailableReason(agent: V5Agent, advisorEnabled?: boolean, profileEnabled?: boolean, modelAvailable = false) {
  if (agent.status !== "ready") return "Unavailable while this agent is blocked.";
  if (!advisorEnabled) return "Advisor is disabled by the owner service.";
  if (!profileEnabled) return "This task profile is unavailable or disabled.";
  if (!modelAvailable) return "No task-specific or configured advisor model is available.";
  return "Report actions require a reports-only workspace.";
}

function cacheSession(client: ReturnType<typeof useQueryClient>, session: V5SessionDetail) {
  client.setQueryData(["v5-session", session.id], session);
  void client.invalidateQueries({ queryKey: ["v5-workspace"] });
  void client.invalidateQueries({ queryKey: ["v5-sessions"] });
}

function MarkdownContent({ value, empty }: { value: string; empty: string }) {
  if (!value.trim()) return <p className="v5-muted">{empty}</p>;
  return <article className="v5-markdown"><ReactMarkdown>{value}</ReactMarkdown></article>;
}

function emptyPolicyMessage(means: "deny_all" | "allow_all" | "unknown") {
  if (means === "deny_all") return "V5 effective tools: none. This workspace does not load generic Condor tool configuration.";
  if (means === "allow_all") return "The effective allowlist is empty; Condor semantics allow all tools. Review this policy before any action.";
  return "The effective behavior of an empty allowlist is not available from the owner response.";
}

function ToolsPolicy({ agentTools, allowedTools, emptyAllowlistMeans }: { agentTools: string[]; allowedTools: string[]; emptyAllowlistMeans: "deny_all" | "allow_all" | "unknown" }) {
  const rows = useMemo(() => [...new Set([...agentTools, ...allowedTools])].sort(), [agentTools, allowedTools]);
  if (!rows.length) return <EmptyState title="Tool names unavailable" body={emptyPolicyMessage(emptyAllowlistMeans)} />;
  return <div className="v5-policy-table"><div className="v5-policy-row v5-policy-head"><span>Tool</span><span>Agent manifest</span><span>Effective allowlist</span></div>{rows.map((tool) => <div className="v5-policy-row" key={tool}><strong>{tool}</strong><span>{agentTools.includes(tool) ? <><Check size={13} /> Listed</> : "Not listed"}</span><span>{allowedTools.includes(tool) ? <><Check size={13} /> Allowed</> : <><XCircle size={13} /> Not allowed</>}</span></div>)}</div>;
}

function NotesEditor({ initial, onSave, saving }: { initial: string; onSave: (value: string) => void; saving: boolean }) {
  const [text, setText] = useState(initial);
  const changed = text !== initial;
  return <div className="v5-notes-editor"><label htmlFor="agent-notes">Operator notes</label><p>Notes are stored by the V5 owner and are not sent to a model unless the owner includes them in a report task.</p><textarea id="agent-notes" maxLength={8000} value={text} onChange={(event) => setText(event.target.value)} /><div className="v5-notes-footer"><span>{text.length} / 8,000</span><button className="v5-button v5-button-primary" disabled={!changed || saving} onClick={() => onSave(text)}><Save size={15} />{saving ? "Saving…" : "Save notes"}</button></div></div>;
}

export function MarketPage() {
  const query = useWorkspace();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10_000); return () => window.clearInterval(timer); }, []);
  if (query.isPending) return <Loading label="Loading market evidence" />;
  if (query.isError && !query.data) return <QueryError query={query} retry={() => void query.refetch()} />;
  const evidence = query.data.context;
  const cohortCoverage = evidence ? selectedCohortCoverage(evidence) : null;
  const refresh = query.data.source_refresh;
  const freshness = refresh?.feed_freshness === "FRESH" && refresh.feed_fresh_until_ms != null && now <= refresh.feed_fresh_until_ms ? "CURRENT" : refresh?.feed_freshness === "UNAVAILABLE" || refresh?.feed_freshness === "FRESH" ? "STALE" : "UNKNOWN";
  return <><PageHeading title="Market evidence" description="Source status, coverage, timestamps, units, and market type stay explicit." actions={<button className="v5-button" onClick={() => void query.refetch()}><RotateCw size={15} />Refresh evidence</button>} />
    <section className="v5-market-refresh" aria-label="Feed refresh status"><div><strong>Feed status</strong><Status state={freshness === "CURRENT" ? "ready" : freshness === "STALE" ? "blocked" : "unknown"} label={`${refresh?.state ?? "UNKNOWN"} · ${freshness}`} /></div><span>Refresh health does not imply complete market coverage.</span><span>Last refresh attempt: {formatTime(refresh?.last_attempt_at_ms)}</span><span>Last successful publication: {formatTime(refresh?.last_success_at_ms)}</span><span>Published cutoff: {formatTime(refresh?.last_success_cutoff_ms)}</span><span>Dashboard last successful read: {query.dataUpdatedAt ? formatTime(query.dataUpdatedAt) : "Unavailable"}</span>{refresh?.error && <span role="alert">Feed refresh issue: {refresh.error}</span>}{query.error && <span role="alert">Dashboard refresh failed: showing last successful response · {query.error.message}</span>}</section>
    {query.data.source_error && <div className="v5-source-warning"><AlertTriangle size={16} />{query.data.source_error}</div>}
    {!evidence ? <div className="v5-panel v5-market-page-empty"><EvidenceSummary evidence={null} /><p>{query.data.identity.baseline_binding ? "A baseline is reported as bound, but no market source evidence was returned." : "Baseline and market context are both unavailable. No comparison or market conclusion can be drawn."}</p></div> : <div className="v5-market-page"><section className="v5-panel"><div className="v5-section-heading"><div><h2>Source record</h2><p>Values are displayed from the owner response without conversion.</p></div><Status state={cohortCoverage?.complete ? "ready" : "blocked"} label={cohortCoverage?.complete ? "Complete observed cohort" : "PARTIAL SOURCE"} /></div><EvidenceSummary evidence={evidence} /></section><section className="v5-market-limits"><ShieldAlert size={17} /><div><strong>Interpretation limits</strong><p>Refresh health and feature validity do not certify full cohort coverage. Native position state is unavailable in this reports-only workspace. V5 does not infer composite scores, strategy baselines, or performance from market context. Missing fields remain unavailable.</p></div></section></div>}
  </>;
}

export function SessionsPage() {
  const query = useQuery({ queryKey: ["v5-sessions"], queryFn: v5Api.sessions, refetchInterval: 20_000 });
  if (query.isPending) return <Loading label="Loading session journal" />;
  if (query.isError) return <QueryError query={query} retry={() => void query.refetch()} />;
  return <><PageHeading title="Sessions" description="Source inspections, bounded reports, and report-loop records." actions={<button className="v5-button" onClick={() => void query.refetch()}><RotateCw size={15} />Refresh journal</button>} />
    {query.data.length ? <div className="v5-session-table-wrap"><SessionRows sessions={query.data} expanded /></div> : <EmptyState title="No V5 sessions yet" body="Sessions appear here after an agent source inspection, report request, or report-loop run." />}
  </>;
}

function SessionRows({ sessions, expanded = false }: { sessions: V5Session[]; expanded?: boolean }) {
  return <div className={`v5-session-rows${expanded ? " is-expanded" : ""}`}>{sessions.map((session) => <Link className="v5-session-row" to={`/sessions/${encodeURIComponent(session.id)}`} key={session.id}>
    <span className="v5-session-icon"><FileText size={16} /></span><span className="v5-session-copy"><strong>{session.summary || session.id}</strong><small>{session.agent_id ?? "Unavailable"} · {session.loop_id || "Source inspection"} · {formatTime(session.started_at_ms)}</small></span><Status state={sessionState(session.status)} label={session.status} /><span className="v5-effect">Effect: {session.effect || "Unavailable"}</span><ChevronRight className="v5-row-chevron" size={15} />
  </Link>)}</div>;
}

function sessionState(status: string): "completed" | "running" | "failed" | "stopped" | "blocked" | "unknown" {
  const value = status.toUpperCase();
  if (value === "COMPLETED") return "completed";
  if (value === "RUNNING") return "running";
  if (value === "FAILED") return "failed";
  if (value === "STOPPED") return "stopped";
  if (value === "BLOCKED") return "blocked";
  return "unknown";
}

export function SessionDetailPage() {
  const { id = "" } = useParams();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["v5-session", id], queryFn: () => v5Api.session(id), enabled: !!id, refetchInterval: (q) => q.state.data?.status.toUpperCase() === "RUNNING" ? 5000 : false });
  const stop = useMutation({ mutationFn: () => v5Api.stopSession(id), onSuccess: (session) => cacheSession(client, session) });
  if (query.isPending) return <Loading label="Loading session record" />;
  if (query.isError) return <QueryError query={query} retry={() => void query.refetch()} />;
  const session = query.data;
  const reportText = session.ticks?.flatMap((tick) => tick.report == null ? [] : [typeof tick.report === "string" ? tick.report : JSON.stringify(tick.report, null, 2)]).join("\n\n") ?? "";
  return <><div className="v5-back-row"><Link to="/sessions">Sessions</Link><ChevronRight size={14} /><span>{session.id}</span></div>
    <PageHeading title={session.summary || "Session record"} description={`${session.agent_id ?? "Unavailable"} · ${session.loop_id || "Source inspection"}`} actions={<Status state={sessionState(session.status)} label={session.status} />} />
    <div className="v5-session-meta"><DataValue label="Started" value={formatTime(session.started_at_ms)} /><DataValue label="Finished" value={formatTime(session.finished_at_ms)} /><DataValue label="Effect" value={session.effect || "Unavailable"} /><DataValue label="Session ID" value={session.id} /></div>
    {stop.error && <div className="v5-action-error" role="alert"><AlertTriangle size={15} />{stop.error.message}</div>}
    {session.status.toUpperCase() === "RUNNING" && session.loop_id && <div className="v5-session-stop"><span>This report loop is running. Stopping it records the owner service response.</span><button className="v5-button v5-button-danger" onClick={() => stop.mutate()} disabled={stop.isPending}><Square size={14} />{stop.isPending ? "Stopping…" : "Stop report loop"}</button></div>}
    <div className="v5-session-detail-grid"><section className="v5-panel"><div className="v5-section-heading"><div><h2>Tick journal</h2><p>Chronological work recorded by the owner service</p></div></div>
      {session.ticks?.length ? <ol className="v5-tick-list">{session.ticks.map((tick) => <li key={tick.id}><div className="v5-tick-marker" /><div className="v5-tick-content"><div className="v5-tick-header"><strong>{tick.summary || tick.id}</strong><Status state={sessionState(tick.status)} label={tick.status} /></div><span>{formatTime(tick.at_ms)}</span>{tick.error && <div className="v5-source-warning"><AlertTriangle size={14} />{tick.error}</div>}{tick.evidence_refs.length > 0 && <div className="v5-evidence-refs"><strong>Evidence references</strong>{tick.evidence_refs.map((ref) => <code key={ref}>{ref}</code>)}</div>}</div></li>)}</ol> : <EmptyState title="No ticks recorded" body="The owner service has not recorded a tick for this session." />}
    </section><aside className="v5-session-side">
      <div className="v5-panel"><div className="v5-section-heading"><div><h2>Report output</h2><p>Returned by the bounded report task</p></div></div>{reportText ? <MarkdownContent value={reportText} empty="" /> : <p className="v5-muted">No report output is attached to this session.</p>}</div>
      <div className="v5-panel"><div className="v5-section-heading"><div><h2>Session journal</h2><p>Owner record text</p></div></div>{session.journal ? <pre className="v5-journal">{session.journal}</pre> : <p className="v5-muted">No journal text was returned.</p>}</div>
    </aside></div>
  </>;
}

export function SettingsPage() {
  const query = useQuery({ queryKey: ["v5-settings"], queryFn: v5Api.settings });
  if (query.isPending) return <Loading label="Loading workspace settings" />;
  if (query.isError) return <QueryError query={query} retry={() => void query.refetch()} />;
  const settings = query.data;
  const tasks = settings.task_profiles ?? settings.budget.task_profiles ?? [];
  return <><PageHeading title="Workspace settings" description="Read-only configuration and current owner-reported readiness." actions={<button className="v5-button" onClick={() => void query.refetch()}><RotateCw size={15} />Refresh settings</button>} />
    <div className="v5-settings-grid"><section className="v5-panel"><div className="v5-section-heading"><div><h2>Runtime identity</h2><p>Server-supplied workspace binding</p></div></div><div className="v5-settings-list"><DataValue label="Workspace" value={settings.identity.name} /><DataValue label="Host" value={settings.identity.host} /><DataValue label="Mode" value={settings.identity.mode} /><DataValue label="Execution" value={settings.identity.execution_enabled ? "Enabled" : "Disabled"} /><DataValue label="Baseline binding" value={settings.identity.baseline_binding} /><DataValue label="Upstream revision" value={settings.identity.upstream_revision} /></div></section>
      <section className="v5-panel"><div className="v5-section-heading"><div><h2>Model budget</h2><p>Usage reported by the advisor service</p></div><Sparkles size={16} /></div><div className="v5-budget-grid"><DataValue label="Advisor enabled" value={settings.budget.enabled ? "Yes" : "No"} /><DataValue label="Configured model" value={settings.budget.model} /><DataValue label="Calls today" value={settings.budget.calls_today} /><DataValue label="Spent" value={money(settings.budget.spent_usd)} /><DataValue label="Reserved" value={money(settings.budget.reserved_usd)} /><DataValue label="Pilot cap" value={money(settings.budget_policy?.pilot_usd)} /><DataValue label="Daily cap" value={money(settings.budget_policy?.daily_usd)} /><DataValue label="Remaining pilot cap" value={money(settings.budget_policy?.remaining_pilot_usd)} /><DataValue label="Authorized ceiling" value={money(settings.budget_policy?.authorized_ceiling_usd)} /><DataValue label="Provider billing balance" value="Unavailable" /></div><div className="v5-no-secret"><LockKeyhole size={15} /><span>Provider credentials are not exposed or editable in this dashboard.</span></div><p className="v5-muted">Set ANTHROPIC_API_KEY in <code>/home/rsi/dev/rsibot/.workspace/runs/v5-agent-workspace-20261028/secrets/anthropic.env</code> on Razer. Do not enter it in this browser or commit it.</p><p className="v5-muted">Automatic advisor polling: {settings.scheduler?.enabled == null ? "Unavailable" : settings.scheduler.enabled ? "Enabled" : "Disabled"} · Last attempt: {formatTime(settings.scheduler?.last_attempt_ms)} · {settings.scheduler?.last_status ?? "No status"}</p></section>
    </div>
    <section className="v5-panel v5-task-profiles"><div className="v5-section-heading"><div><h2>Task profiles</h2><p>Model selection follows the configured task profile.</p></div></div>
      {tasks.length ? <div className="v5-profile-table"><div className="v5-profile-row v5-profile-head"><span>Task</span><span>Model</span><span>Enabled</span><span>Credential</span><span>Owner reason</span></div>{tasks.map((task, index) => <div className="v5-profile-row" key={task.task_id ?? `task-${index}`}><strong>{task.task_id ?? "Unavailable"}</strong><span>{task.model || "Unavailable"}</span><Status state={task.enabled ? "ready" : "blocked"} label={task.enabled ? "Enabled" : "Disabled"} /><span>{task.credential_status ?? "Unavailable"}</span><span>{task.reason || "No reason supplied"}</span></div>)}</div> : <EmptyState title="No task profiles returned" body="The advisor service did not provide task-specific models. No model or usage values are inferred." />}
    </section>
    <section className="v5-settings-note"><ShieldAlert size={17} /><div><strong>Budget and provider settings are read-only here</strong><p>Configure access and spend limits in the Razer service. RSI V5 does not collect API keys or save model credentials in the browser.</p></div></section>
  </>;
}
