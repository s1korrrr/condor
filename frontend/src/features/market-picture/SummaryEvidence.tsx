import { MicrostructurePanel, type SummaryTile } from "./MarketPulse";
import type { DisplayFrame, DisplayMetric, HistoryPoint } from "./presentation";

export interface SummarySelection {
  tile: SummaryTile;
  frame: DisplayFrame;
  samples: HistoryPoint[];
  window: string;
}

const utc = (time: number | null) => time == null ? "Unavailable" : new Date(time).toISOString();
const stored = (metric: DisplayMetric | undefined) => metric?.value == null
  ? "Unavailable" : `${metric.original ?? String(metric.value)} ${metric.unit}`;

function MetricEvidence({ label, metric }: { label: string; metric: DisplayMetric | undefined }) {
  return <>
    <h4>{label}</h4>
    {metric ? <dl className="mp-provenance-list">
      <dt>Stored value</dt><dd>{stored(metric)}</dd>
      <dt>Status</dt><dd>{metric.status}{metric.reasons.length > 0 && ` · ${metric.reasons.join(", ")}`}</dd>
      <dt>Metric coverage</dt><dd>{metric.valid} / {metric.expected} instruments</dd>
      <dt>Available from</dt><dd>{utc(metric.available)}</dd>
      <dt>Expires at</dt><dd>{utc(metric.expires)}</dd>
      <dt>Definition</dt><dd>{metric.definition}</dd>
    </dl> : <p>Unavailable · no retained observation.</p>}
  </>;
}

