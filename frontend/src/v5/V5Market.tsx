import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
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
import { candleCurrent, hourlyReturns, marketHolding, marketSentence, windowChange } from "./market-header";
import { readMarketPaper } from "./market-paper";
import { usePaperClock } from "./usePaperClock";
import { ageSeconds, breadth, coinTile, indexedReturns, laneHealthClass, MARKET_COINS, premiumSeries, REFERENCE, STALE_AFTER_S, storeHealth, venueGrid, type CandleRead, type LaneTile } from "./market-model.mjs";
import { age as ageShort, fixed, pct, price, signed, utcMin } from "./format.mjs";
import { tri } from "./shown.mjs";
import "./market.css";

/** Fixed coin identity colours (validated categorical order, dark steps); a coin keeps its colour on every chart. */
const COIN_COLOR: Record<string, string> = { BTC: "#3987e5", ETH: "#d95926", BNB: "#199e70", SOL: "#c98500", XRP: "#d55181" };
const REFRESH_MS = 60_000;
const RANGES = ["1h", "6h", "24h", "7d"] as const;

type Summary = { now: number; status_age_s: number | null; tiles: LaneTile[] };
type CoinRead = { spot: CandleRead | null; perpetual: CandleRead | null; error: string | null; perpetualError: string | null; receivedAt: number };
type CrossRead = { coin: string; table: CrossStats[] | null; error: string | null };

const minuteText = (seconds: number | null | undefined) => utcMin(seconds == null ? null : seconds * 1000) ?? "unknown";
const ageText = (seconds: number | null) => seconds == null ? "age unknown" : `${ageShort(seconds)} ago`;
const venueName = (venue: string) => venue.replace("_io", ".io");
const failure = (cause: unknown) => cause instanceof Error ? cause.message : "owner read unavailable";

