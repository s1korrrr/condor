import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DataTable, type TableColumn } from "@/features/quant-ops/kit/DataTable";
import { RecordedCandleChart, type RecordedMinute } from "@/components/charts/RecordedCandleChart";

type Row = { health_rules: { level: string; name: string; detail: string }[]; lane: string; venue: string; segment: string; pair: string; health: string; volume_unit: string; last_minute: number | null; last_minute_age_s: number | null; coverage_1h: number | null; coverage_24h: number | null; coverage_7d: number | null; gaps_7d: number | null; pending: number | null; unrecoverable_7d: number | null; no_trade_7d: number | null; ws_state: string | null; grace_s: number | null };
type Tile = Row & { pairs_listed: number; pairs_held: number; available: boolean | null; unavailable_reason: string | null; partition_errors: { day: string; error: string }[] };
type Overview = { now: number; status_age_s: number | null; status_error: string | null; tiles: Tile[] };
type Symbols = { now: number; rows: Row[] };
type Candles = { now: number; lane: string; pair: string; venue: string; segment: string; range: string; volume_unit: string; buckets: RecordedMinute[]; totals: Record<string, number> };

async function read<T>(view: string, params = ""): Promise<T> {
  const response = await fetch(`/api/v5/candle-store/${view}${params}`, { credentials: "include", signal: AbortSignal.timeout(10000) });
  const body = await response.json() as { state: string; reason: string | null; data: T | null };
  if (!response.ok || body.state !== "AVAILABLE" || !body.data) throw new Error(body.reason ?? "Owner read unavailable");
  return body.data;
}

