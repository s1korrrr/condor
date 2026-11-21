import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { v5Api } from "./api";
import { scheduledAgentLines } from "./agent-status";
import { usePaperClock } from "./usePaperClock";

/**
 * One line per scheduled agent for the Overview: the report's validity and the advisor's own one-line display text.
 * It never reads the owner by itself: every workspace read fans out to the owner services, so it shows what the Agents
 * views already read this session (same query key, "as read at"), and one read on request. The text is advisor output
 * that no bot reads.
 */
export function AgentConclusions() {
  const workspace = useQuery({ queryKey: ["v5-workspace"], queryFn: v5Api.workspace, enabled: false });
  const now = usePaperClock();
  const readAt = workspace.data && workspace.dataUpdatedAt ? new Date(workspace.dataUpdatedAt).toISOString().slice(0, 19).replace("T", " ") : null;
  const lines = workspace.data ? scheduledAgentLines(workspace, now) : [];
  const refresh = <button className="v5-button" type="button" disabled={workspace.isFetching} onClick={() => void workspace.refetch()}>{workspace.data ? "Refresh" : "Read now"}</button>;
  return <section className="v5m-card" aria-label="Agent conclusions">
    <h3><NavLink to="/agents">Agents</NavLink></h3>
    <p className="v5m-hint">Each line is the advisor's own display text for its latest report. No bot reads it, and it places no orders.</p>
    {workspace.data && !workspace.isError ? <p className="v5m-hint">{readAt ? `As read at ${readAt} UTC` : "As last read"} · {refresh}</p> : null}
    {workspace.isFetching && !workspace.data ? <p role="status" className="v5m-hint">Reading the agent reports…</p>
      : workspace.isError ? <p role="alert" className="v5m-hint">Not read: {workspace.error?.message ?? "the workspace read failed"}. {refresh}</p>
      : !workspace.data ? <p className="v5m-hint">Open <NavLink to="/agents">Agents</NavLink> to read the latest reports. {refresh}</p>
      : lines.map(line => <p className="v5m-hint" key={line.id}>
        <NavLink to={`/agents/${line.id}`}>{line.name}</NavLink> · <strong>{line.state}</strong>
        {line.reportTime && <> · report {line.reportTime.slice(11, 19)} UTC ({line.reportAge})</>}
        {" · "}{line.conclusion ? <q>{line.conclusion}</q> : "conclusion not published"}
      </p>)}
  </section>;
}