/** Reads run one after another: the owner serves two concurrent reads, and other pages share them. */
async function readCoins(range: string): Promise<Record<string, CoinRead>> {
  const out: Record<string, CoinRead> = {};
  for (const coin of MARKET_COINS) {
    const pair = `${coin}-${REFERENCE.quote}`;
    let spot: CandleRead | null = null, perpetual: CandleRead | null = null, error: string | null = null, perpetualError: string | null = null;
    try { spot = await readCandleStore<CandleRead>("candles", { lane: REFERENCE.spot, pair, range }); } catch (cause) { error = failure(cause); }
    const receivedAt = Date.now();
    try { perpetual = await readCandleStore<CandleRead>("candles", { lane: REFERENCE.perpetual, pair, range }); } catch (cause) { perpetualError = failure(cause); }
    out[coin] = { spot, perpetual, error, perpetualError, receivedAt };
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

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <section className="v5m-section"><header><h2>{title}</h2>{note && <span>{note}</span>}</header>{children}</section>;
}

function Card({ title, hint, children, className }: { title: string; hint?: string; children: React.ReactNode; className?: string }) {
  return <article className={`v5m-card${className ? ` ${className}` : ""}`}><h3>{title}</h3>{hint && <p className="v5m-hint">{hint}</p>}{children}</article>;
}

export function V5Market() {
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h");
  const summary = useQuery({ queryKey: ["v5-market", "summary"], queryFn: () => readCandleStore<Summary>("summary"), retry: false, refetchInterval: REFRESH_MS });
  const coins = useQuery({ queryKey: ["v5-market", "coins", range], queryFn: () => readCoins(range), retry: false, refetchInterval: REFRESH_MS });
  const cross = useQuery({ queryKey: ["v5-market", "cross"], queryFn: readCross, retry: false, refetchInterval: REFRESH_MS, enabled: coins.isSuccess });
  const workspace = useQuery({ queryKey: ["v5-workspace"], queryFn: v5Api.workspace, refetchInterval: 30_000 });
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile, retry: false });
  const bot = profile.isSuccess ? profile.data.readiness.paper_owner?.bot_name : null;
  const paper = useQuery({ queryKey: ["v5-market", "paper", bot], enabled: Boolean(bot), queryFn: ({ signal }) => readMarketPaper(bot!, signal), retry: false, refetchInterval: 15_000 });
  // The open coin detail lives in the address (/market/BTC), so it can be linked and Back closes it.
  const { coin: routeCoin } = useParams();
  const navigate = useNavigate();
  const selected = routeCoin && MARKET_COINS.includes(routeCoin) ? routeCoin : null;
  const setSelected = (coin: string | null) => navigate(coin ? `/market/${coin}` : "/market");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const select = (coin: string) => setSelected(selected === coin ? null : coin);
  const now = usePaperClock();
  const toggleSeries = (coin: string) => setHidden(current => { const next = new Set(current); if (next.has(coin)) next.delete(coin); else next.add(coin); return next; });

  const reads = coins.isSuccess ? coins.data : {};
  const tiles = MARKET_COINS.map(coin => coinTile(coin, reads[coin]?.spot, reads[coin]?.perpetual));
  const current = Object.fromEntries(MARKET_COINS.map(coin => [coin, candleCurrent(reads[coin]?.spot, reads[coin]?.receivedAt ?? 0, now)]));
  const changes = Object.fromEntries(MARKET_COINS.map(coin => [coin, current[coin] ? windowChange(reads[coin]?.spot) : null]));
  const holdings = Object.fromEntries(MARKET_COINS.map((coin, index) => [coin, marketHolding(coin, paper.isSuccess ? paper.data : undefined, bot, current[coin] ? tiles[index]?.last ?? null : null, REFERENCE.quote, now)]));
  const age = (coin: string, minuteT: number) => reads[coin]?.spot ? ageSeconds(minuteT, reads[coin].spot!, reads[coin].receivedAt, now) : null;
  const returns: Record<string, ReturnType<typeof indexedReturns>> = Object.fromEntries(MARKET_COINS.map(coin => [coin, indexedReturns(reads[coin]?.spot)]));
  const width = breadth(tiles.map(tile => tile && ({ ...tile, changePct: changes[tile.coin] == null ? null : Number(changes[tile.coin]), change1hPct: current[tile.coin] ? tile.change1hPct : null })));
  const returnSeries: ChartSeries[] = MARKET_COINS.filter(coin => returns[coin].length).map(coin => ({ id: coin, label: coin, color: COIN_COLOR[coin], points: returns[coin], format: value => pct(value) }));
  const premium: ChartSeries[] = MARKET_COINS.map(coin => ({ coin, points: premiumSeries(reads[coin]?.spot, reads[coin]?.perpetual) }))
    .filter(item => item.points.some(point => point.value != null)).map(({ coin, points }) => ({ id: coin, label: coin, color: COIN_COLOR[coin], points, format: value => `${signed(value, 1)} bp` }));
  // After a failed refetch TanStack keeps the old data; only a successful read is shown as the store's state.
  const lanes = summary.isSuccess ? summary.data.tiles : [];
  const health = storeHealth(lanes);
  // The owner's age at read time plus local time since the read arrived, so the chip ticks between reads.
  const slowestAge = health.oldestMinuteAge == null || !summary.dataUpdatedAt ? null : health.oldestMinuteAge + Math.max(0, now - summary.dataUpdatedAt) / 1000;
  const statusAge = summary.isSuccess && summary.data.status_age_s != null ? summary.data.status_age_s + Math.max(0, now - summary.dataUpdatedAt) / 1000 : null;
  const storeCurrent = statusAge != null && statusAge >= 0 && statusAge <= STALE_AFTER_S && slowestAge != null && slowestAge <= STALE_AFTER_S;
  const grid = venueGrid(lanes);
  const evidence = workspace.data?.context ?? null;
  const cohort = evidence ? selectedCohortCoverage(evidence) : null;
  const refresh = workspace.data?.source_refresh;
  const feedCurrent = workspace.isSuccess && refresh?.feed_freshness === "FRESH" && refresh.feed_fresh_until_ms != null && now <= refresh.feed_fresh_until_ms;
  const failed = MARKET_COINS.filter(coin => reads[coin]?.error);
  const crossVenues = [...new Set((cross.data ?? []).flatMap(read => (read.table ?? []).map(row => row.venue)))].sort();

  return <div className="v5m">
    <header className="v5m-head">
      <h1>Market</h1>
      <div role="group" aria-label="Market range" className="v5m-seg">{RANGES.map(item => <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>)}</div>
      <div className="v5m-chips">
        <span className={`v5m-chip ${summary.isError ? "is-warn" : summary.isPending || !health.lanes || statusAge == null ? "is-unknown" : !storeCurrent ? "is-warn" : health.ownerHealth === "red" ? "is-bad" : health.ownerHealth === "amber" ? "is-warn" : health.ownerHealth === "unknown" ? "is-unknown" : ""}`}><i />Candle store <b>{summary.isError ? "unavailable" : summary.isPending ? "reading" : !health.lanes || statusAge == null ? "— data incomplete" : !storeCurrent ? "— not current" : `${health.lanesUnknown ? "— · lane availability incomplete" : `${health.lanesAvailable}/${health.lanes} lanes available`} · owner health ${health.ownerHealth}`}</b></span>
        <span className={`v5m-chip ${feedCurrent ? "" : workspace.isError || refresh ? "is-warn" : "is-unknown"}`}><i />V5 feed <b>{feedCurrent ? "current" : workspace.isError ? "unavailable" : refresh ? "not current" : "no data"}</b></span>
      </div>
    </header>
    <p className="v5m-summary">{marketSentence(changes, range)}</p>

    {coins.isPending && <p role="status" className="v5m-status">Reading {range} of candles for {MARKET_COINS.join(", ")}…</p>}
    {coins.isError && <p role="alert" className="v5m-status">Candle refresh failed: {coins.error.message}. Earlier prices are not shown.</p>}
    {failed.length > 0 && <p role="alert" className="v5m-status">No candles for {failed.map(coin => `${coin} (${reads[coin].error})`).join(", ")}. Those tiles are left out.</p>}

    <TileGrid label="Coins" min={200}>{tiles.map((tile, index) => tile ? <article key={tile.coin} className={`v5m-card v5m-coin is-clickable${selected === tile.coin ? " is-selected" : ""}`} role="button" tabIndex={0} aria-pressed={selected === tile.coin} aria-label={`${tile.coin}: open statistics, candles and venue detail`} onClick={() => select(tile.coin)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(tile.coin); } }}>
      <div className="v5m-coin-top"><span className="v5m-sym"><i style={{ background: COIN_COLOR[tile.coin] }} />{tile.coin}</span><span className="v5m-change">{range} {changes[tile.coin] == null ? "—" : pct(changes[tile.coin])}</span></div>
      <strong className="v5m-price">{current[tile.coin] ? `${price(tile.last)} ${REFERENCE.quote}` : "—"}</strong><small className={`v5m-asof${current[tile.coin] ? "" : " is-old"}`}>{current[tile.coin] ? "Close" : "— close not current"} · {minuteText(tile.lastTime + 60)} · {ageText(age(tile.coin, tile.lastTime))}</small>
      {changes[tile.coin] == null && <small className="v5m-asof">— {range} change: current boundary closes required.</small>}
      <SparkChart points={tile.spark} color={COIN_COLOR[tile.coin]} height={44} format={price} unit={REFERENCE.quote} ariaLabel={`${tile.coin} recorded prices, ${range}, breaks where minutes are missing`} />
      <HoldingLine holding={holdings[tile.coin]} error={paper.isError ? paper.error.message : null} now={now} />
      <dl className="v5m-kv"><dt>Perpetual premium</dt><dd>{reads[tile.coin]?.perpetualError ? "— perpetual read failed" : tile.premiumBps == null || tile.premiumTime == null ? "— no paired closes" : (() => { const seconds = age(tile.coin, tile.premiumTime); return seconds == null || seconds > STALE_AFTER_S ? "— paired close not current" : `${signed(tile.premiumBps, 1)} bp · ${minuteText(tile.premiumTime + 60)} · ${ageText(seconds)}`; })()}</dd></dl>
    </article> : <article key={MARKET_COINS[index]} className="v5m-card v5m-coin is-empty"><span className="v5m-sym">{MARKET_COINS[index]}</span><strong className="v5m-price">—</strong><p>{coins.isPending ? "Loading…" : reads[MARKET_COINS[index]]?.error ? `Candle read failed: ${reads[MARKET_COINS[index]].error}` : `No closed minute in ${range}.`}</p><HoldingLine holding={holdings[MARKET_COINS[index]]} error={paper.isError ? paper.error.message : null} now={now} /></article>)}</TileGrid>
    {selected ? <V5MarketDetail key={selected} coin={selected} color={COIN_COLOR[selected]} onClose={() => setSelected(null)} tileRead={range === "24h" && coins.isSuccess && reads[selected]?.spot ? reads[selected] as unknown as DetailRead : null} /> : <p className="v5m-hint v5m-tip">Click a coin for its candles, minutes held and venue-by-venue price gaps.</p>}

    <Section title="Hour-by-hour returns" note={`${range} · ${venueName(REFERENCE.venue)} spot · ${REFERENCE.quote} · UTC`}>
      <p className="v5m-hint">Each hour needs its preceding close and all 60 final minutes. Incomplete hours and gaps stay grey; no prices are carried forward.</p>
      <HourStrip reads={reads} />
    </Section>

    <Section title="Moves" note={`${venueName(REFERENCE.venue)} spot, 1-minute candles sampled every 5 minutes`}>
      <div className="v5m-row v5m-row--wide">
        <Card title={`Return over ${range}`} hint="Each coin starts at 0% at the window's first minute (a coin without that minute is left out) · lines break where minutes are missing · hover for values">
          <TimeSeriesChart series={returnSeries.filter(item => !hidden.has(item.id))} height={260} zeroLine includeZero signed ariaLabel={`Return of each coin over ${range}`} leftFormat={value => pct(value)} emptyText="No candles to plot yet." />
          <Legend series={returnSeries} hidden={hidden} onToggle={toggleSeries} />
        </Card>
        <Card title="Breadth" hint="How many of the five coins are up" className="v5m-breadth">
          <div className="v5m-big"><div><strong>{width.measured ? width.up : "—"}<small> of {width.measured} up</small></strong><span>over {range}</span></div><div><strong>{width.measured1h ? width.up1h : "—"}<small> of {width.measured1h} up</small></strong><span>over the last hour</span></div></div>
          <ReturnBars tiles={MARKET_COINS.flatMap(coin => changes[coin] == null ? [] : [{ coin, changePct: changes[coin]! }])} range={range} selected={selected} onSelect={select} />
        </Card>
      </div>
    </Section>

    <Section title="Spot versus perpetual" note={`${venueName(REFERENCE.venue)} perpetual over spot, same quote · 100 bp = 1%`}>
      <div className="v5m-row">
        <Card title={`Perpetual premium, ${range}`} hint="Every fifth minute where both legs closed · above 0: the perpetual trades above spot · hover for values">
          <TimeSeriesChart series={premium.filter(item => !hidden.has(item.id))} height={240} zeroLine includeZero signed ariaLabel="Perpetual premium over spot by coin" leftFormat={value => `${signed(value, 1)} bp`} emptyText="No minute where both spot and perpetual closed." />
          <Legend series={premium} hidden={hidden} onToggle={toggleSeries} />
        </Card>
        <Card title="Same coin, different venue" hint="Average gap of each venue's spot close from the median of venues over the last hour, basis points (owner-computed; hover for minutes compared)">
          {cross.isPending ? <p role="status" className="v5m-hint">Reading cross-venue prices…</p> : !cross.data || crossVenues.length === 0 ? <p className="v5m-hint">Cross-venue statistics unavailable{cross.data?.some(read => read.error) ? `: ${cross.data.find(read => read.error)!.error}` : ""}.</p> :
            <table className="v5m-heat"><thead><tr><th>Venue</th>{cross.data.map(read => <th key={read.coin} title={read.error ?? undefined}>{read.coin}{read.error ? " (read failed)" : ""}</th>)}</tr></thead><tbody>{crossVenues.map(venue => <tr key={venue}><td>{venueName(venue)}</td>{cross.data!.map(read => {
              const row = read.table?.find(item => item.venue === venue);
              if (!row || row.mean_bps == null || !row.n) return <td key={read.coin} className="is-none" title={read.error ? "read failed" : row ? "no minute compared" : "no row from the owner for this venue"}>—</td>;
              const bps = row.mean_bps, strength = Math.min(Math.abs(bps) / 12, 1) * 0.45;
              return <td key={read.coin} className={`is-clickable${selected === read.coin ? " is-selected" : ""}`} onClick={() => select(read.coin)} title={`${venueName(venue)} ${row.pair}: mean ${signed(bps, 2)} bp over ${row.n} minutes · p95 |gap| ${row.p95_abs_bps == null ? "—" : fixed(row.p95_abs_bps, 1)} bp · click for ${read.coin} detail`} style={{ background: Math.abs(bps) < 0.5 ? undefined : `color-mix(in srgb, ${bps < 0 ? "var(--color-red)" : "var(--color-green)"} ${Math.round(strength * 100)}%, transparent)` }}>{signed(bps, 1)}</td>;
            })}</tr>)}</tbody></table>}
          <p className="v5m-hint">Green: above the median of venues, red: below. Quotes can differ (USDT, USD, USDC), so part of a gap can be the quote currency, not the venue.</p>
        </Card>
      </div>
    </Section>

    <Section title="V5 market features" note={`What the V5 engine computes from all venues every 20 seconds · packet cut at ${utcMin(evidence?.cutoff_ms) ?? "unknown"}`}>
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
            <Stat label="Lanes available" value={summary.isSuccess && health.lanes && !health.lanesUnknown ? `${health.lanesAvailable}/${health.lanes}` : "—"} warn={health.lanesUnknown > 0} note={health.lanesUnknown ? `${health.lanesUnknown} lane(s) did not report availability` : health.pairsHeld == null || health.pairsListed == null ? `pair counts: ${health.unreported.pairs} lane(s) unreported` : `${health.pairsHeld}/${health.pairsListed} pairs held`} />
            <Stat label="7-day coverage" value={health.coverage7d == null ? "—" : `${(health.coverage7d * 100).toFixed(1)}%`} note={health.coverage7d == null && health.unreported.coverage ? `${health.unreported.coverage} lane(s) unreported` : "final 1-minute candles, all lanes"} />
            <Stat label="Missing minutes, 7 days" value={health.gaps7d == null ? "—" : String(health.gaps7d)} note={health.gaps7d == null && health.unreported.gaps ? `${health.unreported.gaps} lane(s) unreported` : "all lanes"} />
            <Stat label="Slowest lane" value={slowestAge == null ? "—" : ageShort(slowestAge)} note={health.oldestMinuteAge == null && health.unreported.age ? `${health.unreported.age} lane(s) unreported` : "since its newest final minute closed; up to ~95 s is normal"} />
          </div>
          <h3 className="v5m-subhead">V5 market-context feed</h3>
          <p className="v5m-hint">What the V5 engine receives every 20 seconds · last success {utcMin(refresh?.last_success_at_ms) ?? "unknown"}</p>
          {workspace.isError ? <p role="alert" className="v5m-hint">Workspace read failed: {workspace.error.message}.</p> : !cohort ? <p className="v5m-hint">{workspace.isPending ? "Reading the feed…" : "The feed returned no market evidence. No coverage is inferred."}</p> :
            <div className="v5m-stats">{cohort.dimensions.map(item => <Stat key={item.key} label={item.label} value={item.valid == null || item.expected == null ? "—" : `${item.valid}/${item.expected}`} note={item.fraction == null ? "not qualified" : `${(item.fraction * 100).toFixed(0)}% this minute`} title="Pairs that passed the V5 feed's qualification rule for its newest minute, out of the pairs the feed expects (the owner's own counts). The candle store panel counts pairs present in the store, a different and larger count." warn={item.fraction != null && item.fraction < 1} />)}</div>}
        </Card>
      </div>
    </Section>

    <details className="v5m-details" onToggle={event => setDetailsOpen(event.currentTarget.open)}><summary>Candle store details: every lane and instrument, candle chart, coverage heatmap, store facts</summary>{detailsOpen && <V5CandleStore />}</details>
  </div>;
}

