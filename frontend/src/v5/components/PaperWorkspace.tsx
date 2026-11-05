import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import type { PaperRead } from '@/v5/contracts';
import { paperAmount, paperRetainedRecords, paperControlState, paperExactAmount, paperLifetimeTotals, paperOpenExecutorCount, paperOrderCount, paperPairObservation, paperReadState, paperRiskHolds, paperExitProjection, paperRiskUsage, paperRiskControllers, paperSectionError, paperSnapshotsAgree, paperTime, paperWalletInventory, paperWalletTotals, paperWords } from '@/v5/policy';
import { PaperTerminalHistory } from '@/v5/PaperTerminalHistory';
import { paperSnapshotPresentation } from '@/v5/snapshot-presentation';
import { MetricCard, PanelFrame, StatStrip } from '@/features/quant-ops/primitives';
import type { PanelState } from '@/features/quant-ops/panel-state';
import { TileGrid } from '@/features/quant-ops/kit/grid';
import { DataTable, type TableColumn } from '@/features/quant-ops/kit/DataTable';
import '@/components/bots/fleet-strip.css';
import './PaperWorkspace.css';

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

function PaperBadge({ children, state }: { children: ReactNode; state?: string }) {
  return <span className="paper-badge" data-state={state}>{children}</span>;
}

function paperPanelState(read: PaperRead | undefined, now: number): PanelState {
  const state = paperReadState(read, now);
  return { kind: !read ? 'collecting' : state === 'available' ? 'fresh' : state === 'degraded' || state === 'not_applicable' ? 'incomplete' : state,
    reason: read?.reason ?? undefined };
}

function PaperMetric({ label, value, note, exact, state }: { label: string; value: string; note?: string; exact?: string; state?: PanelState }) {
  return <div className="paper-metric-view"><MetricCard panelId={`paper-${label.toLowerCase().replaceAll(' ', '-')}`} title={label} value={value} note={note} state={state} />
    {exact && exact !== 'Not published' && <details className="paper-exact"><summary>Exact {label}</summary><p>{exact}</p><p>Owner decimal · no rounding</p></details>}</div>;
}

/** The native rail publishes percent points. Convert once for the kit's ratio contract. */
function PaperRailUsage({ value, label }: { value: unknown; label: string }) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return <p className="paper-caption">Use not published</p>;
  return <><StatStrip panelId="paper-rail-use" ariaLabel={`${label} use`} tiles={[{id:'paper-rail-percent',label:'Owner rail use',value:String(value / 100),unit:'%',state:{kind:'fresh'}}]} />
    <progress max={100} value={value} aria-label={`${label} use`} /></>;
}

/** Summarize the displayed sections, never process liveness or HTTP receipt. */
function PaperObservationSummary({ reads, accountingRead, now, bot }: { reads: PaperRead[]; accountingRead?: PaperRead; now: number; bot: string }) {
  const sections = ['status', 'wallet', 'positions', 'fills', 'executors', 'risk', 'decisions', 'history'];
  const parts = [...sections.map(section => reads.find(read => read.section === section)), accountingRead];
  const present = parts.filter((read): read is PaperRead => read !== undefined);
  const bound = present.length === parts.length && paperSnapshotsAgree(present) && present.every(read => read.bot_id === bot && read.completeness === 'complete' && !read.next_cursor);
  const states = parts.map(read => paperPanelState(read, now));
  const kind = states.some(state => state.kind === 'stale') ? 'stale' : !bound || states.some(state => state.kind !== 'fresh') ? 'incomplete' : 'fresh';
  const label = kind === 'stale' ? 'Stale owner sections' : kind === 'incomplete' ? 'Incomplete owner sections' : 'Available owner sections';
  return <PanelFrame panelId="paper-observation-summary" title={label} state={{kind}}>
    <p className="paper-caption">{paperSnapshotPresentation(reads.find(read => read.section === 'status')?.generated_at_ms, now, false).label}. Section availability and process heartbeat remain separate.</p>
    {!bound && <p className="paper-caption">Owner and snapshot binding is incomplete. No aggregate freshness is inferred.</p>}
    <details><summary>Inspect owner sections</summary><dl className="paper-detail">{parts.map((read,index) => <div className="paper-exact-row" key={sections[index] ?? 'accounting'}><dt>{paperWords(sections[index] ?? 'accounting')}</dt><dd>{paperWords(read ? paperReadState(read,now) : 'collecting')} · {paperTime(read?.source_at_ms ?? read?.generated_at_ms,now)}{read?.reason ? ` · ${paperWords(read.reason)}` : ''}<br />Owner: {read?.bot_id ?? 'Not published'} · Snapshot: {read?.snapshot_id ?? 'Not published'}</dd></div>)}</dl></details>
  </PanelFrame>;
}

