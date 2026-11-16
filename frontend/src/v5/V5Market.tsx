import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { SparkChart, TimeSeriesChart } from "@/features/quant-ops/kit/charts";
import { TileGrid } from "@/features/quant-ops/kit/grid";
import type { ChartSeries } from "@/features/quant-ops/kit/series";
import { V5CandleStore } from "./V5CandleStore";
import { readCandleStore } from "./candle-store-api";
import type { CrossStats } from "./candle-store-model";
import { cohortCoverageDisplay, selectedCohortCoverage } from "./evidence";
import { V5MarketDetail, type DetailRead } from "./V5MarketDetail";
import { V5MarketFeatures } from "./V5MarketFeatures";
import { v5Api } from "./api";
import { candleCurrent, hourlyReturns, marketAverageTitle, marketHolding, marketSentence, windowChange } from "./market-header";
import { readMarketPaper } from "./market-paper";
import { usePaperClock } from "./usePaperClock";
import { ageSeconds, breadth, coinTile, indexedReturns, laneHealthClass, MARKET_COINS, premiumSeries, REFERENCE, STALE_AFTER_S, storeHealth, venueGrid, type CandleRead, type LaneTile } from "./market-model.mjs";
import { age as ageShort, axis, decimalShift, fixed, pct, price, rationalPercent, signed, utcMin } from "./format.mjs";
import { tri, utcMinute } from "./shown.mjs";
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
    <p className="v5m-summary" title={marketAverageTitle(changes)}>{marketSentence(changes, range)}</p>

    {coins.isPending && <p role="status" className="v5m-status">Reading {range} of candles for {MARKET_COINS.join(", ")}…</p>}
    {coins.isError && <p role="alert" className="v5m-status">Candle refresh failed: {coins.error.message}. Earlier prices are not shown.</p>}
    {failed.length > 0 && <p role="alert" className="v5m-status">No candles for {failed.map(coin => `${coin} (${reads[coin].error})`).join(", ")}. Those tiles are left out.</p>}

    <TileGrid label="Coins" min={200}>{tiles.map((tile, index) => tile ? <article key={tile.coin} className={`v5m-card v5m-coin is-clickable${selected === tile.coin ? " is-selected" : ""}`} role="button" tabIndex={0} aria-pressed={selected === tile.coin} aria-label={`${tile.coin}: open statistics, candles and venue detail`} onClick={() => select(tile.coin)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(tile.coin); } }}>
      <div className="v5m-coin-top"><span className="v5m-sym"><i style={{ background: COIN_COLOR[tile.coin] }} />{tile.coin}</span><span className="v5m-change" title={changes[tile.coin] == null ? undefined : `result ${changes[tile.coin]}%; first close ${reads[tile.coin]?.spot?.buckets[0]?.[4]}; last close ${reads[tile.coin]?.spot?.buckets.at(-1)?.[4]}`}>{range} {changes[tile.coin] == null ? "—" : pct(changes[tile.coin])}</span></div>
      <strong className="v5m-price" title={current[tile.coin] ? String(tile.last) : undefined}>{current[tile.coin] ? `${price(tile.last)} ${REFERENCE.quote}` : "—"}</strong><small className={`v5m-asof${current[tile.coin] ? "" : " is-old"}`}>{current[tile.coin] ? "Close" : "— close not current"} · {minuteText(tile.lastTime + 60)} · {ageText(age(tile.coin, tile.lastTime))}</small>
      {changes[tile.coin] == null && <small className="v5m-asof">— {range} change: current boundary closes required.</small>}
      <SparkChart points={tile.spark} color={COIN_COLOR[tile.coin]} height={44} format={price} unit={REFERENCE.quote} ariaLabel={`${tile.coin} recorded prices, ${range}, breaks where minutes are missing`} />
      <HoldingLine holding={holdings[tile.coin]} error={paper.isError ? paper.error.message : null} now={now} />
      <dl className="v5m-kv"><dt>Perpetual premium</dt><dd title={!reads[tile.coin]?.perpetualError && tile.premiumBps != null && tile.premiumTime != null && age(tile.coin, tile.premiumTime) != null && age(tile.coin, tile.premiumTime)! <= STALE_AFTER_S ? `result ${tile.premiumBps} bp; ${tile.premiumInputs}` : undefined}>{reads[tile.coin]?.perpetualError ? "— perpetual read failed" : tile.premiumBps == null || tile.premiumTime == null ? "— no paired closes" : (() => { const seconds = age(tile.coin, tile.premiumTime); return seconds == null || seconds > STALE_AFTER_S ? "— paired close not current" : `${signed(tile.premiumBps, 1)} bp · ${minuteText(tile.premiumTime + 60)} · ${ageText(seconds)}`; })()}</dd></dl>
    </article> : <article key={MARKET_COINS[index]} className="v5m-card v5m-coin is-empty"><span className="v5m-sym">{MARKET_COINS[index]}</span><strong className="v5m-price">—</strong><p>{coins.isPending ? "Loading…" : reads[MARKET_COINS[index]]?.error ? `Candle read failed: ${reads[MARKET_COINS[index]].error}` : `No closed minute in ${range}.`}</p><HoldingLine holding={holdings[MARKET_COINS[index]]} error={paper.isError ? paper.error.message : null} now={now} /></article>)}</TileGrid>
    {selected ? <V5MarketDetail key={selected} coin={selected} color={COIN_COLOR[selected]} onClose={() => setSelected(null)} tileRead={range === "24h" && coins.isSuccess && reads[selected]?.spot ? reads[selected] as unknown as DetailRead : null} /> : <p className="v5m-hint v5m-tip">Click a coin for its candles, minutes held and venue-by-venue price gaps.</p>}

    <Section title="Hour-by-hour returns" note={`${range} · ${venueName(REFERENCE.venue)} spot · ${REFERENCE.quote} · UTC`}>
      <p className="v5m-hint">Each hour needs its preceding close and all 60 final minutes. Incomplete hours and gaps stay grey; no prices are carried forward.</p>
      <HourStrip reads={reads} />
    </Section>

    <Section title="Moves" note={`${venueName(REFERENCE.venue)} spot, 1-minute candles sampled every 5 minutes`}>
      <div className="v5m-row v5m-row--wide">
        <Card title={`Return over ${range}`} hint="Each coin starts at 0% at the window's first minute (a coin without that minute is left out) · lines break where minutes are missing · hover for values">
          <TimeSeriesChart series={returnSeries.filter(item => !hidden.has(item.id))} height={260} zeroLine includeZero signed ariaLabel={`Return of each coin over ${range}`} leftFormat={value => pct(value)} leftTickFormat={value => `${axis(value, 2, true)}%`} emptyText="No candles to plot yet." />
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
          <TimeSeriesChart series={premium.filter(item => !hidden.has(item.id))} height={240} zeroLine includeZero signed ariaLabel="Perpetual premium over spot by coin" leftFormat={value => `${signed(value, 1)} bp`} leftTickFormat={value => `${axis(value, 1, true)} bp`} emptyText="No minute where both spot and perpetual closed." />
          <Legend series={premium} hidden={hidden} onToggle={toggleSeries} />
        </Card>
        <Card title="Same coin, different venue" hint="Average gap of each venue's spot close from the median of venues over the last hour, basis points (owner-computed; hover for minutes compared)">
          {cross.isPending ? <p role="status" className="v5m-hint">Reading cross-venue prices…</p> : !cross.data || crossVenues.length === 0 ? <p className="v5m-hint">Cross-venue statistics unavailable{cross.data?.some(read => read.error) ? `: ${cross.data.find(read => read.error)!.error}` : ""}.</p> :
            <table className="v5m-heat"><thead><tr><th>Venue</th>{cross.data.map(read => <th key={read.coin} title={read.error ?? undefined}>{read.coin}{read.error ? " (read failed)" : ""}</th>)}</tr></thead><tbody>{crossVenues.map(venue => <tr key={venue}><td>{venueName(venue)}</td>{cross.data!.map(read => {
              const row = read.table?.find(item => item.venue === venue);
              if (!row || row.mean_bps == null || !row.n) return <td key={read.coin} className="is-none" title={read.error ? "read failed" : row ? "no minute compared" : "no row from the owner for this venue"}>—</td>;
              const bps = row.mean_bps, strength = Math.min(Math.abs(bps) / 12, 1) * 0.45;
              return <td key={read.coin} className={`is-clickable${selected === read.coin ? " is-selected" : ""}`} onClick={() => select(read.coin)} title={`${venueName(venue)} ${row.pair}: mean ${bps} bp over ${row.n} minutes · p95 |gap| ${row.p95_abs_bps == null ? "—" : row.p95_abs_bps} bp · click for ${read.coin} detail`} style={{ background: Math.abs(bps) < 0.5 ? undefined : `color-mix(in srgb, ${bps < 0 ? "var(--color-red)" : "var(--color-green)"} ${Math.round(strength * 100)}%, transparent)` }}>{signed(bps, 1)}</td>;
            })}</tr>)}</tbody></table>}
          <p className="v5m-hint">Green: above the median of venues, red: below. Quotes can differ (USDT, USD, USDC), so part of a gap can be the quote currency, not the venue.</p>
        </Card>
      </div>
    </Section>

    <p className="v5m-hint">Venue and data health and V5 engine inputs are in <Link to="/system/data-feeds">System</Link>.</p>

    <details className="v5m-details" onToggle={event => setDetailsOpen(event.currentTarget.open)}><summary>Candle store details: every lane and instrument, candle chart, coverage heatmap, store facts</summary>{detailsOpen && <V5CandleStore />}</details>
  </div>;
}

