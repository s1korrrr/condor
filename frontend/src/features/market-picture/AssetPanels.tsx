import { useEffect, useState } from "react";
import { BENCHMARKS, rankAssets, stableAssetOrder } from "./model.mjs";
import {
  type DisplayAsset,
  type DisplayCorrelation,
  type DisplayFrame,
  metricText,
  numberText,
} from "./presentation";
import { api } from "@/lib/api";
import { boundedJson, projectCorrelations } from "./source";
import { Empty, Metric, Panel, Sparkline } from "./Primitives";

interface AssetPanelProps {
  frame: DisplayFrame | null;
  selected: string | null;
  select: (id: string) => void;
  cohort: Set<string>;
}

export function RegimeOverviewPanel({
  frame,
  selected,
  select,
  cohort,
  search,
}: AssetPanelProps & { search: string }) {
  const [sort, setSort] = useState<"symbol" | "return">("symbol");
  const [pinnedIds, setPinnedIds] = useState<string[] | null>(null);
  const rows = stableAssetOrder(
    (frame?.assets ?? []).filter((a) =>
      `${a.symbol} ${a.instrument_id}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ),
    sort,
    pinnedIds,
  );
  const pinOrder = () => setPinnedIds(rows.map((a) => a.instrument_id));
  return (
    <Panel
      id="mp-regimes"
      title="Regime overview"
      detail={`${rows.length} / ${frame?.expected ?? 0} symbols`}
      className="mp-regimes"
      actions={
        <select
          aria-label="Regime table order"
          value={sort}
          onChange={(e) => {
            setPinnedIds(null);
            setSort(e.target.value as "symbol" | "return");
          }}
        >
          <option value="symbol">Symbol</option>
          <option value="return">24h return</option>
        </select>
      }
    >
      <div
        className="mp-table-scroll"
        onMouseEnter={pinOrder}
        onMouseLeave={(e) => {
          if (!e.currentTarget.contains(document.activeElement))
            setPinnedIds(null);
        }}
        onFocus={pinOrder}
        onBlur={(e) => {
          if (
            !e.currentTarget.contains(e.relatedTarget) &&
            !e.currentTarget.matches(":hover")
          )
            setPinnedIds(null);
        }}
      >
        <table className="mp-table">
          <caption className="sr-only">
            Recorded and observational regime labels; confidence is source
            reported, never inferred from trend strength.
          </caption>
          <thead>
            <tr>
              <th>#</th>
              <th>Symbol</th>
              <th>Price</th>
              <th>Regime</th>
              <th>Confidence</th>
              <th>Trend</th>
              <th>Context</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((asset, index) => {
              const regime = asset.regimes[0];
              return (
                <tr
                  key={asset.instrument_id}
                  data-selected={asset.instrument_id === selected || undefined}
                  data-cohort={cohort.has(asset.instrument_id) || undefined}
                >
                  <td>{index + 1}</td>
                  <th scope="row">
                    <button onClick={() => select(asset.instrument_id)}>
                      {asset.symbol}
                    </button>
                  </th>
                  <td title={asset.price.original ?? undefined}>
                    <Metric
                      metric={asset.price}
                      digits={
                        asset.price.value !== null && asset.price.value < 1
                          ? 6
                          : 2
                      }
                    />
                  </td>
                  <td>
                    <span
                      className="mp-regime-tag"
                      title={
                        regime
                          ? `${regime.origin} · ${regime.model ?? "Model not supplied"} · ${new Date(regime.available).toISOString()}`
                          : "No qualified regime publisher"
                      }
                    >
                      {regime?.label ?? "Unavailable"}
                    </span>
                  </td>
                  <td
                    title={
                      regime
                        ? `${regime.confidenceKind ?? "Unspecified kind"} · ${regime.calibration}`
                        : undefined
                    }
                  >
                    {regime?.confidence ?? "—"}
                  </td>
                  <td>{regime?.trend ?? "—"}</td>
                  <td>{regime?.context ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && (
          <Empty>
            {search
              ? "No symbols match this search."
              : "Regime observations are unavailable."}
          </Empty>
        )}
      </div>
      <footer className="mp-panel-footnote">
        {frame?.assets.some((a) => a.regimes.length)
          ? "Select a symbol for origin, calibration and exact source time."
          : "No qualified same-bar regime records. Confidence remains unavailable."}
      </footer>
    </Panel>
  );
}

export function CorrelationsPanel({
  frame,
  selected,
  select,
  correlations,
  benchmark,
  setBenchmark,
  openMatrix,
}: AssetPanelProps & {
  correlations: DisplayCorrelation[];
  benchmark: string;
  setBenchmark: (b: string) => void;
  openMatrix: () => void;
}) {
  const [inverse, setInverse] = useState(false);
  const rows = correlations
    .filter(
      (c) =>
        c.instrument_id !== c.benchmark_id &&
        c.benchmark_id
          .split(":")
          .at(-1)
          ?.startsWith(benchmark + "-"),
    )
    .sort((a, b) =>
      inverse
        ? (a.value ?? Infinity) - (b.value ?? Infinity)
        : (b.value ?? -Infinity) - (a.value ?? -Infinity),
    )
    .slice(0, 8);
  return (
    <Panel
      id="mp-correlations"
      title="Correlations"
      detail="90D · 1h"
      className="mp-correlations"
    >
      <div className="mp-segment mp-benchmark-chips">
        {BENCHMARKS.map((b) => (
          <button
            key={b}
            aria-pressed={benchmark === b}
            onClick={() => setBenchmark(b)}
          >
            {b}
          </button>
        ))}
      </div>
      <div className="mp-table-scroll">
        <table className="mp-table">
          <caption className="sr-only">
            Pearson correlation of aligned hourly log returns over 90 days.
            Sparkline contains historical 90 day estimates.
          </caption>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Corr ({benchmark})</th>
              <th>30D trend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.instrument_id}
                data-selected={selected === c.instrument_id || undefined}
              >
                <th scope="row">
                  <button onClick={() => select(c.instrument_id)}>
                    {frame?.assets.find(
                      (a) => a.instrument_id === c.instrument_id,
                    )?.symbol ?? c.instrument_id.split(":").at(-1)}
                  </button>
                </th>
                <td
                  title={`${c.samples}/${c.expected} paired hours · ${c.reasons.join(", ")} · ${new Date(c.cutoff).toISOString()}`}
                >
                  {numberText(c.value, 2)}
                </td>
                <td>
                  <Sparkline
                    values={c.trend.map((p) => p.value)}
                    color={
                      c.value !== null && c.value < 0
                        ? "var(--mp-negative)"
                        : undefined
                    }
                    label="Daily history of 90-day correlation"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty>90D hourly history is unavailable.</Empty>}
      </div>
      <footer className="mp-correlation-tools">
        <button
          className="mp-text-button"
          aria-pressed={inverse}
          onClick={() => setInverse(!inverse)}
        >
          {inverse ? "Strongest positive ↗" : "Explore inverse ↘"}
        </button>
        <button className="mp-text-button" onClick={openMatrix}>
          Matrix ↗
        </button>
      </footer>
    </Panel>
  );
}

export function LeadersLaggardsPanel({
  frame,
  selected,
  select,
  cohort,
  benchmark,
}: AssetPanelProps & { benchmark: string }) {
  const [sort, setSort] = useState("1440");
  const value = (a: DisplayAsset) =>
    sort === "relative"
      ? (a.relative[benchmark]?.value ?? null)
      : (a.returns[sort]?.value ?? null);
  const { leaders, laggards } = rankAssets(frame?.assets ?? [], value);
  return (
    <Panel
      id="mp-rankings"
      title="Leaders & laggards"
      className="mp-rankings"
      actions={
        <select
          aria-label="Rank leaders and laggards by"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="1440">24h</option>
          <option value="10080">7d</option>
          <option value="relative">RS vs {benchmark}</option>
        </select>
      }
    >
      <table className="mp-table">
        <caption className="sr-only">
          Five strictly positive leaders and five strictly negative laggards;
          relative strength is a return difference in percentage points.
        </caption>
        <thead>
          <tr>
            <th>Symbol</th>
            <th>24h</th>
            <th>7d</th>
            <th>RS ({benchmark})</th>
          </tr>
        </thead>
        <tbody>
          {[leaders, laggards].map((rows, group) =>
            rows.length ? (
              rows.map((a, index) => (
                <tr
                  key={a.instrument_id}
                  className={
                    group === 1 && index === 0 ? "mp-laggard-start" : ""
                  }
                  data-selected={selected === a.instrument_id || undefined}
                  data-cohort={cohort.has(a.instrument_id) || undefined}
                >
                  <th scope="row">
                    <button onClick={() => select(a.instrument_id)}>
                      {a.symbol}
                    </button>
                  </th>
                  <td
                    className={
                      (a.returns["1440"]?.value ?? 0) < 0 ? "mp-down" : "mp-up"
                    }
                  >
                    {metricText(a.returns["1440"], 1, true)}
                  </td>
                  <td
                    className={
                      (a.returns["10080"]?.value ?? 0) < 0 ? "mp-down" : "mp-up"
                    }
                  >
                    {metricText(a.returns["10080"], 1, true)}
                  </td>
                  <td>{metricText(a.relative[benchmark], 1, true)}</td>
                </tr>
              ))
            ) : (
              <tr key={group}>
                <td colSpan={4} className="mp-table-empty">
                  {group === 0 ? "No positive leaders" : "No negative laggards"}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </Panel>
  );
}

export function CorrelationMatrix({
  frame,
  server,
  initial,
  fixture = false,
  select,
}: {
  frame: DisplayFrame | null;
  server: string | null;
  initial: DisplayCorrelation[];
  fixture?: boolean;
  select: (id: string) => void;
}) {
  const [rowPage, setRowPage] = useState(0),
    [columnPage, setColumnPage] = useState(0);
  const pageSize = 16;
  const assets = frame?.assets ?? [];
  const [stored, setStored] = useState<{
    key: string;
    pairs: DisplayCorrelation[];
    fault: string | null;
  } | null>(null);
  const key = `${frame?.snapshot_id}:${rowPage}:${columnPage}`;
  useEffect(() => {
    if (!frame || !server || fixture) return;
    const controller = new AbortController();
    const query = {
      snapshot_id: frame.snapshot_id,
      matrix: "true",
      row_offset: String(rowPage * pageSize),
      column_offset: String(columnPage * pageSize),
      page_size: String(pageSize),
      limit: "256",
    };
    void (async () => {
      try {
        const payload = await boundedJson(
          await api.getMarketPicture(
            server,
            "correlations",
            query,
            AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          ),
        );
        const pairs = projectCorrelations(payload, frame);
        if (!controller.signal.aborted) setStored({ key, pairs, fault: null });
      } catch (error) {
        if (!controller.signal.aborted)
          setStored({
            key,
            pairs: [],
            fault:
              error instanceof Error
                ? error.message
                : "Stored matrix page unavailable.",
          });
      }
    })();
    return () => controller.abort();
  }, [server, frame, rowPage, columnPage, fixture, key]);
  const correlations = fixture
    ? initial
    : stored?.key === key
      ? stored.pairs
      : [];
  const rows = assets.slice(rowPage * pageSize, (rowPage + 1) * pageSize),
    columns = assets.slice(columnPage * pageSize, (columnPage + 1) * pageSize);
  const values = new Map(
    correlations.map((c) => [`${c.instrument_id}|${c.benchmark_id}`, c]),
  );
  return (
    <>
      {!fixture && stored?.key !== key && (
        <p role="status">Loading stored matrix page…</p>
      )}
      {stored?.key === key && stored.fault && (
        <p className="mp-warning">{stored.fault}</p>
      )}
      <p className="mp-muted">
        90-day aligned hourly log returns. Each cell retains its own paired
        sample count; unavailable pairs have no coefficient. Showing at most 16
        × 16 cells.
      </p>
      <div className="mp-matrix-controls">
        {[
          ["Rows", rowPage, setRowPage],
          ["Columns", columnPage, setColumnPage],
        ].map(([label, page, setPage]) => (
          <label key={String(label)}>
            {String(label)}{" "}
            <select
              value={page as number}
              onChange={(e) =>
                (setPage as (n: number) => void)(Number(e.target.value))
              }
            >
              {Array.from(
                { length: Math.ceil(assets.length / pageSize) },
                (_, i) => (
                  <option value={i} key={i}>
                    {i * pageSize + 1}–
                    {Math.min(assets.length, (i + 1) * pageSize)}
                  </option>
                ),
              )}
            </select>
          </label>
        ))}
      </div>
      <div className="mp-matrix-scroll">
        <table className="mp-table mp-matrix">
          <thead>
            <tr>
              <th>Symbol</th>
              {columns.map((a) => (
                <th key={a.instrument_id}>{a.symbol}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.instrument_id}>
                <th scope="row">
                  <button onClick={() => select(a.instrument_id)}>
                    {a.symbol}
                  </button>
                </th>
                {columns.map((b) => {
                  const c =
                    values.get(`${a.instrument_id}|${b.instrument_id}`) ??
                    values.get(`${b.instrument_id}|${a.instrument_id}`);
                  return (
                    <td
                      key={b.instrument_id}
                      title={
                        c
                          ? `${c.samples}/${c.expected} paired hours · ${c.reasons.join(", ")}`
                          : "Pair unavailable"
                      }
                      style={{
                        background:
                          c?.value == null
                            ? undefined
                            : c.value >= 0
                              ? `rgb(0 217 160 / ${Math.abs(c.value) * 0.35})`
                              : `rgb(255 83 106 / ${Math.abs(c.value) * 0.35})`,
                      }}
                    >
                      {c?.value == null ? "—" : c.value.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