function HoldingLine({ holding, error, now }: { holding: ReturnType<typeof marketHolding>; error: string | null; now: number }) {
  return <><p className="v5m-holding">{holding.text}</p><small className="v5m-asof">{error ?? holding.reason}{holding.asOf != null && <> · Paper {utcMin(holding.asOf)} · {ageText((now - holding.asOf) / 1000)}</>}</small></>;
}

function HourStrip({ reads }: { reads: Record<string, CoinRead> }) {
  const rows: { coin: string; hours: Map<number, ReturnType<typeof hourlyReturns>[number]> }[] = MARKET_COINS.map(coin => ({ coin, hours: new Map(hourlyReturns(reads[coin]?.spot).map(hour => [hour.from, hour])) }));
  const times = [...new Set<number>(rows.flatMap(row => [...row.hours.keys()]))].sort((left, right) => left - right);
  if (!times.length) return <p className="v5m-hint">— candle reads unavailable for {MARKET_COINS.join(", ")}.</p>;
  return <div className="v5m-hour-scroll"><table className="v5m-hour-strip" aria-label="Hourly coin returns, UTC">
    <thead><tr><th scope="col">UTC hour</th>{times.map(time => <th scope="col" key={time}>{utcMin(time * 1000)}</th>)}</tr></thead>
    <tbody>{rows.map(({ coin, hours }) => <tr key={coin}><th scope="row">{coin}</th>{times.map(time => {
      const hour = hours.get(time), value = hour?.change ?? null;
      const label = value == null ? "— incomplete hour or missing minute" : pct(value);
      return <td key={time} className={`v5m-hour${value == null ? " is-gap" : ""}`} title={`${coin} · ${utcMin(time * 1000)} – ${utcMin((time + 3600) * 1000)} · ${label}`} style={value == null ? undefined : { background: `color-mix(in srgb, ${COIN_COLOR.BTC} ${Math.min(85, 12 + Math.abs(Number(value)) * 15)}%, var(--color-surface))` }}>{value == null ? <span aria-label={label}>—</span> : label}</td>;
    })}</tr>)}</tbody>
  </table></div>;
}

