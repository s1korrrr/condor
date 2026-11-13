import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { SparkChart, TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { TileGrid } from "@/features/quant-ops/kit/grid";
import type { ChartSeries } from "@/features/quant-ops/kit/series";
import { V5CandleStore } from "./V5CandleStore";
import { readCandleStore } from "./candle-store-api";
import { selectedCohortCoverage } from "./evidence";
import { V5MarketDetail } from "./V5MarketDetail";
import { V5MarketFeatures } from "./V5MarketFeatures";
import { v5Api } from "./api";
import { averaged, breadth, coinTile, crossLatest, indexedReturns, MARKET_COINS, premiumSeries, REFERENCE, storeHealth, venueGrid, type CandleRead, type CrossCell, type LaneTile } from "./market-model.mjs";
import "./market.css";

/** Fixed coin identity colours (validated categorical order, dark steps); a coin keeps its colour on every chart. */
const COIN_COLOR: Record<string, string> = { BTC: "#3987e5", ETH: "#d95926", BNB: "#199e70", SOL: "#c98500", XRP: "#d55181" };
const REFRESH_MS = 60_000;

type Summary = { now: number; status_age_s: number | null; tiles: LaneTile[] };
type CoinReads = Record<string, { spot: CandleRead; perpetual: CandleRead; error: string | null }>;

const signed = (value: number, digits = 2) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
const price = (value: number) => value >= 1000 ? value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : value >= 10 ? value.toFixed(2) : value.toFixed(4);
const utc = (seconds: number | null | undefined) => seconds == null ? "unavailable" : `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")}Z`;
const venueName = (venue: string) => venue.replace("_io", ".io");

/** Reads run one after another: the owner serves two concurrent reads, and other pages share them. */
async function readCoins(): Promise<CoinReads> {
  const out: CoinReads = {};
  for (const coin of MARKET_COINS) {
    const pair = `${coin}-${REFERENCE.quote}`;
    try {
      const spot = await readCandleStore<NonNullable<CandleRead>>("candles", { lane: REFERENCE.spot, pair, range: "24h" });
      const perpetual = await readCandleStore<NonNullable<CandleRead>>("candles", { lane: REFERENCE.perpetual, pair, range: "24h" }).catch(() => null);
      out[coin] = { spot, perpetual, error: null };
    } catch (cause) {
      out[coin] = { spot: null, perpetual: null, error: cause instanceof Error ? cause.message : "Owner read unavailable" };
    }
  }
  return out;
}

async function readCross(): Promise<CrossCell[]> {
  const cells: CrossCell[] = [];
  for (const coin of MARKET_COINS) {
    const view = await readCandleStore<Parameters<typeof crossLatest>[1]>("cross", { asset: coin, segment: "spot", range: "1h" }).catch(() => null);
    cells.push(...crossLatest(coin, view));
  }
  return cells;
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
  const toggleSeries = (coin: string) => setHidden(current => { const next = new Set(current); if (next.has(coin)) next.delete(coin); else next.add(coin); return next; });

  const reads = coins.data ?? {};
  const tiles = MARKET_COINS.map(coin => coinTile(coin, reads[coin]?.spot, reads[coin]?.perpetual));
  const returns: Record<string, ReturnType<typeof indexedReturns>> = Object.fromEntries(MARKET_COINS.map(coin => [coin, indexedReturns(reads[coin]?.spot)]));
  const width = breadth(tiles);
  const returnSeries: ChartSeries[] = MARKET_COINS.filter(coin => returns[coin].length).map(coin => ({ id: coin, label: coin, color: COIN_COLOR[coin], points: returns[coin], unit: "%", format: value => `${signed(value)}%` }));
  const premium: ChartSeries[] = MARKET_COINS.map(coin => ({ coin, points: averaged(premiumSeries(reads[coin]?.spot, reads[coin]?.perpetual), 30) }))
    .filter(item => item.points.length).map(({ coin, points }) => ({ id: coin, label: coin, color: COIN_COLOR[coin], points, unit: "bp", format: value => `${signed(value, 1)} bp` }));
  const lanes = summary.data?.tiles ?? [];
  const health = storeHealth(lanes);
  const grid = venueGrid(lanes);
  const evidence = workspace.data?.context ?? null;
  const cohort = evidence ? selectedCohortCoverage(evidence) : null;
  const refresh = workspace.data?.source_refresh;
  const feedCurrent = refresh?.feed_freshness === "FRESH" && refresh.feed_fresh_until_ms != null && Date.now() <= refresh.feed_fresh_until_ms;
  const failed = MARKET_COINS.filter(coin => reads[coin]?.error);
  const crossVenues = [...new Set((cross.data ?? []).map(cell => cell.venue))].sort();

  return <div className="v5m">
    <header className="v5m-head">
      <div><h1>Market</h1><p>Five coins across {grid.length || "the"} venues, spot and perpetual · prices, breadth, premium, venue coverage and data health on one page. Prices: {venueName(REFERENCE.venue)} {REFERENCE.quote} 1-minute candles; a price older than the last closed minute says so on its tile.</p></div>
      <div className="v5m-chips">
        <span className={`v5m-chip ${summary.isError ? "is-bad" : health.lanesLive === health.lanes && health.lanes ? "" : "is-warn"}`}><i />Candle store <b>{summary.isError ? "unavailable" : `${health.lanesLive}/${health.lanes} lanes live`}</b></span>
        <span className={`v5m-chip ${feedCurrent ? "" : "is-warn"}`}><i />V5 feed <b>{refresh ? (feedCurrent ? "current" : "not current") : "unknown"}</b></span>
        <span className="v5m-chip"><i />Newest minute <b>{health.oldestMinuteAge == null ? "unknown" : `${Math.round(health.oldestMinuteAge)} s old`}</b></span>
        <button className="v5m-refresh" onClick={() => { void summary.refetch(); void coins.refetch(); void workspace.refetch(); }}><RotateCw size={14} />Refresh</button>
      </div>
    </header>

    {coins.isPending && <p role="status" className="v5m-status">Reading 24 hours of candles for {MARKET_COINS.join(", ")}…</p>}
    {coins.isError && <p role="alert" className="v5m-status">Candle store read failed: {coins.error.message}. No prices are shown instead of old ones.</p>}
    {failed.length > 0 && <p role="alert" className="v5m-status">No candles for {failed.map(coin => `${coin} (${reads[coin].error})`).join(", ")}. Those tiles are left out.</p>}

    <TileGrid label="Coins" min={200}>{tiles.map((tile, index) => tile ? <article key={tile.coin} className={`v5m-card v5m-coin is-clickable${selected === tile.coin ? " is-selected" : ""}`} role="button" tabIndex={0} aria-pressed={selected === tile.coin} aria-label={`${tile.coin}: open statistics, candles and venue detail`} onClick={() => select(tile.coin)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(tile.coin); } }}>
      <div className="v5m-coin-top"><span className="v5m-sym"><i style={{ background: COIN_COLOR[tile.coin] }} />{tile.coin}</span><span className={`v5m-change ${tile.changePct < 0 ? "is-down" : "is-up"}`}>{tile.changePct < 0 ? "▼" : "▲"} {signed(tile.changePct)}%</span></div>
      <strong className="v5m-price">${price(tile.last)}</strong>{!tile.current && <small className="v5m-asof" role="note">last close {utc(tile.lastTime)} · newer minutes missing</small>}
      <SparkChart points={tile.spark} color={COIN_COLOR[tile.coin]} height={44} format={price} unit={REFERENCE.quote} ariaLabel={`${tile.coin} price, last 24 hours`} />
      <div className="v5m-range" title="Where the last price sits between the 24-hour low and high"><div><span style={{ left: `${((tile.last - tile.low) / ((tile.high - tile.low) || 1)) * 100}%` }} /></div><small><span>24h low {price(tile.low)}</span><span>high {price(tile.high)}</span></small></div>
      <dl className="v5m-kv"><dt>Perpetual premium</dt><dd>{tile.premiumBps == null ? "no perpetual close that minute" : `${signed(tile.premiumBps, 1)} bp`}</dd><dt>Volatility (annualised)</dt><dd>{tile.volatilityPct == null ? "too few minutes" : `${tile.volatilityPct.toFixed(0)}%`}</dd></dl>
    </article> : <article key={MARKET_COINS[index]} className="v5m-card v5m-coin is-empty"><span className="v5m-sym">{MARKET_COINS[index]}</span><p>{coins.isPending ? "Loading…" : "No closed minutes in the last 24 hours."}</p></article>)}</TileGrid>
    {selected ? <V5MarketDetail key={selected} coin={selected} color={COIN_COLOR[selected]} onClose={() => setSelected(null)} /> : <p className="v5m-hint v5m-tip">Click a coin for its candles, window statistics and venue-by-venue price gaps.</p>}

    <Section title="Moves" note={`${venueName(REFERENCE.venue)} spot, 1-minute candles sampled every 5 minutes`}>
      <div className="v5m-row v5m-row--wide">
        <Card title="Return over the last 24 hours" hint="Each coin starts at 0% at the beginning of the window · hover for values">
          <TimeSeriesChart series={returnSeries.filter(item => !hidden.has(item.id))} height={260} zeroLine includeZero signed ariaLabel="Return of each coin over the last 24 hours" leftFormat={value => `${signed(value)}%`} emptyText="No candles to plot yet." />
          <Legend series={returnSeries} hidden={hidden} onToggle={toggleSeries} />
        </Card>
        <Card title="Breadth" hint="How many of the five coins are up" className="v5m-breadth">
          <div className="v5m-big"><div><strong>{width.up24h}<small> of {width.coins} up</small></strong><span>over 24 hours</span></div><div><strong>{width.up1h}<small> of {width.measured1h} up</small></strong><span>over the last hour</span></div></div>
          <p className="v5m-hint">Average 24-hour return <b className={width.averagePct != null && width.averagePct < 0 ? "is-down" : "is-up"}>{width.averagePct == null ? "unavailable" : `${signed(width.averagePct)}%`}</b></p>
          <ReturnBars tiles={tiles.filter((tile): tile is NonNullable<typeof tile> => tile !== null)} selected={selected} onSelect={select} />
        </Card>
      </div>
    </Section>

    <Section title="Spot versus perpetual" note={`${venueName(REFERENCE.venue)} perpetual over spot, same quote · 100 bp = 1%`}>
      <div className="v5m-row">
        <Card title="Perpetual premium, last 24 hours" hint="30-minute averages · above 0: the perpetual trades above spot · hover for values">
          <TimeSeriesChart series={premium.filter(item => !hidden.has(item.id))} height={240} zeroLine includeZero signed ariaLabel="Perpetual premium over spot by coin" leftFormat={value => `${signed(value, 1)} bp`} emptyText="No minute where both spot and perpetual closed." />
          <Legend series={premium} hidden={hidden} onToggle={toggleSeries} />
        </Card>
        <Card title="Same coin, different venue" hint="Latest spot close against the median of all venues, basis points (owner-computed, last hour)">
          {cross.isPending ? <p role="status" className="v5m-hint">Reading cross-venue prices…</p> : crossVenues.length === 0 ? <p className="v5m-hint">Cross-venue read unavailable.</p> :
            <table className="v5m-heat"><thead><tr><th>Venue</th>{MARKET_COINS.map(coin => <th key={coin}>{coin}</th>)}</tr></thead><tbody>{crossVenues.map(venue => <tr key={venue}><td>{venueName(venue)}</td>{MARKET_COINS.map(coin => {
              const cell = cross.data!.find(item => item.venue === venue && item.coin === coin);
              if (!cell) return <td key={coin} className="is-none">not listed</td>;
              const strength = Math.min(Math.abs(cell.bps) / 12, 1) * 0.45;
              return <td key={coin} className={`is-clickable${selected === coin ? " is-selected" : ""}`} onClick={() => select(coin)} title={`${venueName(venue)} ${cell.pair}: ${cell.close ?? "?"} · ${signed(cell.bps, 1)} bp vs median at ${utc(cell.time)}`} style={{ background: Math.abs(cell.bps) < 0.5 ? undefined : `color-mix(in srgb, ${cell.bps < 0 ? "var(--color-red)" : "var(--color-green)"} ${Math.round(strength * 100)}%, transparent)` }}>{signed(cell.bps, 1)}</td>;
            })}</tr>)}</tbody></table>}
          <p className="v5m-hint">Green: above the median of venues, red: below. Quotes can differ (USDT, USD, USDC), so part of a gap can be the quote currency, not the venue.</p>
        </Card>
      </div>
    </Section>

    <Section title="V5 market features" note={`What the V5 engine computes from all venues every 20 seconds · packet cut at ${evidence?.cutoff_ms ? utc(evidence.cutoff_ms / 1000) : "unknown"}`}>
      <div className="v5m-card">{workspace.isPending ? <p role="status" className="v5m-hint">Reading the V5 feed…</p> : workspace.isError ? <p role="alert" className="v5m-hint">Workspace read failed: {workspace.error.message}.</p> : !evidence ? <p className="v5m-hint">The V5 feed returned no market evidence. No feature is inferred.</p> : <V5MarketFeatures features={evidence.features} cutoffMs={evidence.cutoff_ms ?? null} />}</div>
    </Section>

    <Section title="Venues and data health" note="Candle store and the V5 market-context feed">
      <div className="v5m-row">
        <Card title="Venue coverage" hint="Pairs held of listed · 24-hour candle coverage · age of the newest minute">
          {summary.isPending ? <p role="status" className="v5m-hint">Reading lanes…</p> : summary.isError ? <p role="alert" className="v5m-hint">Candle store read failed: {summary.error.message}.</p> :
            <div className="v5m-venues"><span>Venue</span><span>Spot</span><span>Perpetual</span>{grid.map(row => <Venue key={row.venue} row={row} />)}</div>}
        </Card>
        <Card title="Candle store health" hint="One store feeds V5, Helm and research">
          <div className="v5m-stats">
            <Stat label="Lanes live" value={summary.isSuccess ? `${health.lanesLive}/${health.lanes}` : "—"} note={health.pairsHeld == null || health.pairsListed == null ? `pair counts: ${health.unreported.pairs} lane(s) unreported` : `${health.pairsHeld}/${health.pairsListed} pairs held`} />
            <Stat label="7-day coverage" value={health.coverage7d == null ? "—" : `${(health.coverage7d * 100).toFixed(1)}%`} note={health.coverage7d == null && health.unreported.coverage ? `${health.unreported.coverage} lane(s) unreported` : "final 1-minute candles, all lanes"} />
            <Stat label="Missing minutes, 7 days" value={health.gaps7d == null ? "—" : String(health.gaps7d)} note={health.gaps7d == null && health.unreported.gaps ? `${health.unreported.gaps} lane(s) unreported` : "all lanes"} />
            <Stat label="Newest minute" value={health.oldestMinuteAge == null ? "—" : `${Math.round(health.oldestMinuteAge)} s`} note={health.oldestMinuteAge == null && health.unreported.age ? `${health.unreported.age} lane(s) unreported` : "oldest lane"} />
          </div>
          <h3 className="v5m-subhead">V5 market-context feed</h3>
          <p className="v5m-hint">What the V5 engine receives every 20 seconds · last success {refresh?.last_success_at_ms ? utc(refresh.last_success_at_ms / 1000) : "unknown"}</p>
          {workspace.isError ? <p role="alert" className="v5m-hint">Workspace read failed: {workspace.error.message}.</p> : !cohort ? <p className="v5m-hint">{workspace.isPending ? "Reading the feed…" : "The feed returned no market evidence. No coverage is inferred."}</p> :
            <div className="v5m-stats">{cohort.dimensions.map(item => <Stat key={item.key} label={item.label} value={item.valid == null || item.expected == null ? "—" : `${item.valid}/${item.expected}`} note={item.fraction == null ? "not qualified" : `${(item.fraction * 100).toFixed(0)}%`} warn={item.fraction != null && item.fraction < 1} />)}</div>}
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
    <span className={lane.available ? "is-up" : "is-down"}>{lane.available ? "●" : "○"} {lane.pairs_held ?? "?"}/{lane.pairs_listed ?? "?"}</span>
    <span>{lane.coverage_24h == null ? "—" : `${(lane.coverage_24h * 100).toFixed(0)}%`}</span>
    <span className="v5m-muted">{lane.last_minute_age_s == null ? "—" : `${Math.round(lane.last_minute_age_s)} s`}</span>
  </span> : <span className="v5m-lane is-none">not held</span>;
  return <><span className="v5m-venue">{venueName(row.venue)}</span>{cell(row.spot)}{cell(row.perpetual)}</>;
}

function Stat({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) {
  return <div className={`v5m-stat${warn ? " is-warn" : ""}`}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}
