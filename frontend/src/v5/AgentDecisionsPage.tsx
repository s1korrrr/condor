import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { v5Api } from './api';
import type { V5TaskReport } from './contracts';
import { age, count, ownerDisplay, utc } from './format.mjs';
import { OwnerValue } from './OwnerValue';
import { TASKS, reportPresentation, selectReports } from './agent-decisions-model.mjs';
import { usePaperClock } from './usePaperClock';
import './agent-decisions.css';

function Time({ value, now, allowFuture = false }: { value?: number | null; now: number; allowFuture?: boolean }) {
  if (!value || (!allowFuture && value > now)) return <>Not published or future time withheld</>;
  return <time className="owner-value" title={String(value)}>{utc(value, now) ?? 'Invalid owner time'}{value <= now ? ` · ${age((now - value) / 1000)} ago` : ''}</time>;
}

function Money({ value }: { value: string | number | null | undefined }) {
  return value == null ? <>Not published</> : ownerDisplay(value, 'usdc').tone === 'zero' ? <><OwnerValue value={value} kind="signed" digits={0} /> USD</> : <OwnerValue value={value} kind="usdc" unit="USD" />;
}

function Report({ report, now }: { report: V5TaskReport; now: number }) {
  const presentation = reportPresentation(report, now);
  const result = report.record?.result;
  const visible = presentation === 'historical';
  return <article className="v5-decision-row" data-freshness={presentation}>
    <div className="v5-decision-header"><strong>{TASKS[report.task_id] ?? 'Unknown agent'}</strong><span>{presentation === 'future' ? 'Future report withheld' : presentation === 'expired' ? 'Expired report · values withheld' : presentation === 'withheld' ? 'Report values withheld' : 'Stale or historical report · current validity not published'}</span></div>
    {presentation !== 'future' && presentation !== 'withheld' && <p><Time value={result?.received_at_ms ?? result?.requested_at_ms} now={now} /></p>}
    {presentation === 'withheld' && <p>{result ? 'The report time is missing or invalid; a usable advisor time is needed to show its values.' : 'The advisor has not published a result for this request; a completed result would appear here.'}</p>}
    {presentation === 'expired' && <p>Expired: <Time value={result?.expires_at_ms} now={now} /></p>}
    {visible && result ? <>
      <p><strong>{result.status ?? 'Status not published'}</strong> · {result.advice?.assessment ?? 'Assessment not published'}</p>
      <p>{result.advice?.summary || result.reason || 'The advisor did not publish a summary; a completed report would fill this field.'}</p>
      <p>Reason codes: {result.advice?.reason_codes?.join(', ') || 'Not published; the advisor can include them in a report.'}</p>
      <p>Coverage: {result.coverage_status ?? 'Not published'} · Model: {result.model ?? 'Not published'} · Cost: <Money value={result.actual_usd} /></p>
      <p>Expiry: <Time value={result.expires_at_ms} now={now} allowFuture /> · Validity: not published for history</p>
      {result.rejection && <p>Rejection: {result.rejection}</p>}
      <details><summary>Report details</summary>
        <p>Evidence: {result.advice?.evidence_refs?.join(', ') || 'Not published; advisor evidence references would appear here.'}</p>
        <p>Request ID: {report.record?.request_id ?? 'Not published'} · Snapshot ID: {report.record?.snapshot_id ?? 'Not published'}</p>
        <p>Requested: <Time value={result.requested_at_ms} now={now} /> · Received: <Time value={result.received_at_ms} now={now} /></p>
      </details>
    </> : presentation === 'historical' && <p>The advisor has not published a result for this request; a completed result would appear here.</p>}
  </article>;
}