function PaperRecords({ read, positions, executors, now, kind }: { read?: PaperRead; positions?: PaperRead; executors?: PaperRead; now: number; kind: "fills" | "executors" | "positions" }) {
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState(false);
  const completeRows = paperRetainedRecords(read, now);
  const rows = completeRows ?? [];
  const idKey = kind === "fills" ? "trade_id" : kind === "positions" ? "position_id" : "executor_id";
  const unit = (row: PaperRow) => typeof row.unit === "string" ? row.unit : "USDC";
  const base = (row: PaperRow) => String(row.trading_pair ?? "").split("-")[0] || "base units";
  const columns: TableColumn<PaperRow>[] = [
    { id: "id", header: kind === "fills" ? "Fill ID" : kind === "positions" ? "Position ID" : "Executor ID", value: row => String(row[idKey] ?? "Not published"), size: 180, cell: row => <button className="paper-copy" onClick={() => { const id = String(row[idKey] ?? ""); void navigator.clipboard.writeText(id).then(() => { setCopied(id); setCopyError(false); }, () => setCopyError(true)); }} title="Copy full owner ID">{copied === row[idKey] ? "Copied" : String(row[idKey] ?? "Not published")}</button> },
    { id: "pair", header: "Pair", value: row => String(row.trading_pair ?? "Not published"), size: 130 },
    { id: "state", header: kind === "fills" ? "Side" : "State", value: row => (row.side ?? row.state) as string | null, cell: row => paperWords(row.side ?? row.state), size: 150 },
    { id: "quantity", header: kind === "executors" ? "Remaining close" : "Quantity", value: row => (kind === "executors" ? row.remaining_close_quantity : row.quantity) as string | null, cell: row => paperAmount(kind === "executors" ? row.remaining_close_quantity : row.quantity, base(row), 6), size: 180 },
    ...(kind === "fills" ? [
      { id: "price", header: "Fill price", value: (row: PaperRow) => row.price as string | null, cell: (row: PaperRow) => paperAmount(row.price, "USDC"), size: 160 },
      { id: "fee", header: "Fee", value: (row: PaperRow) => row.fee_amount as string | null, cell: (row: PaperRow) => paperAmount(row.fee_amount, String(row.fee_currency ?? "unit not published")), size: 160 },
      { id: "time", header: "Filled at · UTC", value: (row: PaperRow) => row.event_at_ms as number | null, cell: (row: PaperRow) => paperTime(row.event_at_ms, now), size: 330 },
    ] : [{ id: "basis", header: "Remaining basis", value: (row: PaperRow) => row.remaining_basis_quote as string | null, cell: (row: PaperRow) => paperAmount(row.remaining_basis_quote, unit(row)), size: 175 }]),
    ...(kind === "executors" ? [
      { id: "realized", header: "Realized PnL", value: (row: PaperRow) => row.realized_pnl_quote as string | null, cell: (row: PaperRow) => paperAmount(row.realized_pnl_quote, unit(row), 6), size: 180 },
      { id: "unrealized", header: "Unrealized PnL", value: (row: PaperRow) => row.unrealized_pnl_quote as string | null, cell: (row: PaperRow) => paperAmount(row.unrealized_pnl_quote, unit(row), 6), size: 180 },
      { id: "closed", header: "Closed at · UTC", value: (row: PaperRow) => row.close_at_ms as number | null, cell: (row: PaperRow) => paperTime(row.close_at_ms, now), size: 330 },
    ] : []),
    { id: "detail", header: "Owner detail", value: row => String(row.executor_id ?? ""), size: 340, wrap: true, cell: row => <details><summary>Expand record</summary><dl className="paper-detail"><dt>Executor</dt><dd>{String(row.executor_id ?? "Not published")}</dd><dt>Controller</dt><dd>{String(row.controller_id ?? "Not published")}</dd>{kind !== 'executors' && <><dt>Exact owner values</dt><dd>No rounding</dd>{(kind === 'fills' ? [['quantity',base(row)],['price','USDC'],['fee_amount',String(row.fee_currency ?? 'unit not published')]] : [['quantity',base(row)],['remaining_basis_quote',unit(row)]]).map(([field,quote]) => <div className="paper-exact-row" key={field}><dt>{paperWords(field)}</dt><dd>{paperExactAmount(row[field],quote)}</dd></div>)}</>}{kind === "positions" && <><dt>Protected exit</dt><dd>{paperExitProjection(row, positions, executors, now).verified ? paperWords(paperExitProjection(row, positions, executors, now).protectedExit) : paperExitProjection(row, positions, executors, now).reason}</dd></>}{kind === "executors" && <><dt>Terminal receipt</dt><dd>{paperWords(row.terminal)}</dd><dt>Close reason</dt><dd>{paperWords(row.close_type)}</dd><dt>Exact owner values</dt><dd>No rounding</dd><dt>Remaining basis</dt><dd>{paperExactAmount(row.remaining_basis_quote, unit(row))}</dd><dt>Remaining close</dt><dd>{paperExactAmount(row.remaining_close_quantity, base(row))}</dd><dt>Residual inventory</dt><dd>{paperExactAmount(row.quantity, base(row))}</dd><dt>Realized PnL</dt><dd>{paperExactAmount(row.realized_pnl_quote, unit(row))}</dd><dt>Unrealized PnL</dt><dd>{paperExactAmount(row.unrealized_pnl_quote, unit(row))}</dd><dt>Fees paid</dt><dd>{paperExactAmount(row.cum_fees_quote, unit(row))}</dd></>}</dl></details> },
  ];
  return <section className="paper-section"><div className="paper-section-heading"><h2>{kind === "positions" ? "Holdings" : kind === "fills" ? "Recent fills" : "Executors"}</h2><PaperBadge state={read ? paperReadState(read, now) : "collecting"}>{paperWords(read ? paperReadState(read, now) : "collecting")}</PaperBadge></div><p className="paper-caption">{paperTime(read?.generated_at_ms, now)} · Bounded owner records, not lifetime totals. Search, filter or resize columns.</p>{read?.completeness === "partial" && <p className="paper-caption">Partial retained window · not lifetime history. Fills retain at most 500 rows; executors retain active rows and at most 100 closed rows. Paging restores only this owner window. Counts describe displayed rows, not complete totals.</p>}{read?.reason && <p className="paper-caption">{paperWords(read.reason)}</p>}{completeRows === null ? <p className="paper-caption">Incomplete or stale owner read. Record counts and totals are not published.</p> : <DataTable rows={rows} columns={columns} rowId={(row, index) => String(row[idKey] ?? index)} label={`Paper ${kind}`} pageSize={8} emptyText={read?.data == null ? "Owner records are not available in this snapshot." : read.completeness === "partial" ? "No rows in this partial window; absence does not prove no activity." : "No records in this owner snapshot."} maxHeight={360} exportName={`paper-${kind}`} exportMetadata={{bot:read?.bot_id ?? null,snapshot:read?.snapshot_id ?? null,quantity_unit:base,quote_unit:unit,fee_unit:row => String(row.fee_currency ?? "Not published"),execution_mode:read?.execution_mode ?? null,generated_at_ms:read?.generated_at_ms ?? null}} />}{read?.next_cursor && <p className="paper-caption">More records exist beyond this page; totals must not be inferred from these rows.</p>}{copyError && <p role="alert">Copy was unavailable. Select the owner ID to copy it manually.</p>}</section>;
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

/** Render one controller row from all received safety evidence. Retention owns supersession. */
function paperHeldControllers(reads: PaperRead[], now: number) {
  type Controller = NonNullable<ReturnType<typeof paperRiskControllers>>[number];
  const controllers = new Map<string, Controller>();
  const flag = (left: unknown, right: unknown) => left === true || right === true ? true : left === false && right === false ? false : undefined;
  for (const read of reads) for (const controller of paperRiskControllers(read, now) ?? []) {
    // Newer owner adapters expose entryHold; preserve the pinned adapter's published field too.
    const entryHold = (controller as Controller & { entryHold?: boolean | null }).entryHold;
    const received: Controller = { ...controller, operator: { ...controller.operator }, native: { ...controller.native,
      entry_hold: typeof entryHold === 'boolean' ? entryHold : controller.native.entry_hold } };
    const prior = controllers.get(controller.id);
    controllers.set(controller.id, !prior ? received : { ...received,
      current: prior.current && received.current,
      operator: { ...received.operator, paused: flag(prior.operator.paused, received.operator.paused), emergency: flag(prior.operator.emergency, received.operator.emergency) },
      native: { ...received.native, entry_hold: flag(prior.native.entry_hold, received.native.entry_hold), latched: flag(prior.native.latched, received.native.latched) },
      holds: [...new Map([...prior.holds, ...received.holds].map(hold => [JSON.stringify([hold.reason, hold.explanation, hold.protected_exits]), hold])).values()],
    });
  }
  return [...controllers.values()];
}

export function PaperWorkspace({ reads, safetyReads = [], accountingRead, accountingError = false, complete = true, readFailed = false, now, reportAt, heartbeat, bot }: { reads: PaperRead[]; safetyReads?: PaperRead[]; accountingRead?: PaperRead; accountingError?: boolean; complete?: boolean; readFailed?: boolean; now: number; reportAt: number | null; heartbeat: string; bot: string }) {
  const riskEvidence = [...new Set([...reads.filter(read => read.section === 'risk'), ...safetyReads])];
  const holds = [...new Map(riskEvidence.flatMap(read => paperRiskHolds(read)).map(hold => [hold.reason, hold])).values()];
  const hold = holds.length > 0;
  const errors = reads.map(read => paperSectionError(read) ?? (typeof read.reason === "string" && read.reason.includes("schema invalid") ? read.reason : null)).filter(Boolean);
  reads = reads.map(read => paperSectionError(read) ? { schema: "rsibot.v5-paper.read.v1", section: typeof read.section === "string" ? read.section : "unknown", state: "degraded", execution_mode: "paper", simulated: true, bot_id: null, snapshot_id: null, generated_at_ms: null, data: null, reason: paperSectionError(read), completeness: "unavailable" } : read);
  const bySection = Object.fromEntries(reads.map(read => [read.section, read]));
  const resetKey = reads.map(read => `${read.section}:${read.snapshot_id}:${read.state}`).join("|");
  const wallet = paperObject(bySection.wallet?.data);
  const walletTotals = complete ? paperWalletTotals(bySection.wallet, now) : null;
  const inventory = complete ? paperWalletInventory(bySection.wallet, now) : null;
  const accounting = complete ? paperLifetimeTotals(accountingRead, reads[0], now) : null;
  const accountingState = accountingRead ? paperReadState(accountingRead, now) : "collecting";
  const accountingNote = accounting ? "Lifetime · native receipts" : accountingError ? "Lifetime · owner read unavailable" : accountingState === "stale" ? "Lifetime · owner snapshot is stale" : accountingState === "degraded" ? "Lifetime · owner totals are incomplete" : "Lifetime · awaiting coherent owner totals";
  const openExecutors = complete ? paperOpenExecutorCount(bySection.executors, now) : null;
  const decisions = paperObject(bySection.decisions?.data);
  const risk = paperObject(bySection.risk?.data);
  const rails = complete ? paperRiskUsage(bySection.risk, now) ?? [] : [];
  const riskControllers = paperRiskControllers(bySection.risk, now);
  const safetyControllers = paperHeldControllers(riskEvidence, now);
  const entryHoldObserved = hold || safetyControllers.some(controller => controller.holds.length || controller.operator.paused === true || controller.operator.emergency === true || controller.native.entry_hold === true || controller.native.latched === true);
  return <div data-paper-workspace>
    {complete && <PaperObservationSummary reads={reads} accountingRead={accountingRead} now={now} bot={bot} />}
    {errors.map(error => <section className="v5-error-panel" role="alert" key={error}>{error}</section>)}
    {entryHoldObserved && <PaperIsolatedSection name="Entry hold" resetKey={resetKey} render={() => <aside className="paper-fleet" role="status"><div className="paper-section-heading"><h2>New acquisitions held</h2><PaperBadge state="degraded">{safetyControllers.some(controller => controller.operator.emergency === true) ? "Emergency halt reported" : "Owner action required"}</PaperBadge></div><div className="paper-rails">{holds.map(item => <article key={item.reason}><h3>{item.label}</h3><p>{item.explanation}</p><p className="paper-caption">{item.action}</p></article>)}</div>{safetyControllers.filter(controller => controller.holds.length || controller.operator.paused === true || controller.operator.emergency === true || controller.native.entry_hold === true || controller.native.latched === true).map(controller => <article key={controller.id}><h3>{controller.id}</h3><PaperBadge state="degraded">New entries held</PaperBadge><p>Reported operator pause: {controller.operator.paused === true ? "Yes" : controller.operator.paused === false ? "No" : "Not published"} · Reported emergency halt: {controller.operator.emergency === true ? "Yes" : controller.operator.emergency === false ? "No" : "Not published"} · Reported native entry hold: {controller.native.entry_hold === true ? "Yes" : controller.native.entry_hold === false ? "No" : "Not published"}{controller.native.latched === true && " · Reported native entry latch: Yes"}</p>{controller.holds.map(item => <p key={JSON.stringify([item.reason,item.explanation])}>{item.explanation} Protective exits: preserved.</p>)}</article>)}<p className="paper-caption">Received and retained safety evidence can differ from the displayed data snapshot. Omitted controllers remain unknown, not cleared. Only qualified newer evidence for that controller or owner hold list can supersede a received hold.</p><p className="paper-caption">Clock high-water mark: {paperTime(paperObject(risk.clock_recovery).high_water_ms, now)}. Order protection is verified per position below.</p></aside>} /> }
    {!complete ? readFailed ? <section className="paper-section" role="status"><h2>Owner snapshot unavailable</h2><p>The read failed before a complete owner snapshot arrived. Received safety evidence remains visible. No absent controls or capital totals are inferred.</p></section> : <section className="paper-section" role="status"><h2>Checking owner snapshot</h2><p>Risk controls and numeric rail limits are pending until the complete owner snapshot arrives. No absent controls or capital totals are inferred.</p><ul>{["status", "wallet", "positions", "fills", "executors", "risk", "decisions", "history", "accounting"].map(section => <li key={section}>{paperWords(section)}: {bySection[section] ? "Received · awaiting complete snapshot" : "Pending"}</li>)}</ul></section> : <>
    <PaperIsolatedSection name="Paper fleet" resetKey={resetKey} render={() => <PanelFrame panelId="paper-fleet" title="Paper fleet" scopeLabel="SIMULATED ACCOUNT" actions={<PaperBadge state={heartbeat === "Fresh" ? "available" : "stale"}>{heartbeat} · heartbeat</PaperBadge>}><p className="paper-caption">{bot} · Valuation: {paperWords(wallet.valuation_policy)}. Book freshness and completeness are separate from process heartbeat.</p><TileGrid label="Paper fleet metrics" min={230}>
      <PaperMetric label="Wallet equity" value={paperAmount(walletTotals?.equity, "USDC")} state={paperPanelState(bySection.wallet,now)} exact={paperExactAmount(walletTotals?.equity,"USDC")} note={walletTotals ? "Fresh complete owner wallet" : "Fresh complete wallet required"} />
      <PaperMetric label="Available cash" value={paperAmount(walletTotals?.cash, "USDC")} state={paperPanelState(bySection.wallet,now)} exact={paperExactAmount(walletTotals?.cash,"USDC")} />
      <PaperMetric label="Holdings value" value={inventory ? paperAmount(inventory.value, inventory.unit, 2) : "Not published"} state={paperPanelState(bySection.wallet,now)} exact={inventory ? paperExactAmount(inventory.value,inventory.unit) : "Not published"} note={inventory ? `${paperReadState(bySection.wallet, now) === "stale" ? "Stale valuation · " : ""}Valuation: ${inventory.basis} · As of ${paperTime(inventory.asOf, now)} · Wallet marks, excluding cash` : "Complete current wallet marks not published"} />
      <PaperMetric label="Open executors" state={paperPanelState(bySection.executors,now)} value={openExecutors === null ? "Not published" : String(openExecutors)} note={openExecutors === null ? "Incomplete or stale owner read · count not inferred" : "Fresh complete owner snapshot · excludes terminal receipts"} />
      <PaperMetric label="Realized PnL" value={paperAmount(accounting?.realized_pnl_quote, "USDC")} state={paperPanelState(accountingRead,now)} exact={paperExactAmount(accounting?.realized_pnl_quote,"USDC")} note={accountingNote} />
      <PaperMetric label="Unrealized PnL" value={paperAmount(accounting?.unrealized_pnl_quote, "USDC")} state={paperPanelState(accountingRead,now)} exact={paperExactAmount(accounting?.unrealized_pnl_quote,"USDC")} note={accountingNote} />
      <PaperMetric label="Fees paid" value={paperAmount(accounting?.fees_paid_quote, "USDC")} state={paperPanelState(accountingRead,now)} exact={paperExactAmount(accounting?.fees_paid_quote,"USDC")} note={accountingNote} />
      <PaperMetric label="Traded volume" value={paperAmount(accounting?.volume_traded_quote, "USDC")} state={paperPanelState(accountingRead,now)} exact={paperExactAmount(accounting?.volume_traded_quote,"USDC")} note={accountingNote} />
      <PaperMetric label="Last report" value={paperTime(reportAt, now)} note="Native process heartbeat" />
    </TileGrid><p className="paper-caption">{accounting ? <>Filled orders: {paperOrderCount(accounting.entry_count, "entry")} · {paperOrderCount(accounting.exit_count, "exit")}. Accounting since: {paperTime(accounting.accounting_since_ms, now)}. Counts are distinct filled orders, not actions.</> : <>Lifetime accounting: {accountingError ? "Owner read unavailable; no totals are inferred from recent fills." : paperWords(accountingRead?.reason ?? "Collecting the snapshot-bound owner aggregate; no totals are inferred from recent fills.")}</>}</p></PanelFrame>} />
    <PaperIsolatedSection name="Pair workspace" resetKey={resetKey} render={() => <section className="paper-section"><div className="paper-section-heading"><h2>Pair workspace</h2><span className="paper-caption">5 pairs · same fixed-target recipe</span></div><div className="paper-pairs">{["BNB-USDC", "BTC-USDC", "ETH-USDC", "SOL-USDC", "XRP-USDC"].map(pair => {
      const { position, executor, knownFlat, lastReportedFlat, staleSince, decision } = paperPairObservation(pair, bySection.positions, bySection.executors, bySection.decisions, now);
      const exit = paperExitProjection(position, bySection.positions, bySection.executors, now);
      const pairStates = [paperReadState(bySection.positions, now), paperReadState(bySection.executors, now)];
      const pairState = pairStates.includes("stale") ? "stale" : pairStates.every(state => state === "available") ? "available" : "degraded";
      return <article className="paper-pair" key={pair}><div className="paper-section-heading"><h3>{pair}</h3><PaperBadge state={pairState}>{pairState === "stale" ? "Stale · " : pairState === "degraded" ? "Incomplete · " : ""}{position ? paperWords(position.state) : knownFlat ? "No position" : lastReportedFlat ? "No position in last report" : executor ? paperWords(executor.state) : "Not published"}</PaperBadge></div><p className="paper-caption">Position as of {paperTime(bySection.positions?.source_at_ms ?? bySection.positions?.generated_at_ms, now)}</p>{knownFlat ? <p className="paper-caption">No position · waiting for entry signal</p> : lastReportedFlat ? <p className="paper-caption">No position in last report · stale since {paperTime(staleSince, now)}</p> : <><dl className="paper-detail"><dt>Position</dt><dd>{position ? paperAmount(position.quantity, pair.split("-")[0], 6) : "Not published"}</dd></dl>{!exit.verified ? <p className="paper-caption">{exit.reason}</p> : <dl className="paper-detail"><dt>Target price</dt><dd>{exit.targetPrice != null ? <>{paperAmount(exit.targetPrice, "USDC")}<span className="paper-caption" style={{ display: "block" }}>{exit.basis}</span></> : exit.reason}</dd><dt>Exit progress</dt><dd>{exit.order ? <>{paperWords(exit.order.state)} · {paperExactAmount(exit.remainingAmount, pair.split("-")[0])} remaining<span className="paper-caption" style={{ display: "block" }}>Order {String(exit.order.order_id ?? "pending")} · LIMIT {paperExactAmount(exit.order.price, "USDC")}<br />Placed {paperTime(exit.order.placed_at_ms, now)}</span></> : "Owner protected exit order not published"}</dd><dt>Protected exit</dt><dd>{paperWords(exit.protectedExit)}</dd></dl>}</>}{decision && <p className="paper-caption">Latest decision: {paperWords(decision.status)}{decision.reason ? ` · ${paperWords(decision.reason)}` : ""}{decision.event_at_ms != null ? ` · ${paperTime(decision.event_at_ms, now)}` : ""}</p>}</article>;
    })}</div></section>} />
    {complete && <PaperIsolatedSection name="Pair charts" resetKey={resetKey} render={() => <section className="paper-section" id={`paper-charts-${bot}`} aria-label="Paper strategy charts"><div className="paper-section-heading"><h2>Pair charts</h2><span className="paper-caption">Native closed candles only · no inferred prices</span></div><Suspense fallback={<p role="status">Loading paper chart workspace…</p>}><PaperStrategyCharts bot={bot} server="rsibot-v5" observations={reads} /></Suspense></section>} />}
    <PaperIsolatedSection name="Positions" resetKey={resetKey} render={() => <PaperRecords read={bySection.positions} positions={bySection.positions} executors={bySection.executors} kind="positions" now={now} />} />
    <PaperIsolatedSection name="Fills" resetKey={resetKey} render={() => <PaperRecords read={bySection.fills} kind="fills" now={now} />} />
    <PaperIsolatedSection name="Executors" resetKey={resetKey} render={() => <PaperRecords read={bySection.executors} kind="executors" now={now} />} />
    <PaperIsolatedSection name="Terminal history" resetKey={resetKey} render={() => <PaperTerminalHistory read={bySection.history} now={now} />} />
    {riskControllers && <PaperIsolatedSection name="Controller entry controls" resetKey={resetKey} render={() => <section className="paper-section"><div className="paper-section-heading"><h2>Controller entry controls</h2><PaperBadge state={paperReadState(bySection.risk, now)}>{paperWords(paperReadState(bySection.risk, now))} owner report</PaperBadge></div><p className="paper-caption">Report as of {paperTime(bySection.risk?.source_at_ms ?? bySection.risk?.generated_at_ms, now)}. Entry holds never authorize a forced sale.</p><div className="paper-rails">{riskControllers.map(controller => <article className="paper-pair" key={controller.id}><h3>{controller.id}</h3><PaperBadge state={controller.holds.length || controller.operator.paused === true || controller.operator.emergency === true || controller.native.entry_hold === true || !controller.current || controller.native.complete !== true ? "degraded" : "available"}>{controller.holds.length || controller.operator.paused === true || controller.operator.emergency === true || controller.native.entry_hold === true ? "New entries held" : !controller.current ? "Current entry state unknown" : controller.native.complete === true ? "Native evidence complete" : "Native evidence incomplete"}</PaperBadge><p>Reported operator pause: {controller.operator.paused === true ? "Yes" : controller.operator.paused === false ? "No" : "Not published"} · Reported emergency halt: {controller.operator.emergency === true ? "Yes" : controller.operator.emergency === false ? "No" : "Not published"}</p>{controller.holds.map(hold => <p key={hold.reason}>{hold.explanation} Protective exits: preserved.</p>)}</article>)}</div></section>} />}
    <PaperIsolatedSection name="Risk rails" resetKey={resetKey} render={() => <section className="paper-section"><div className="paper-section-heading"><h2>Risk rails & entry latch</h2><PaperBadge state={paperReadState(bySection.risk, now)}>{paperWords(paperReadState(bySection.risk, now))}</PaperBadge></div><p className="paper-caption">{(riskControllers ? `Controller entry observations are shown above.${rails.length ? "" : " Numeric rail limits are not published"}` : paperWords(bySection.risk?.reason ?? "controls_not_integrated")).replace(/[.!?]+$/, "")}. Loss rails stop new acquisitions, never force a sale.</p><div className="paper-rails">{rails.length ? rails.map((rail, index) => <article className="paper-pair" key={index}><h3>{paperWords(rail.label)}</h3><p>{paperAmount(rail.used_quote, "USDC")} of {paperAmount(rail.limit_quote, "USDC")}</p><PaperRailUsage value={rail.used_percent} label={paperWords(rail.label)} /></article>) : ["Pair exposure", "Program exposure", "New acquisitions"].map(label => <article className="paper-pair" key={label}><h3>{label}</h3><PaperBadge>{entryHoldObserved && label === "New acquisitions" ? "Held by owner" : "Not connected"}</PaperBadge><div className="paper-empty-rail" aria-hidden="true" /><p className="paper-caption">{entryHoldObserved && label === "New acquisitions" ? "The owner reports an entry hold. Review the controller evidence and owner clearing procedure above; protection is verified per position." : "No owner limit or latch observation. No use bar is inferred."}</p></article>)}</div></section>} />
    <PaperIsolatedSection name="Decisions and paper control" resetKey={resetKey} render={() => <section className="paper-section"><h2>Decisions & paper control</h2><div className="paper-rails"><article><h3>Exit policy</h3><p>{paperWords(paperObject(decisions.trailing).reason)}</p><p>Underwater positions remain held. Protective exits must survive entry halt.</p></article><article><h3>Acquisition plan</h3><p>{paperWords(paperObject(decisions.dca).reason)}</p><p>Comparable history: {paperWords(paperObject(bySection.history?.data).reason)}</p></article><article><h3>{paperControlState(null)}</h3><p>Read-only dashboard. A separately authenticated owner path must acknowledge paper commands before controls can appear here.</p></article></div><details className="paper-provenance"><summary>Observation provenance</summary><p>Snapshot: {reads[0]?.snapshot_id ?? "Not published"}</p><p>Observed: {paperTime(reads[0]?.generated_at_ms, now)}</p></details></section>} />
    </>}
  </div>;
}
