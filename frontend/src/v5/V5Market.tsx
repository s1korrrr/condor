import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { SparkChart, TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { TileGrid } from "@/features/quant-ops/kit/grid";
import type { ChartSeries } from "@/features/quant-ops/kit/series";
import { V5CandleStore } from "./V5CandleStore";
import { readCandleStore } from "./candle-store-api";
import type { CrossStats } from "./candle-store-model";
import { selectedCohortCoverage } from "./evidence";
import { V5MarketDetail, type DetailRead } from "./V5MarketDetail";
import { V5MarketFeatures } from "./V5MarketFeatures";
import { v5Api } from "./api";
import { ageSeconds, breadth, coinTile, indexedReturns, MARKET_COINS, premiumSeries, REFERENCE, STALE_AFTER_S, storeHealth, venueGrid, type CandleRead, type LaneTile } from "./market-model.mjs";
import { tri, utcMinute } from "./shown.mjs";
import "./market.css";

/** Fixed coin identity colours (validated categorical order, dark steps); a coin keeps its colour on every chart. */
const COIN_COLOR: Record<string, string> = { BTC: "#3987e5", ETH: "#d95926", BNB: "#199e70", SOL: "#c98500", XRP: "#d55181" };
const REFRESH_MS = 60_000;

type Summary = { now: number; status_age_s: number | null; tiles: LaneTile[] };
type CoinRead = { spot: CandleRead | null; perpetual: CandleRead | null; error: string | null; perpetualError: string | null; receivedAt: number };
type CrossRead = { coin: string; table: CrossStats[] | null; error: string | null };

const signed = (value: number, digits = 2) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
const price = (value: number) => value >= 1000 ? value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : value >= 10 ? value.toFixed(2) : value.toFixed(4);
const minuteText = (seconds: number | null | undefined) => utcMinute(seconds == null ? null : seconds * 1000) ?? "unknown";
const ageText = (seconds: number | null) => seconds == null ? "age unknown" : seconds < 120 ? `${Math.round(seconds)} s ago` : `${Math.round(seconds / 60)} min ago`;
const venueName = (venue: string) => venue.replace("_io", ".io");
const failure = (cause: unknown) => cause instanceof Error ? cause.message : "owner read unavailable";

/** Reads run one after another: the owner serves two concurrent reads, and other pages share them. */
async function readCoins(): Promise<Record<string, CoinRead>> {
  const out: Record<string, CoinRead> = {};
  for (const coin of MARKET_COINS) {
    const pair = `${coin}-${REFERENCE.quote}`;
    let spot: CandleRead | null = null, perpetual: CandleRead | null = null, error: string | null = null, perpetualError: string | null = null;
    try { spot = await readCandleStore<CandleRead>("candles", { lane: REFERENCE.spot, pair, range: "24h" }); } catch (cause) { error = failure(cause); }
    try { perpetual = await readCandleStore<CandleRead>("candles", { lane: REFERENCE.perpetual, pair, range: "24h" }); } catch (cause) { perpetualError = failure(cause); }
    out[coin] = { spot, perpetual, error, perpetualError, receivedAt: Date.now() };
  }
  return out;
}

/** The owner's per-venue gap statistics for the last hour; a failed read stays a failure, never "not listed". */
async function readCross(): Promise<CrossRead[]> {
  const out: CrossRead[] = [];
  for (const coin of MARKET_COINS) {
    try { out.push({ coin, table: (await readCandleStore<{ table: CrossStats[] }>("cross", { asset: coin, segment: "spot", range: "1h" })).table, error: null }); }
    catch (cause) { out.push({ coin, table: null, error: failure(cause) }); }
  }
  return out;
}

/** Wall clock for ages, advanced every 15 seconds. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 5_000); return () => window.clearInterval(timer); }, []);
  return now;
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <section className="v5m-section"><header><h2>{title}</h2>{note && <span>{note}</span>}</header>{children}</section>;
}

function Card({ title, hint, children, className }: { title: string; hint?: string; children: React.ReactNode; className?: string }) {
  return <article className={`v5m-card${className ? ` ${className}` : ""}`}><h3>{title}</h3>{hint && <p className="v5m-hint">{hint}</p>}{children}</article>;
}

export function V5Market() {
  const summary = useQuery({ queryKey: ["v5-market", "summary"], queryFn: () => readCandleStore<Summary>("summary"), retry: false, refetchInterval: REFRESH_MS });
  const coins = useQuery({ queryKey: ["v5-market", "coins"], queryFn: readCoins, retry: false, refetchInterval: REFRESH_MS });
  const cross = useQuery({ queryKey: ["v5-market", "cross"], queryFn: readCross, retry: false, refetchInterval: REFRESH_MS, enabled: coins.isSuccess });
  const workspace = useQuery({ queryKey: ["v5-workspace"], queryFn: v5Api.workspace, refetchInterval: 30_000 });
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const select = (coin: string) => setSelected(current => current === coin ? null : coin);
  const now = useNow();
  const toggleSeries = (coin: string) => setHidden(current => { const next = new Set(current); if (next.has(coin)) next.delete(coin); else next.add(coin); return next; });

  const reads = coins.data ?? {};
  const tiles = MARKET_COINS.map(coin => coinTile(coin, reads[coin]?.spot, reads[coin]?.perpetual));
  const age = (coin: string, minuteT: number) => reads[coin]?.spot ? ageSeconds(minuteT, reads[coin].spot!, reads[coin].receivedAt, now) : null;
  const returns: Record<string, ReturnType<typeof indexedReturns>> = Object.fromEntries(MARKET_COINS.map(coin => [coin, indexedReturns(reads[coin]?.spot)]));
  const width = breadth(tiles);
  const returnSeries: ChartSeries[] = MARKET_COINS.filter(coin => returns[coin].length).map(coin => ({ id: coin, label: coin, color: COIN_COLOR[coin], points: returns[coin], unit: "%", format: value => `${signed(value)}%` }));
  const premium: ChartSeries[] = MARKET_COINS.map(coin => ({ coin, points: premiumSeries(reads[coin]?.spot, reads[coin]?.perpetual) }))
    .filter(item => item.points.some(point => point.value != null)).map(({ coin, points }) => ({ id: coin, label: coin, color: COIN_COLOR[coin], points, unit: "bp", format: value => `${signed(value, 1)} bp` }));
  // After a failed refetch TanStack keeps the old data; only a successful read is shown as the store's state.
  const lanes = summary.isSuccess ? summary.data.tiles : [];
  const health = storeHealth(lanes);
  // The owner's age at read time plus local time since the read arrived, so the chip ticks between reads.
  const slowestAge = health.oldestMinuteAge == null || !summary.dataUpdatedAt ? null : health.oldestMinuteAge + Math.max(0, now - summary.dataUpdatedAt) / 1000;
  const grid = venueGrid(lanes);
  const evidence = workspace.data?.context ?? null;
  const cohort = evidence ? selectedCohortCoverage(evidence) : null;
  const refresh = workspace.data?.source_refresh;
  const feedCurrent = refresh?.feed_freshness === "FRESH" && refresh.feed_fresh_until_ms != null && Date.now() <= refresh.feed_fresh_until_ms;
  const failed = MARKET_COINS.filter(coin => reads[coin]?.error);
  const crossVenues = [...new Set((cross.data ?? []).flatMap(read => (read.table ?? []).map(row => row.venue)))].sort();

  return <div className="v5m">
    <header className="v5m-head">
      <div><h1>Market</h1><p>Five coins across {grid.length || "the"} venues, spot and perpetual · prices, breadth, premium, venue coverage and data health on one page. Prices: {venueName(REFERENCE.venue)} {REFERENCE.quote} 1-minute candles; every tile names the minute its price closed.</p></div>
      <div className="v5m-chips">
        <span className={`v5m-chip ${summary.isError ? "is-bad" : summary.isSuccess && health.lanesLive === health.lanes && health.lanes ? "" : "is-warn"}`}><i />Candle store <b>{summary.isError ? "unavailable" : summary.isSuccess ? `${health.lanesLive}/${health.lanes} lanes live` : "reading"}</b></span>
        <span className={`v5m-chip ${feedCurrent ? "" : "is-warn"}`}><i />V5 feed <b>{refresh ? (feedCurrent ? "current" : "not current") : "unknown"}</b></span>
        <span className={`v5m-chip ${slowestAge != null && slowestAge > STALE_AFTER_S ? "is-warn" : ""}`} title={`Seconds since the newest final minute closed, on the slowest of ${health.lanes || "the"} lanes. A minute is final some seconds after it closes (perpetuals later than spot), so up to about 95 s is normal; above ${STALE_AFTER_S} s is marked.`}><i />Slowest lane <b>{slowestAge == null ? "unknown" : `${Math.round(slowestAge)} s behind`}</b></span>
        <button className="v5m-refresh" onClick={() => { void summary.refetch(); void coins.refetch(); void workspace.refetch(); }}><RotateCw size={14} />Refresh</button>
      </div>
    </header>

    {coins.isPending && <p role="status" className="v5m-status">Reading 24 hours of candles for {MARKET_COINS.join(", ")}…</p>}
    {failed.length > 0 && <p role="alert" className="v5m-status">No candles for {failed.map(coin => `${coin} (${reads[coin].error})`).join(", ")}. Those tiles are left out.</p>}

    <TileGrid label="Coins" min={200}>{tiles.map((tile, index) => tile ? <article key={tile.coin} className={`v5m-card v5m-coin is-clickable${selected === tile.coin ? " is-selected" : ""}`} role="button" tabIndex={0} aria-pressed={selected === tile.coin} aria-label={`${tile.coin}: open statistics, candles and venue detail`} onClick={() => select(tile.coin)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(tile.coin); } }}>
      <div className="v5m-coin-top"><span className="v5m-sym"><i style={{ background: COIN_COLOR[tile.coin] }} />{tile.coin}</span>{tile.changePct == null ? <span className="v5m-change" title="No close at the window's first minute">24h —</span> : <span className={`v5m-change ${tile.changePct < 0 ? "is-down" : "is-up"}`}>{tile.changePct < 0 ? "▼" : "▲"} {signed(tile.changePct)}%</span>}</div>
      <strong className="v5m-price">${price(tile.last)}</strong>{(() => { const seconds = age(tile.coin, tile.lastTime); const old = seconds == null || seconds > STALE_AFTER_S; return <small className={`v5m-asof${old ? " is-old" : ""}`} title="Seconds since this minute closed, by the candle store's clock plus time since this page read it">close of {minuteText(tile.lastTime)} · {ageText(seconds)}</small>; })()}
      <SparkChart points={tile.spark} color={COIN_COLOR[tile.coin]} height={44} format={price} unit={REFERENCE.quote} ariaLabel={`${tile.coin} price, last 24 hours, breaks where minutes are missing`} />
      <div className="v5m-range" title={`Where the last price sits between the low and high of ${tile.heldMinutes} held minutes (of ${tile.windowMinutes})`}><div><span style={{ left: `${((tile.last - tile.low) / ((tile.high - tile.low) || 1)) * 100}%` }} /></div><small><span>{tile.heldMinutes < tile.windowMinutes ? "held" : "24h"} low {price(tile.low)}</span><span>high {price(tile.high)}</span></small></div>
      <dl className="v5m-kv"><dt>Perpetual premium</dt><dd title="Perpetual close over spot close for the newest minute where both are final; perpetual minutes finalize later than spot">{reads[tile.coin]?.perpetualError ? "perpetual read failed" : tile.premiumBps == null || tile.premiumTime == null ? "no minute with both closes" : (() => { const seconds = age(tile.coin, tile.premiumTime); const old = seconds == null || seconds > STALE_AFTER_S; return <span className={old ? "v5m-asof is-old" : undefined}>{`${signed(tile.premiumBps, 1)} bp · ${minuteText(tile.premiumTime)}${old ? ` · ${ageText(seconds)}` : ""}`}</span>; })()}</dd><dt>Minutes held</dt><dd>{tile.heldMinutes} / {tile.windowMinutes}</dd></dl>
    </article> : <article key={MARKET_COINS[index]} className="v5m-card v5m-coin is-empty"><span className="v5m-sym">{MARKET_COINS[index]}</span><p>{coins.isPending ? "Loading…" : reads[MARKET_COINS[index]]?.error ? `Candle read failed: ${reads[MARKET_COINS[index]].error}` : "No closed minute in the last 24 hours."}</p></article>)}</TileGrid>
    {selected ? <V5MarketDetail key={selected} coin={selected} color={COIN_COLOR[selected]} onClose={() => setSelected(null)} tileRead={coins.isSuccess && !coins.isRefetchError && reads[selected]?.spot ? reads[selected] as unknown as DetailRead : null} /> : <p className="v5m-hint v5m-tip">Click a coin for its candles, window statistics and venue-by-venue price gaps.</p>}

    <Section title="Moves" note={`${venueName(REFERENCE.venue)} spot, 1-minute candles sampled every 5 minutes`}>
      <div className="v5m-row v5m-row--wide">
        <Card title="Return over the last 24 hours" hint="Each coin starts at 0% at the window's first minute (a coin without that minute is left out) · lines break where minutes are missing · hover for values">
          <TimeSeriesChart series={returnSeries.filter(item => !hidden.has(item.id))} height={260} zeroLine includeZero signed ariaLabel="Return of each coin over the last 24 hours" leftFormat={value => `${signed(value)}%`} emptyText="No candles to plot yet." />
          <Legend series={returnSeries} hidden={hidden} onToggle={toggleSeries} />
        </Card>
        <Card title="Breadth" hint="How many of the five coins are up" className="v5m-breadth">
          <div className="v5m-big"><div><strong>{width.up}<small> of {width.measured} up</small></strong><span>over 24 hours</span></div><div><strong>{width.up1h}<small> of {width.measured1h} up</small></strong><span>over the last hour</span></div></div>
          <p className="v5m-hint">Average 24-hour return <b className={width.averagePct != null && width.averagePct < 0 ? "is-down" : "is-up"}>{width.averagePct == null ? "unavailable" : `${signed(width.averagePct)}%`}</b></p>
          <ReturnBars tiles={tiles.flatMap(tile => tile?.changePct != null ? [{ coin: tile.coin, changePct: tile.changePct }] : [])} selected={selected} onSelect={select} />
        </Card>
      </div>
    </Section>

    <Section title="Spot versus perpetual" note={`${venueName(REFERENCE.venue)} perpetual over spot, same quote · 100 bp = 1%`}>
      <div className="v5m-row">
        <Card title="Perpetual premium, last 24 hours" hint="Every fifth minute where both legs closed · above 0: the perpetual trades above spot · hover for values">
          <TimeSeriesChart series={premium.filter(item => !hidden.has(item.id))} height={240} zeroLine includeZero signed ariaLabel="Perpetual premium over spot by coin" leftFormat={value => `${signed(value, 1)} bp`} emptyText="No minute where both spot and perpetual closed." />
          <Legend series={premium} hidden={hidden} onToggle={toggleSeries} />
        </Card>
        <Card title="Same coin, different venue" hint="Average gap of each venue's spot close from the median of venues over the last hour, basis points (owner-computed; hover for minutes compared)">
          {cross.isPending ? <p role="status" className="v5m-hint">Reading cross-venue prices…</p> : !cross.data || crossVenues.length === 0 ? <p className="v5m-hint">Cross-venue statistics unavailable{cross.data?.some(read => read.error) ? `: ${cross.data.find(read => read.error)!.error}` : ""}.</p> :
            <table className="v5m-heat"><thead><tr><th>Venue</th>{cross.data.map(read => <th key={read.coin} title={read.error ?? undefined}>{read.coin}{read.error ? " (read failed)" : ""}</th>)}</tr></thead><tbody>{crossVenues.map(venue => <tr key={venue}><td>{venueName(venue)}</td>{cross.data!.map(read => {
              const row = read.table?.find(item => item.venue === venue);
              if (!row || row.mean_bps == null || !row.n) return <td key={read.coin} className="is-none" title={read.error ? "read failed" : row ? "no minute compared" : "no row from the owner for this venue"}>—</td>;
              const bps = row.mean_bps, strength = Math.min(Math.abs(bps) / 12, 1) * 0.45;
              return <td key={read.coin} className={`is-clickable${selected === read.coin ? " is-selected" : ""}`} onClick={() => select(read.coin)} title={`${venueName(venue)} ${row.pair}: mean ${signed(bps, 2)} bp over ${row.n} minutes · p95 |gap| ${row.p95_abs_bps == null ? "—" : row.p95_abs_bps.toFixed(1)} bp · click for ${read.coin} detail`} style={{ background: Math.abs(bps) < 0.5 ? undefined : `color-mix(in srgb, ${bps < 0 ? "var(--color-red)" : "var(--color-green)"} ${Math.round(strength * 100)}%, transparent)` }}>{signed(bps, 1)}</td>;
            })}</tr>)}</tbody></table>}
          <p className="v5m-hint">Green: above the median of venues, red: below. Quotes can differ (USDT, USD, USDC), so part of a gap can be the quote currency, not the venue.</p>
        </Card>
      </div>
    </Section>

    <Section title="V5 market features" note={`What the V5 engine computes from all venues every 20 seconds · packet cut at ${utcMinute(evidence?.cutoff_ms) ?? "unknown"}`}>
      <div className="v5m-card">{workspace.isPending ? <p role="status" className="v5m-hint">Reading the V5 feed…</p> : workspace.isError ? <p role="alert" className="v5m-hint">Workspace read failed: {workspace.error.message}.</p> : !evidence ? <p className="v5m-hint">The V5 feed returned no market evidence. No feature is inferred.</p> : <V5MarketFeatures features={evidence.features} />}</div>
    </Section>

    <Section title="Venues and data health" note="Candle store and the V5 market-context feed">
      <div className="v5m-row">
        <Card title="Venue coverage" hint="Pairs held of listed · 24-hour candle coverage · age of the newest minute">
          {summary.isPending ? <p role="status" className="v5m-hint">Reading lanes…</p> : summary.isError ? <p role="alert" className="v5m-hint">Candle store read failed: {summary.error.message}.</p> :
            <div className="v5m-venues"><span>Venue</span><span>Spot</span><span>Perpetual</span>{grid.map(row => <Venue key={row.venue} row={row} />)}</div>}
        </Card>
        <Card title="Candle store health" hint="One store feeds V5, Helm and research">
          <div className="v5m-stats">
            <Stat label="Lanes live" value={summary.isSuccess ? `${health.lanesLive}/${health.lanes}` : "—"} warn={health.lanesUnknown > 0} note={health.lanesUnknown ? `${health.lanesUnknown} lane(s) did not report availability` : health.pairsHeld == null || health.pairsListed == null ? `pair counts: ${health.unreported.pairs} lane(s) unreported` : `${health.pairsHeld}/${health.pairsListed} pairs held`} />
            <Stat label="7-day coverage" value={health.coverage7d == null ? "—" : `${(health.coverage7d * 100).toFixed(1)}%`} note={health.coverage7d == null && health.unreported.coverage ? `${health.unreported.coverage} lane(s) unreported` : "final 1-minute candles, all lanes"} />
            <Stat label="Missing minutes, 7 days" value={health.gaps7d == null ? "—" : String(health.gaps7d)} note={health.gaps7d == null && health.unreported.gaps ? `${health.unreported.gaps} lane(s) unreported` : "all lanes"} />
            <Stat label="Slowest lane" value={slowestAge == null ? "—" : `${Math.round(slowestAge)} s`} note={health.oldestMinuteAge == null && health.unreported.age ? `${health.unreported.age} lane(s) unreported` : "since its newest final minute closed; up to ~95 s is normal"} />
          </div>
          <h3 className="v5m-subhead">V5 market-context feed</h3>
          <p className="v5m-hint">What the V5 engine receives every 20 seconds · last success {utcMinute(refresh?.last_success_at_ms) ?? "unknown"}</p>
          {workspace.isError ? <p role="alert" className="v5m-hint">Workspace read failed: {workspace.error.message}.</p> : !cohort ? <p className="v5m-hint">{workspace.isPending ? "Reading the feed…" : "The feed returned no market evidence. No coverage is inferred."}</p> :
            <div className="v5m-stats">{cohort.dimensions.map(item => <Stat key={item.key} label={item.label} value={item.valid == null || item.expected == null ? "—" : `${item.valid}/${item.expected}`} note={item.fraction == null ? "not qualified" : `${(item.fraction * 100).toFixed(0)}% this minute`} title="Pairs that passed the V5 feed's qualification rule for its newest minute, out of the pairs the feed expects (the owner's own counts). The candle store panel counts pairs present in the store, a different and larger count." warn={item.fraction != null && item.fraction < 1} />)}</div>}
        </Card>
      </div>
    </Section>

    <details className="v5m-details" onToggle={event => setDetailsOpen(event.currentTarget.open)}><summary>Candle store details: every lane and instrument, candle chart, coverage heatmap, store facts</summary>{detailsOpen && <V5CandleStore />}</details>
  </div>;
}

function Legend({ series, hidden, onToggle }: { series: ChartSeries[]; hidden: ReadonlySet<string>; onToggle: (id: string) => void }) {
  return <div className="v5m-legend" role="group" aria-label="Show or hide coins">{series.map(item => { const last = [...item.points].reverse().find(point => point.value != null); const off = hidden.has(item.id); return <button type="button" key={item.id} aria-pressed={!off} className={off ? "is-off" : ""} onClick={() => onToggle(item.id)} title={off ? `Show ${item.label}` : `Hide ${item.label}`}><i style={{ background: item.color }} />{item.label} <b>{last?.value == null ? "—" : item.format!(last.value)}</b></button>; })}</div>;
}

function ReturnBars({ tiles, selected, onSelect }: { tiles: { coin: string; changePct: number }[]; selected: string | null; onSelect: (coin: string) => void }) {
  const sorted = [...tiles].sort((a, b) => b.changePct - a.changePct);
  const max = Math.max(...sorted.map(tile => Math.abs(tile.changePct)), 0.01);
  return <div className="v5m-bars">{sorted.map(tile => <button type="button" key={tile.coin} className={`v5m-bar${selected === tile.coin ? " is-selected" : ""}`} aria-pressed={selected === tile.coin} onClick={() => onSelect(tile.coin)} title={`${tile.coin}: ${signed(tile.changePct)}% over 24 hours · click for detail`}><span>{tile.coin}</span><div><i className={tile.changePct < 0 ? "is-down" : "is-up"} style={{ width: `${(Math.abs(tile.changePct) / max) * 50}%`, [tile.changePct < 0 ? "right" : "left"]: "50%" }} /></div><b>{signed(tile.changePct)}%</b></button>)}</div>;
}

function Venue({ row }: { row: ReturnType<typeof venueGrid<LaneTile>>[number] }) {
  const cell = (lane: LaneTile | null) => lane ? <span className="v5m-lane" title={`${lane.lane} · 7-day coverage ${lane.coverage_7d == null ? "unknown" : `${(lane.coverage_7d * 100).toFixed(1)}%`} · missing minutes ${lane.gaps_7d ?? "unknown"}${lane.unavailable_reason ? ` · ${lane.unavailable_reason}` : ""}`}>
    <span className={lane.available === true ? "is-up" : lane.available === false ? "is-down" : "v5m-muted"} title={tri(lane.available, "available", "unavailable", "availability not reported")}>{lane.available === true ? "●" : lane.available === false ? "○" : "?"} {lane.pairs_held ?? "?"}/{lane.pairs_listed ?? "?"}</span>
    <span>{lane.coverage_24h == null ? "—" : `${(lane.coverage_24h * 100).toFixed(0)}%`}</span>
    <span className="v5m-muted">{lane.last_minute_age_s == null ? "—" : `${Math.round(lane.last_minute_age_s)} s`}</span>
  </span> : <span className="v5m-lane is-none">not held</span>;
  return <><span className="v5m-venue">{venueName(row.venue)}</span>{cell(row.spot)}{cell(row.perpetual)}</>;
}

function Stat({ label, value, note, warn, title }: { label: string; value: string; note?: string; warn?: boolean; title?: string }) {
  return <div className={`v5m-stat${warn ? " is-warn" : ""}`} title={title}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}
