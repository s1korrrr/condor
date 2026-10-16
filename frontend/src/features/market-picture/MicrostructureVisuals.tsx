import { useId, useMemo, useState } from "react";
import { BarsChart } from "@/features/quant-ops/kit/charts";
import { CHART } from "@/features/quant-ops/kit/series";
import type { DisplayFlowObservation, DisplayFrame, DisplayLiquidityObservation } from "./presentation";
import { bookCohorts, flowCohorts, projectBookSelection, projectFlowSelection, type BookCohort, type FlowCohort } from "./microstructure-visuals.mjs";

type VisualKind = "flow" | "liquidity";
const asUtc = (time: number) => Number.isFinite(time) ? new Date(time).toISOString() : "invalid time";
const conciseUtc = (time: number) => Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 16).replace("T", " ")}Z` : "invalid time";
const keyOf = (value: object) => JSON.stringify(value);
const EMPTY_FLOWS: DisplayFlowObservation[] = [];
const EMPTY_BOOKS: DisplayLiquidityObservation[] = [];
const pair = (instrumentId: string) => instrumentId.split(":").at(-1) ?? instrumentId;
const shortSource = (sourceId: string) => sourceId.split(/[/:]/).at(-1) ?? sourceId;
const duration = (windowMs: number) => windowMs % 60_000 === 0 ? `${windowMs / 60_000}m` : windowMs % 1_000 === 0 ? `${windowMs / 1_000}s` : `${windowMs}ms`;
const flowKey = (row: FlowCohort) => JSON.stringify([row.instrumentId, row.sourceId, row.channel, row.quoteAsset, row.windowMs]);
const optionLabel = (row: FlowCohort) => `${pair(row.instrumentId)} · ${shortSource(row.sourceId)} · ${conciseUtc(row.latestEnd)} · ${duration(row.windowMs)}`;
const bookOptionLabel = (row: BookCohort) => `${pair(row.instrumentId)} · ${shortSource(row.sourceId)} · ${row.channel} · ${conciseUtc(row.observed)} · ${row.sizeUnit}`;
const axisNumber = (value: number | null) => value == null ? "Unavailable" : new Intl.NumberFormat(undefined, {
  notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
  maximumSignificantDigits: 3,
}).format(value);
const flowColor = { buy: CHART.positive, sell: CHART.negative, unknown: CHART.neutral };

function FlowVisual({ frame, asOf, id }: { frame: DisplayFrame; asOf: number; id: string }) {
  const flows = frame.microstructure?.flows ?? EMPTY_FLOWS;
  const cohorts = useMemo(() => flowCohorts(flows), [flows]);
  const [selectedKey, setSelectedKey] = useState("");
  const cohort = cohorts.find(item => flowKey(item) === selectedKey) ?? cohorts[0];
  const projection = cohort ? projectFlowSelection(flows, cohort, frame, asOf) : null;
  const plotted = projection?.rows ?? [];
  const flowStates = Array.from(new Set(plotted.map(row => row.state))).map(state => `${state} (${plotted.filter(row => row.state === state).length})`).join(" · ") || "No rows";

  if (!cohorts.length || !cohort) return <article className="mp-visual-card" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Executed spot flow</h3><p>No executed-flow cohort is retained in this snapshot.</p>
  </article>;

  return <article className="mp-visual-card" aria-labelledby={`${id}-title`}>
    <header><h3 id={`${id}-title`}>Executed spot flow</h3><span className="mp-kicker">Recorded observation</span></header>
    <p>Recorded buy, sell, and unknown aggressor quote notional. Unknown is shown separately; no net cumulative delta is inferred.</p>
    <ul className="mp-visual-legend" aria-label="Flow chart series">
      <li><i aria-hidden="true" style={{ background: flowColor.buy }} />Buy quote notional ({cohort.quoteAsset})</li>
      <li><i aria-hidden="true" style={{ background: flowColor.sell }} />Sell quote notional ({cohort.quoteAsset})</li>
      <li><i aria-hidden="true" style={{ background: flowColor.unknown }} />Unknown aggressor quote notional ({cohort.quoteAsset})</li>
    </ul>
    <div className="mp-visual-controls"><label htmlFor={`${id}-cohort`}>Instrument · source · window</label>
    <select id={`${id}-cohort`} value={flowKey(cohort)} onChange={event => setSelectedKey(event.target.value)}>
      {cohorts.map(item => <option key={flowKey(item)} value={flowKey(item)}>{optionLabel(item)}</option>)}
    </select></div>
    <p>{frame.source_kind} · observed {conciseUtc(frame.cutoff_ms)} · assessed {conciseUtc(asOf)} · {duration(cohort.windowMs)} window · {projection?.plottedCount ?? 0}/{projection?.count ?? 0} row(s) with current qualified values.</p>
    <p className="mp-panel-footnote">Row state: {flowStates}. Status and owner reason labels are shown outside the chart tooltip.</p>
    <h4>Recorded quote notional by window</h4>
    <BarsChart
      rows={plotted.map(row => ({ label: row.label, buy: row.buyQuote, sell: row.sellQuote, unknown: row.unknownQuote }))}
      bars={[
        { id: "buy", label: "Buy quote notional", color: CHART.positive },
        { id: "sell", label: "Sell quote notional", color: CHART.negative },
        { id: "unknown", label: "Unknown aggressor quote notional", color: CHART.neutral },
      ]}
      signed={false} format={axisNumber} unit={plotted[0]?.unit ?? frame.quote}
      ariaLabel={`Recorded buy, sell and unknown aggressor quote notional for ${pair(cohort.instrumentId)}, source ${shortSource(cohort.sourceId)}, ${duration(cohort.windowMs)} window`}
      emptyText="No current, qualified flow amounts are available to plot. The retained row states remain below."
    />
    <details>
      <summary>Exact recorded values and row state</summary>
      <p className="mp-panel-footnote">Selected identity: {cohort.instrumentId} · source {cohort.sourceId} · channel {cohort.channel} · quote {cohort.quoteAsset}.</p>
      {plotted.length ? <ul>{plotted.map(row => <li key={`${row.windowStart}/${row.windowEnd}`}>
        {row.state === "FUTURE"
          ? `${asUtc(row.windowStart)}–${asUtc(row.windowEnd)} · ${row.unit} · available ${asUtc(row.available)} · FUTURE`
          : <>{asUtc(row.windowStart)}–{asUtc(row.windowEnd)} · {row.unit}: buy {row.exact.buyQuote}; sell {row.exact.sellQuote}; unknown {row.exact.unknownQuote} · {row.state}; {row.trades} trades; available {asUtc(row.available)}; expires {asUtc(row.expires)}
            {row.gaps.length > 0 && ` · gaps ${row.gaps.map(([start, end]) => `${asUtc(start)}–${asUtc(end)}`).join(", ")}`}
            {row.reason && ` · ${row.reason}`}</>}
      </li>)}</ul> : <p>No rows in this selected cohort.</p>}
    </details>
    {plotted.length === 1 && plotted[0].state === "COMPLETE" && plotted[0].buyQuote === 0 && plotted[0].sellQuote === 0 && plotted[0].unknownQuote === 0 &&
      <p className="mp-panel-footnote">Recorded amounts: buy {plotted[0].exact.buyQuote}, sell {plotted[0].exact.sellQuote}, unknown {plotted[0].exact.unknownQuote} {plotted[0].unit}.</p>}
    <p>Flow amounts are owner observations, not a forecast. Partial rows retain measured amounts but do not qualify as complete confirmation. Raw trades are not retained here.</p>
  </article>;
}

function BookVisual({ frame, asOf, id }: { frame: DisplayFrame; asOf: number; id: string }) {
  const observations = frame.microstructure?.liquidity ?? EMPTY_BOOKS;
  const cohorts = useMemo(() => bookCohorts(observations), [observations]);
  const [selectedKey, setSelectedKey] = useState("");
  const [measure, setMeasure] = useState<"book" | "total">("book");
  const cohort = cohorts.find(item => keyOf(item) === selectedKey) ?? cohorts[0];
  const projection = cohort ? projectBookSelection(observations, cohort, frame, asOf, measure) : null;
  const plotted = projection?.rows ?? [];
  const bookStates = Array.from(new Set(plotted.map(row => row.state))).map(state => `${state} (${plotted.filter(row => row.state === state).length})`).join(" · ") || "No rows";
  const ownerReasons = Array.from(new Set(plotted.flatMap(row => row.reasons ?? []))).join(", ");

  if (!cohorts.length || !cohort) return <article className="mp-visual-card" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Displayed-book size cost and coverage</h3><p>No displayed-book cohort is retained in this snapshot.</p>
  </article>;

  return <article className="mp-visual-card" aria-labelledby={`${id}-title`}>
    <header><h3 id={`${id}-title`}>Displayed-book size cost and coverage</h3><span className="mp-kicker">Recorded observation</span></header>
    <p>Recorded visible-book estimates grouped only within one instrument, source, channel, observation time, and size unit. No orders are sent.</p>
    <div className="mp-visual-controls"><label htmlFor={`${id}-cohort`}>Instrument · source · channel · observation · size unit</label>
    <select id={`${id}-cohort`} value={keyOf(cohort)} onChange={event => setSelectedKey(event.target.value)}>
      {cohorts.map(item => <option key={keyOf(item)} value={keyOf(item)}>{bookOptionLabel(item)}</option>)}
    </select>
    <label htmlFor={`${id}-measure`}>Cost shown</label>
    <select id={`${id}-measure`} value={measure} onChange={event => setMeasure(event.target.value as "book" | "total")}>
      <option value="book">Visible-book cost</option>
      <option value="total">Fee-inclusive total</option>
    </select></div>
    <p>{frame.source_kind} · observed {conciseUtc(cohort.observed)} · assessed {conciseUtc(asOf)} · exact recorded sizes in {cohort.sizeUnit}.</p>
    <p className="mp-panel-footnote">Row state: {bookStates}{ownerReasons ? ` · owner reasons: ${ownerReasons}` : ""}. Status and reasons are shown outside chart tooltips.</p>
    <h4>Cost by exact side and requested size</h4>
    <ul className="mp-visual-legend" aria-label="Cost chart series"><li><i aria-hidden="true" style={{ background: CHART.blue }} />{measure === "total" ? "Fee-inclusive total cost (bps)" : "Visible-book cost (bps)"}</li></ul>
    <BarsChart
      rows={plotted.map(row => ({ label: row.label, cost: row.costBps }))}
      bars={[{ id: "cost", label: measure === "total" ? "Fee-inclusive total cost" : "Visible-book cost", color: CHART.blue }]}
      signed={false} format={axisNumber} unit="bps"
      ariaLabel={`${measure === "total" ? "Fee-inclusive total cost" : "Visible-book cost"} in basis points by exact side and size for ${pair(cohort.instrumentId)}, source ${shortSource(cohort.sourceId)}, observed ${conciseUtc(cohort.observed)}`}
      emptyText="No complete, current, qualified full-size cost rows are available for this measure."
    />
    <h4>Recorded size coverage</h4>
    <ul className="mp-visual-legend" aria-label="Coverage chart series"><li><i aria-hidden="true" style={{ background: CHART.cyan }} />Covered share of requested size (%)</li></ul>
    <BarsChart
      rows={plotted.map(row => ({ label: row.label, coverage: row.coveragePercent }))}
      bars={[{ id: "coverage", label: "Covered share of requested size", color: CHART.cyan }]}
      signed={false} format={axisNumber} unit="%"
      ariaLabel={`Recorded size coverage by side and requested size for ${pair(cohort.instrumentId)}, source ${shortSource(cohort.sourceId)}, observed ${conciseUtc(cohort.observed)}`}
      emptyText="Size coverage is unavailable because requested, covered, or uncovered amounts are missing or invalid."
    />
    <details>
      <summary>Exact size, coverage, cost and state</summary>
      <p className="mp-panel-footnote">Selected identity: {cohort.instrumentId} · source {cohort.sourceId} · channel {cohort.channel} · observation {asUtc(cohort.observed)} · {cohort.sizeUnit}.</p>
      {plotted.length ? <ul>{plotted.map((row, index) => <li key={`${row.side}/${row.size}/${index}`}>
        {row.side} · requested {row.coverage.requested} {row.sizeUnit}; covered {row.coverage.coveredBase} base / {row.coverage.coveredQuote} quote; uncovered {row.coverage.uncovered} {row.sizeUnit};
        {` ${measure === "total" ? "fee-inclusive total" : "visible-book cost"} ${row.costBps == null ? "Unavailable" : `${row.exactCostBps} bps`}; ${row.state}`}
        {row.feeBps != null && ` · fee ${row.feeBps} bps (${row.feeSource ?? "source unavailable"})`}
        {row.reasons?.length > 0 && ` · ${row.reasons.join(", ")}`}
      </li>)}</ul> : <p>No rows in this selected cohort.</p>}
    </details>
    <p>Partial depth remains a coverage observation. The cost bars exclude partial sizes, unknown-access books, stale or future rows, and unqualified sources. Fee-inclusive values also require fee amount and source.</p>
  </article>;
}

export function MicrostructureVisuals({ frame, asOf = frame.available_at_ms, only, idPrefix }: { frame: DisplayFrame; asOf?: number; only?: VisualKind; idPrefix?: string }) {
  const reactId = useId().replaceAll(":", "");
  const id = `${idPrefix ?? "mp-micro"}-${reactId}`;
  if (!frame.microstructure) return <section className="mp-microstructure-visuals" aria-label="Microstructure visuals">
    <p>Microstructure visuals unavailable · this frame has no retained owner microstructure component.</p>
  </section>;
  return <div className="mp-visual-grid" role="region" aria-label="Microstructure visuals">
    {only !== "liquidity" && <FlowVisual frame={frame} asOf={asOf} id={`${id}-flow`} />}
    {only !== "flow" && <BookVisual frame={frame} asOf={asOf} id={`${id}-book`} />}
  </div>;
}