function HoldingLine({ holding, error, now }: { holding: ReturnType<typeof marketHolding>; error: string | null; now: number }) {
  return <><p className="v5m-holding" title={holding.exact}>{holding.text}</p><small className="v5m-asof">{error ?? holding.reason}{holding.asOf != null && <> · Paper {utcMin(holding.asOf)} · {ageText((now - holding.asOf) / 1000)}</>}</small></>;
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

export function exactSystemCount(values: (number | null | undefined)[]) {
  return values.length && values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ? values.reduce<bigint>((total, value) => total + BigInt(value!), 0n).toString() : null;
}

export function systemTime(value: number | null | undefined, now: number) {
  const stamp = utcMinute(value);
  return stamp == null ? '— · time not reported' : value! > now ? `${stamp} · owner clock ahead` : `${stamp} · ${ageText((now - value!) / 1000)}`;
}

export function systemStoreCurrent(summary: Summary | undefined, receivedAt: number, now: number) {
  if (!summary || !Number.isFinite(summary.now) || summary.now * 1000 > now || now - summary.now * 1000 > 90_000 || !Number.isFinite(summary.status_age_s) || summary.status_age_s! < 0 || receivedAt > now || receivedAt <= 0) return false;
  return summary.status_age_s! * 1000 + now - receivedAt <= 60_000;
}

function systemCoverage(lanes: LaneTile[]) {
  if (!lanes.length) return null;
  const scale = 10n ** 30n;
  const values = lanes.map(lane => {
    if (lane.available !== true || typeof lane.coverage_7d !== 'number' || !Number.isFinite(lane.coverage_7d) || lane.coverage_7d < 0 || lane.coverage_7d > 1) return null;
    const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(lane.coverage_7d));
    if (!match) return null;
    const digits = match[1] + (match[2] ?? ''), shift = 30 + Number(match[3] ?? 0) - (match[2]?.length ?? 0);
    return shift < 0 || shift > 30 ? null : BigInt(digits) * 10n ** BigInt(shift);
  });
  if (values.some(value => value === null)) return null;
  const total = values.reduce<bigint>((sum, value) => sum + value!, 0n);
  const divisor = scale * BigInt(values.length);
  const result = rationalPercent(total * 100n, divisor, 1);
  return result ? { text: `${fixed(result.value, 1)}%`, exact: `exact mean of ${lanes.map(lane => lane.coverage_7d).join(', ')} = ${result.exact}` } : null;
}