const utc = (value: number | null) => value == null ? "Unavailable" : new Date(value * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
const show = (value: number | null | undefined) => value == null ? "Unavailable" : value.toLocaleString();
const columns: TableColumn<Row>[] = [
  { id: "venue", header: "Venue", value: row => row.venue },
  { id: "segment", header: "Market type", value: row => row.segment },
  { id: "pair", header: "Instrument", value: row => row.pair, rowHeader: true },
  { id: "health", header: "Data health", value: row => row.health, title: row => row.health_rules.map(rule => `${rule.name}: ${rule.detail}`).join("; ") },
  { id: "last", header: "Last open (UTC)", value: row => utc(row.last_minute), size: 240 },
  { id: "age", header: "Age since close (s)", value: row => row.last_minute_age_s, kind: "number" },
  { id: "grace", header: "Settle grace (s)", value: row => row.grace_s, kind: "number" },
  ...(["1h", "24h", "7d"] as const).map(span => ({ id: `coverage_${span}`, header: `Settled coverage ${span} (%)`, value: (row: Row) => row[`coverage_${span}`] == null ? null : Number((row[`coverage_${span}`]! * 100).toFixed(2)), kind: "number" as const })),
  { id: "gaps", header: "Missing 7d (min)", value: row => row.gaps_7d, kind: "number" },
  { id: "pending", header: "Pending (min)", value: row => row.pending, kind: "number" },
  { id: "unrecoverable", header: "Unrecoverable 7d (min)", value: row => row.unrecoverable_7d, kind: "number" },
  { id: "no_trade", header: "No-trade 7d (min)", value: row => row.no_trade_7d, kind: "number" },
  { id: "ws", header: "WebSocket", value: row => row.ws_state ?? "Unavailable" },
];

function Unavailable({ error }: { error: Error | null }) {
  return <p role="alert" className="rounded-lg border border-[var(--color-border)] p-4">Candle store read unavailable: {error?.message ?? "No owner response"}. No prices or health values are substituted. Retry with Refresh.</p>;
}

export function V5CandleStore() {
  const [selected, setSelected] = useState("");
  const [range, setRange] = useState("24h");
  const overview = useQuery({ queryKey: ["candle-overview"], queryFn: () => read<Overview>("overview"), retry: false, refetchInterval: 30000 });
  const symbols = useQuery({ queryKey: ["candle-symbols"], queryFn: () => read<Symbols>("symbols"), retry: false, refetchInterval: 30000 });
  const rows = symbols.isError ? [] : symbols.data?.rows ?? [];
  const instrument = rows.find(row => `${row.lane}/${row.pair}` === selected) ?? rows[0];
  const candles = useQuery({ queryKey: ["candle-chart", instrument?.lane, instrument?.pair, range], queryFn: () => read<Candles>("candles", "?" + new URLSearchParams({ lane: instrument!.lane, pair: instrument!.pair, range })), enabled: !!instrument, retry: false, refetchInterval: 30000 });
  const snapshot = overview.isError ? null : overview.data;
  const chart = candles.isError ? null : candles.data;
  const refresh = () => { void overview.refetch(); void symbols.refetch(); if (instrument) void candles.refetch(); };
  return <div className="space-y-5 min-w-0">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Razer candle store</h2><p className="text-sm text-[var(--color-text-muted)]">Read-only owner observations · 1m candles · UTC · spot and perpetual lanes stay separate</p></div><button className="min-h-11 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)]" onClick={refresh}>Refresh</button></header>
    {overview.isPending ? <p role="status">Loading owner coverage…</p> : overview.isError ? <Unavailable error={overview.error} /> : null}
    {snapshot && <><div className="rounded-lg border border-[var(--color-border)] p-4 text-sm">Evaluated {utc(snapshot.now)} · Collector heartbeat {snapshot.status_age_s == null ? "unavailable" : `${snapshot.status_age_s <= 60 ? "current" : "delayed"} (${show(snapshot.status_age_s)} s)`}. This is collector liveness, not candle finality or source correctness.{snapshot.status_error && <p role="alert">Owner status: {snapshot.status_error}</p>}</div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{snapshot.tiles.map(tile => <article key={tile.lane} className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"><h3 className="font-semibold">{tile.venue} · {tile.segment}</h3><p className="text-sm">Owner lane health: {tile.health} · {show(tile.pairs_held)}/{show(tile.pairs_listed)} instruments held/listed</p><dl className="mt-3 grid grid-cols-3 gap-2 text-sm"><div><dt>Missing 7d</dt><dd>{show(tile.gaps_7d)} min</dd></div><div><dt>Pending</dt><dd>{show(tile.pending)} min</dd></div><div><dt>Unrecoverable 7d</dt><dd>{show(tile.unrecoverable_7d)} min</dd></div></dl><details className="mt-3 text-xs text-[var(--color-text-muted)]"><summary className="cursor-pointer">Health evidence</summary><ul className="mt-2 space-y-1 break-words">{tile.health_rules.map((rule, index) => <li key={`${rule.name}/${index}`}>{rule.level} · {rule.name}: {rule.detail}</li>)}</ul></details>{tile.available === false && <p className="mt-2 text-sm">Lane unavailable: {tile.unavailable_reason ?? "Owner did not supply a reason"}</p>}{tile.partition_errors?.length > 0 && <p role="alert" className="mt-2 break-words text-sm">Partition read errors: {tile.partition_errors.map(item => `${item.day}: ${item.error}`).join("; ")}. Retained observations may be old.</p>}</article>)}</div></>}
    {symbols.isError ? <Unavailable error={symbols.error} /> : symbols.isPending ? <p role="status">Loading instruments…</p> : <section className="min-w-0"><h3 className="mb-2 font-semibold">Instrument coverage · evaluated {utc(symbols.data?.now ?? null)}</h3><p className="mb-3 text-xs text-[var(--color-text-muted)]">Coverage excludes pending minutes inside the owner settle grace. Missing, no-trade and unrecoverable are distinct states. Filter by venue or market type; resize column edges. Blank metrics mean unavailable.</p><DataTable rows={rows} columns={columns} rowId={row => `${row.lane}/${row.pair}`} label="Candle store instrument coverage" emptyText="Owner returned no instruments; coverage is unavailable." /></section>}
    <section className="min-w-0 space-y-3"><div className="flex flex-wrap items-end gap-4"><label className="flex min-w-0 flex-col gap-1 text-sm">Instrument<select className="max-w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2" value={instrument ? `${instrument.lane}/${instrument.pair}` : ""} onChange={event => setSelected(event.target.value)}>{rows.map(row => <option key={`${row.lane}/${row.pair}`} value={`${row.lane}/${row.pair}`}>{row.venue} · {row.segment} · {row.pair}</option>)}</select></label><label className="flex flex-col gap-1 text-sm">Range<select className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2" value={range} onChange={event => setRange(event.target.value)}>{["1h", "6h", "24h", "7d"].map(span => <option key={span}>{span}</option>)}</select></label></div>
      {candles.isError ? <Unavailable error={candles.error} /> : instrument && candles.isPending ? <p role="status">Loading recorded candles…</p> : chart && <><RecordedCandleChart buckets={chart.buckets} label={`${chart.venue} · ${chart.segment} · ${chart.pair} (price in ${chart.pair.split("-")[1]})`} volumeUnit={chart.volume_unit} /><p className="text-xs text-[var(--color-text-muted)]">Selected range only · evaluated {utc(chart.now)} · {Object.entries(chart.totals).map(([key, value]) => `${key}: ${show(value)} min`).join(" · ")}. Chart counts use the selected range; table and tiles label their own windows.</p>{!chart.buckets.some(row => row[6] === 1) && <p>No final price candles in this selected range. Minute states remain visible on hover; no synthetic prices are drawn.</p>}</>}
    </section>
  </div>;
}