/** A selection holds its immutable owner frame and the exact samples used by the tile. */
export function SummaryEvidence({ selection }: { selection: SummarySelection }) {
  const { tile, frame, samples, window } = selection;
  const coverage = tile.key === "coverage";
  const range = tile.key === "range_breaks";
  const ownerReturn = tile.key === "equal_weight_return";
  const sourceReading = tile.sourceReading;
  const summaryHistory = !ownerReturn && !sourceReading;
  const metrics = range
    ? [["new_highs_24h", "New highs (24h)"], ["new_lows_24h", "New lows (24h)"]]
    : [[tile.key, tile.label]];
  const comparison = frame.comparisonContext;
  const byTime = new Map(samples.map(sample => [sample.time, sample]));
  const rows = coverage ? samples.map(sample => ({ time: sample.time, value: null })) : tile.points;
  return <section className="mp-summary-evidence" data-evidence-snapshot={frame.snapshot_id}>
    <p><strong>Recorded observation: {tile.value}</strong></p>
    <p className="mp-muted">{tile.hint}. This panel keeps the observation selected when it opened. Close and select a tile again to inspect a newer frame.</p>
    <dl className="mp-provenance-list">
      <dt>Observed at</dt><dd>{utc(frame.cutoff_ms)}</dd>
      <dt>Available from</dt><dd>{utc(frame.available_at_ms)}</dd>
      <dt>Expires at</dt><dd>{utc(frame.expires_at_ms)}</dd>
      <dt>Source</dt><dd>{frame.source_kind}{frame.fixture_marker && ` · ${frame.fixture_marker}`}</dd>
      <dt>Universe</dt><dd>{frame.universeId} · {frame.universeRevision} · {frame.quote}</dd>
      <dt>Frame coverage</dt><dd>{frame.valid} / {frame.expected} instruments</dd>
    </dl>
    {sourceReading ? <>
      <h3>Source evidence</h3>
      <p>{sourceReading.evidence}</p>
      <dl className="mp-provenance-list">
        <dt>Reading state</dt><dd>{sourceReading.state} · {sourceReading.freshness}</dd>
        <dt>Scope</dt><dd>{sourceReading.scope}</dd>
        <dt>Assessed at</dt><dd>{utc(tile.asOf ?? null)}</dd>
      </dl>
      <p>Each flow row and order-size scenario keeps its own instrument, source, timing and coverage. This status is not a market-wide imbalance or a universal execution-cost estimate.</p>
      {(tile.key === "spot_flow" || tile.key === "spot_liquidity") && <MicrostructurePanel
        frame={frame} asOf={tile.asOf} only={tile.key === "spot_flow" ? "flow" : "liquidity"} idPrefix="mp-summary" />}
    </> : ownerReturn ? <>
      <h3>Owner return evidence</h3>
      <MetricEvidence label={tile.label} metric={tile.metric} />
      <p>The owner uses the complete frozen start cohort for this horizon. Missing constituent endpoints remain missing; their weight is not redistributed. Change and retained return history are unavailable in these summary samples.</p>
    </> : coverage ? <p>Frame coverage counts admitted instruments with a qualified observation. Each metric can have a different valid count. A change in coverage is unavailable unless the owner records a comparison.</p> : <>
      <h3>Metric evidence</h3>
      {metrics.map(([key, label]) => <section key={key}>
        <MetricEvidence label={label} metric={frame.summary[key]} />
        <MetricEvidence label={`${label} change`} metric={frame.comparisons[`summary/${key}`]} />
      </section>)}
      {comparison && <dl className="mp-provenance-list">
        <dt>Comparison interval</dt><dd>{comparison.interval / 60_000} minutes</dd>
        <dt>Baseline observed at</dt><dd>{utc(comparison.baselineCutoff)}</dd>
        <dt>Matched instruments</dt><dd>{comparison.common} common · {comparison.current} current · {comparison.baseline} baseline</dd>
        <dt>Matched membership</dt><dd>{comparison.membership ?? "Unavailable"}</dd>
        <dt>Baseline snapshot</dt><dd>{comparison.baselineSnapshotId ?? "Unavailable"}</dd>
      </dl>}
    </>}
    {summaryHistory ? <><h3>Retained history</h3>
    <p className="mp-muted">The table uses the tile’s selected {window} history samples. Values keep their stored units; missing values are unavailable. Historical metric definitions, metric coverage, availability and expiry are not retained in these summary rows.</p>
    {range && <p>Plotted net = new highs minus new lows. Both counts must be present; an absent count cannot become zero.</p>}
    {samples.length ? <div className="mp-table-scroll mp-pulse-data__scroll" role="region" aria-label={`${tile.label} history table`} tabIndex={0}>
      <table className="mp-table">
        <caption>{tile.label} · {samples.length} retained observations · {window} · UTC. Coverage is for each frame, not this metric.</caption>
        <thead><tr><th scope="col">Observed at (UTC)</th>
          {!coverage && <th scope="col">{range ? "Plotted net" : "Plotted value"}</th>}
          {range && <><th scope="col">New highs</th><th scope="col">New lows</th></>}
          <th scope="col">Frame coverage</th><th scope="col">Source</th><th scope="col">Membership</th><th scope="col">Snapshot</th>
        </tr></thead>
        <tbody>{rows.map(point => {
          const sample = byTime.get(point.time);
          return sample ? <tr key={point.time}>
            <th scope="row">{utc(point.time)}{coverage && sample.gapBefore && " · coverage gap before"}</th>
            {!coverage && <td>{point.value == null ? "Unavailable" : String(point.value)}</td>}
            {range && <><td>{sample.summary.new_highs_24h ?? "Unavailable"}</td><td>{sample.summary.new_lows_24h ?? "Unavailable"}</td></>}
            <td>{sample.valid} / {sample.expected}</td><td>{sample.source_kind}</td>
            <td>{sample.membership}</td><td>{sample.snapshot_id ?? "Not retained"}</td>
          </tr> : <tr className="mp-muted" key={point.time}>
            <th scope="row">Coverage gap before {utc(point.time + 1)}</th><td colSpan={range ? 7 : 5}>Unavailable · chart line interrupted</td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <p>Unavailable · no retained history samples in this window.</p>}</> : <p>Unavailable · this summary does not retain a comparable history series for this reading.</p>}
    <details>
      <summary>Selected frame identity</summary>
      <dl className="mp-provenance-list">
        <dt>Snapshot</dt><dd>{frame.snapshot_id}</dd>
        <dt>Membership</dt><dd>{frame.membershipHash}</dd>
        <dt>Stream</dt><dd>{frame.stream_id} · {frame.epoch} · sequence {frame.sequence}</dd>
        <dt>Payload digest</dt><dd>{frame.payload_digest}</dd>
      </dl>
    </details>
  </section>;
}