function Legend({ series, hidden, onToggle }: { series: ChartSeries[]; hidden: ReadonlySet<string>; onToggle: (id: string) => void }) {
  return <div className="v5m-legend" role="group" aria-label="Show or hide coins">{series.map(item => { const last = [...item.points].reverse().find(point => point.value != null); const off = hidden.has(item.id); return <button type="button" key={item.id} aria-pressed={!off} className={off ? "is-off" : ""} onClick={() => onToggle(item.id)} title={off ? `Show ${item.label}` : `Hide ${item.label}`}><i style={{ background: item.color }} />{item.label} <b>{last?.value == null ? "—" : item.format!(last.value)}</b></button>; })}</div>;
}

function ReturnBars({ tiles, range, selected, onSelect }: { tiles: { coin: string; changePct: string }[]; range: string; selected: string | null; onSelect: (coin: string) => void }) {
  const sorted = [...tiles].sort((left, right) => Number(right.changePct) - Number(left.changePct));
  const max = Math.max(...sorted.map(tile => Math.abs(Number(tile.changePct))), 0.01);
  return <div className="v5m-bars">{sorted.map(tile => <button type="button" key={tile.coin} className={`v5m-bar${selected === tile.coin ? " is-selected" : ""}`} aria-pressed={selected === tile.coin} onClick={() => onSelect(tile.coin)} title={`${tile.coin}: ${pct(tile.changePct)} over ${range} · click for detail`}><span>{tile.coin}</span><div><i style={{ width: `${(Math.abs(Number(tile.changePct)) / max) * 50}%`, background: "var(--color-primary)", [Number(tile.changePct) < 0 ? "right" : "left"]: "50%" }} /></div><b>{pct(tile.changePct)}</b></button>)}</div>;
}