export function V5SystemMarket({ tab, paused }: { tab: 'data-feeds' | 'engine-inputs'; paused: boolean }) {
  const profile = useQuery({ queryKey: ['v5-profile'], queryFn: v5Api.profile, retry: false });
  const configured = profile.data?.candle_store?.configured === true;
  const summary = useQuery({ queryKey: ['v5-system', 'market-summary'], queryFn: () => readCandleStore<Summary>('summary'), enabled: configured && tab === 'data-feeds', retry: false, refetchInterval: paused ? false : 15_000 });
  const workspace = useQuery({ queryKey: ['v5-system', 'market-workspace'], queryFn: v5Api.workspace, retry: false, refetchInterval: paused ? false : 15_000 });
  const now = usePaperClock();
  const invalidLanes = summary.isSuccess && (!summary.data || !Array.isArray(summary.data.tiles) || !summary.data.tiles.every(lane => lane && typeof lane === 'object' && typeof lane.lane === 'string' && typeof lane.venue === 'string' && typeof lane.segment === 'string'));
  const storeCurrent = !invalidLanes && summary.isSuccess && systemStoreCurrent(summary.data, summary.dataUpdatedAt, now);
  const lanes = storeCurrent && summary.data ? summary.data.tiles : [];
  const lanesUnknown = lanes.filter(lane => typeof lane.available !== 'boolean').length;
  const allLanesAvailable = lanes.length > 0 && lanes.every(lane => lane.available === true);
  const oldestAge = allLanesAvailable && lanes.every(lane => typeof lane.last_minute_age_s === 'number' && Number.isFinite(lane.last_minute_age_s)) ? Math.max(...lanes.map(lane => lane.last_minute_age_s!)) : null;
  const slowestAge = oldestAge == null ? null : oldestAge + Math.max(0, now - summary.dataUpdatedAt) / 1000;
  const gaps = allLanesAvailable ? exactSystemCount(lanes.map(lane => lane.gaps_7d)) : null;
  const coverage = systemCoverage(lanes);
  const refresh = workspace.data?.source_refresh;
  const cutoff = workspace.data?.context?.cutoff_ms;
  const feedCurrent = workspace.isSuccess && refresh?.feed_freshness === 'FRESH' && refresh.feed_fresh_until_ms != null && now <= refresh.feed_fresh_until_ms && typeof cutoff === 'number' && Number.isFinite(cutoff) && cutoff <= now;
  const evidence = feedCurrent ? workspace.data?.context ?? null : null;
  const cohort = evidence ? selectedCohortCoverage(evidence) : null;
  if (tab === 'engine-inputs') return <div className="v5m">{invalidLanes && <p role="alert">— · Candle store lane data is invalid: expected an array of lane records.</p>}<Section title="V5 market features" note={`Packet cut: ${systemTime(evidence?.cutoff_ms, now)}`}><div className="v5m-card">{workspace.isPending ? 'Reading the V5 feed…' : workspace.isError ? `Workspace read failed: ${workspace.error.message}` : !evidence ? '— · V5 feed data is not current or was not reported.' : <V5MarketFeatures features={evidence.features} />}</div></Section></div>;
  return <div className="v5m"><Section title="Venues and data health" note="Candle store and the V5 market-context feed"><div className="v5m-row">
    <Card title="Venue coverage" hint="Pairs held of listed · 24-hour candle coverage · age of newest minute">{!configured ? <p>— · Candle store is not configured.</p> : !storeCurrent ? <p>— · {invalidLanes ? 'Candle store lane data is invalid: expected an array of lane records.' : summary.isError ? `Candle store read failed: ${summary.error.message}` : 'Candle store data is not current or has not arrived.'}</p> : <div className="v5m-venues"><span>Venue</span><span>Spot</span><span>Perpetual</span>{venueGrid(lanes).map(row => <Venue key={row.venue} row={row} elapsedSeconds={Math.max(0, now - summary.dataUpdatedAt) / 1000} />)}</div>}</Card>
    <Card title="Candle store health" hint="One store feeds V5, Helm and research"><div className="v5m-stats">
      <Stat label="Lanes available" value={!storeCurrent || !lanes.length || lanesUnknown ? '—' : `${lanes.filter(lane => lane.available === true).length}/${lanes.length}`} note={!storeCurrent ? 'Store data not current' : !lanes.length ? 'No lanes reported' : lanesUnknown ? `${lanesUnknown} lanes unreported` : 'reported lanes'} />
      <Stat label="7-day coverage" value={coverage?.text ?? '—'} title={coverage?.exact} note={coverage === null ? 'A lane is unavailable or 7-day coverage is missing or invalid' : 'mean of all reported lanes'} />
      <Stat label="Missing minutes, 7 days" value={gaps ?? '—'} note={gaps == null ? 'A lane is unavailable or gaps were not reported' : 'all reported lanes'} />
      <Stat label="Slowest lane" value={slowestAge == null ? '—' : `${Math.round(slowestAge)} s`} note={slowestAge == null ? 'Age not reported or not current' : 'since its newest final minute closed'} />
    </div><h3 className="v5m-subhead">V5 market-context feed</h3><p className="v5m-hint">Last success: {systemTime(refresh?.last_success_at_ms, now)}</p>{!cohort ? <p>— · Feed data is not current or was not reported.</p> : <div className="v5m-stats">{cohort.dimensions.map(item => { const shown = cohortCoverageDisplay(item, 0); return <Stat key={item.key} label={item.label} value={item.valid == null || item.expected == null ? '—' : `${item.valid}/${item.expected}`} title={shown?.exact} note={shown ? `${shown.text} this minute` : 'not qualified'} />; })}</div>}</Card>
  </div></Section></div>;
}

