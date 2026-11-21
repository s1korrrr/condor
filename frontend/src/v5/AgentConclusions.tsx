import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { v5Api } from "./api";
import { agentReportStore, retainReports, scheduledAgentLines } from "./agent-status";
import { usePaperClock } from "./usePaperClock";

/**
 * One line per scheduled agent for the Overview: the report's validity and the advisor's own one-line display text.
 * Same query key as the Agents page, so both share one cached read; the text is advisor output that no bot reads.
 */
export function AgentConclusions() {
  const workspace = useQuery({ queryKey: ["v5-workspace"], queryFn: v5Api.workspace, refetchInterval: 60_000 });
  const now = usePaperClock();
  const lines = workspace.isPending ? [] : scheduledAgentLines(workspace, now, retainReports(agentReportStore, workspace, now));
  return <section className="v5m-card" aria-label="Agent conclusions">
    <h3><NavLink to="/agents">Agents</NavLink></h3>
    <p className="v5m-hint">Each line is the advisor's own display text for its latest report. No bot reads it, and it places no orders.</p>
    {workspace.isPending ? <p role="status" className="v5m-hint">Reading the agent reports…</p>
      : workspace.isError && !workspace.data ? <p role="alert" className="v5m-hint">Agent reports unavailable: {workspace.error?.message ?? "the workspace read failed"}.</p>
      : lines.map(line => <p className="v5m-hint" key={line.id}>
        <NavLink to={`/agents/${line.id}`}>{line.name}</NavLink> · <strong>{line.state}</strong>
        {line.reportTime && <> · report {line.reportTime.slice(11, 19)} UTC ({line.reportAge})</>}
        {line.refreshFailedAt && <> · refresh failed at {line.refreshFailedAt.slice(11, 19)} UTC</>}
        {" · "}{line.conclusion ? <q>{line.conclusion}</q> : "conclusion not published"}
      </p>)}
  </section>;
}