function Venue({ row }: { row: ReturnType<typeof venueGrid<LaneTile>>[number] }) {
  const cell = (lane: LaneTile | null) => lane ? <span className="v5m-lane" title={`${lane.lane} · 7-day coverage ${lane.coverage_7d == null ? "unknown" : `${(lane.coverage_7d * 100).toFixed(1)}%`} · missing minutes ${lane.gaps_7d ?? "unknown"}${lane.unavailable_reason ? ` · ${lane.unavailable_reason}` : ""}`}>
    <span className={laneHealthClass(lane.health)} title={`Owner health: ${lane.health ?? "not reported"} · ${tri(lane.available, "available", "unavailable", "availability not reported")}`}>● {lane.pairs_held ?? "?"}/{lane.pairs_listed ?? "?"}</span>
    <span>{lane.coverage_24h == null ? "—" : `${(lane.coverage_24h * 100).toFixed(0)}%`}</span>
    <span className="v5m-muted">{lane.last_minute_age_s == null ? "—" : ageShort(lane.last_minute_age_s)}</span>
  </span> : <span className="v5m-lane is-none">not held</span>;
  return <><span className="v5m-venue">{venueName(row.venue)}</span>{cell(row.spot)}{cell(row.perpetual)}</>;
}

function Stat({ label, value, note, warn, title }: { label: string; value: string; note?: string; warn?: boolean; title?: string }) {
  return <div className={`v5m-stat${warn ? " is-warn" : ""}`} title={title}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}