function Legend({ series, hidden, onToggle }: { series: ChartSeries[]; hidden: ReadonlySet<string>; onToggle: (id: string) => void }) {
  return <div className="v5m-legend" role="group" aria-label="Show or hide coins">{series.map(item => { const last = [...item.points].reverse().find(point => point.value != null); const off = hidden.has(item.id); return <button type="button" key={item.id} aria-pressed={!off} className={off ? "is-off" : ""} onClick={() => onToggle(item.id)} title={off ? `Show ${item.label}` : `Hide ${item.label}`}><i style={{ background: item.color }} />{item.label} <b>{last?.value == null ? "—" : item.format!(last.value)}</b></button>; })}</div>;
}

function ReturnBars({ tiles, range, selected, onSelect }: { tiles: { coin: string; changePct: string }[]; range: string; selected: string | null; onSelect: (coin: string) => void }) {
  const sorted = [...tiles].sort((left, right) => Number(right.changePct) - Number(left.changePct));
  const max = Math.max(...sorted.map(tile => Math.abs(Number(tile.changePct))), 0.01);
  return <div className="v5m-bars">{sorted.map(tile => <button type="button" key={tile.coin} className={`v5m-bar${selected === tile.coin ? " is-selected" : ""}`} aria-pressed={selected === tile.coin} onClick={() => onSelect(tile.coin)} title={`${tile.coin}: ${pct(tile.changePct)} over ${range} · click for detail`}><span>{tile.coin}</span><div><i style={{ width: `${(Math.abs(Number(tile.changePct)) / max) * 50}%`, background: "var(--color-primary)", [Number(tile.changePct) < 0 ? "right" : "left"]: "50%" }} /></div><b>{pct(tile.changePct)}</b></button>)}</div>;
}