export function AgentDecisionsPage() {
  const now = usePaperClock();
  const [task, setTask] = useState('all');
  const [status, setStatus] = useState('all');
  const workspace = useQuery({ queryKey: ['v5-workspace'], queryFn: v5Api.workspace, refetchInterval: 30_000 });
  const histories = useQueries({ queries: Object.keys(TASKS).map(taskId => ({ queryKey: ['v5-advisor-history', taskId], queryFn: () => v5Api.advisorHistory(taskId), refetchInterval: 30_000 })) });
  const reports = histories.flatMap(query => !query.isError && query.data?.effect === 'NONE' && Array.isArray(query.data.records) ? query.data.records : []);
  const statuses = Array.from(new Set(reports.filter(report => reportPresentation(report, now) === 'historical').flatMap(report => [report.record?.result?.status, report.record?.result?.advice?.assessment].filter((value): value is string => Boolean(value))))).sort();
  const selected = selectReports(reports, task, status, now);
  const advisor = !workspace.isError && !workspace.data?.source_error?.includes('advisor:') ? workspace.data?.advisor : undefined;
  const scheduler = advisor?.scheduler;
  return <div className="v5-agent-decisions">
    <Link to="/agents">Back to agents</Link>
    <h1>Agent decisions</h1>
    <p>Advisor reports are reports-only; they do not place or block orders. The link from a report to a bot action is not published yet.</p>
    <section className="v5-panel"><h2>Budget and scheduler</h2>
      {advisor ? <div className="v5-decisions-budget"><p>Owner usage snapshot · observation time not published</p>
        <p>Calls today: {advisor.calls_today == null ? 'Not published' : <span className="owner-value" title={String(advisor.calls_today)}>{count(advisor.calls_today)}</span>} · Spent: <Money value={advisor.spent_usd} /> · Reserved: <Money value={advisor.reserved_usd} /></p>
        <p>Daily budget: <Money value={advisor.budget_policy?.daily_usd} /> · Pilot budget: <Money value={advisor.budget_policy?.pilot_usd} /> · Ceiling: <Money value={advisor.budget_policy?.authorized_ceiling_usd} /> · Remaining: <Money value={advisor.budget_policy?.remaining_pilot_usd} /></p>
        <p>Scheduler status: {scheduler?.last_attempt_ms && scheduler.last_attempt_ms > now ? 'Future value withheld' : scheduler?.last_status ?? 'Not published'} · Task: {scheduler?.last_attempt_ms && scheduler.last_attempt_ms > now ? 'Future value withheld' : scheduler?.task_id ?? 'Not published'} · Last attempt: <Time value={scheduler?.last_attempt_ms} now={now} /></p>
        <p>Missing budget or scheduler values appear when the advisor publishes them.</p>
      </div> : <p>The advisor budget and scheduler are unavailable; a workspace owner response would fill this panel.</p>}
    </section>
    <section className="v5-panel"><h2>Report timeline</h2>
      <p>Only the latest report from each agent is shown for now. Older reports are not shown yet: the advisor sends each report together with its full input, so only one report fits in a read. When the advisor publishes a slimmer history, the full timeline will appear here.</p>
      <div className="v5-decisions-filters"><label>Agent<select value={task} onChange={event => setTask(event.target.value)}><option value="all">All agents</option>{Object.entries(TASKS as Record<string, string>).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select></label>
        <label>Outcome or status<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option>{statuses.map(item => <option key={item} value={item}>{item}</option>)}</select></label></div>
      <p>Coin filter not published by the advisor; reports with coin data would be needed to filter by coin.</p>
      {histories.some(query => query.isPending) && <p role="status">Loading advisor history…</p>}
      {histories.some(query => query.isError) && <p role="alert">Some advisor history is unavailable; a successful owner history read would fill the missing reports.</p>}
      {selected.map((report, index) => <Report key={`${report.task_id}-${report.record?.request_id ?? index}`} report={report} now={now} />)}
      {!selected.length && !histories.some(query => query.isPending) && <p>No reports match the available history and filters; advisor reports or different filters would fill this timeline.</p>}
    </section>
  </div>;
}