function Venue({ row, elapsedSeconds }: { row: ReturnType<typeof venueGrid<LaneTile>>[number]; elapsedSeconds: number }) {
  const cell = (lane: LaneTile | null) => lane ? <span className="v5m-lane" title={`${lane.lane} · 7-day coverage ${lane.available === true && typeof lane.coverage_7d === 'number' && Number.isFinite(lane.coverage_7d) && lane.coverage_7d >= 0 && lane.coverage_7d <= 1 ? `${fixed(decimalShift(lane.coverage_7d, 2), 1)}%` : 'not reported or unavailable'} · missing minutes ${lane.available === true && Number.isSafeInteger(lane.gaps_7d) && lane.gaps_7d! >= 0 ? lane.gaps_7d : 'not reported or unavailable'}${lane.available === true && lane.coverage_7d != null ? ` · exact 7-day fraction ${lane.coverage_7d}` : ''}${lane.unavailable_reason ? ` · ${lane.unavailable_reason}` : ""}`}>
    <span className={laneHealthClass(lane.health)} title={`Owner health: ${lane.health ?? "not reported"} · ${tri(lane.available, "available", "unavailable", "availability not reported")}`}>{lane.available === true && Number.isSafeInteger(lane.pairs_held) && Number.isSafeInteger(lane.pairs_listed) && lane.pairs_held! >= 0 && lane.pairs_listed! >= 0 ? `${lane.pairs_held}/${lane.pairs_listed}` : `— · ${lane.available === false ? 'lane unavailable' : lane.available === true ? 'pair counts not reported' : 'availability not reported'}`}</span>
    <span title={lane.available === true && lane.coverage_24h != null && Number.isFinite(lane.coverage_24h) ? String(lane.coverage_24h) : undefined}>{lane.available !== true || lane.coverage_24h == null || !Number.isFinite(lane.coverage_24h) ? '— · coverage not current' : `${fixed(decimalShift(lane.coverage_24h, 2), 0)}%`}</span>
    <span className="v5m-muted">{lane.available !== true || lane.last_minute_age_s == null || !Number.isFinite(lane.last_minute_age_s) || lane.last_minute_age_s < 0 ? '— · age not current' : `${Math.round(lane.last_minute_age_s + elapsedSeconds)} s`}</span>
  </span> : <span className="v5m-lane is-none">— · lane not reported</span>;
  return <><span className="v5m-venue">{venueName(row.venue)}</span>{cell(row.spot)}{cell(row.perpetual)}</>;
}

function Stat({ label, value, note, warn, title }: { label: string; value: string; note?: string; warn?: boolean; title?: string }) {
  return <div className={`v5m-stat${warn ? " is-warn" : ""}`} title={title}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}
