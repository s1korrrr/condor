import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";
import { projectFrame, validateFrame } from "../src/features/market-picture/contract.mjs";
import {
  SMOOTHING_MINUTES,
  VERDICT_HOLD,
  VERDICT_THRESHOLD,
  assetState,
  breadthLadder,
  bucketMinutes,
  derivedRegime,
  hasCorrelationValues,
  correlationReadout,
  impliedMove,
  isHourlyRelativeVolume,
  isShortBreadthCrossing,
  isSingleBarRelativeVolume,
  nullReasonLabel,
  marketVerdict,
  nextVerdictState,
  pulseSeries,
  rollingMean,
  regimeSummary,
  returnHeat,
  showDistribution,
} from "../src/features/market-picture/pulse.mjs";

import * as model from "../src/features/market-picture/model.mjs";
import * as pulseModule from "../src/features/market-picture/pulse.mjs";
import * as contract from "../src/features/market-picture/contract.mjs";
import * as stored from "../src/features/market-picture/stored.mjs";

// The loader transpiles TS; the pure .mjs modules are provided as the real ES modules.
const { load } = frontendModules({
  "./model.mjs": model,
  "./pulse.mjs": pulseModule,
  "./contract.mjs": contract,
  "./stored.mjs": stored,
  "@/lib/api": { api: {} },
}, { "features/market-picture/MarketPulse.tsx": ["PulseDataTable", "VerdictCard"] });
const read = (file) =>
  JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/${file}`, import.meta.url), "utf8"));
const metric = (value, extra = {}) => ({ value, original: String(value), unit: "x", status: value == null ? "UNAVAILABLE" : "VALID", reasons: [], valid: 5, expected: 5, available: 1, expires: 2, definition: "d v1", ...extra });
const HORIZONS = ["1", "5", "15", "60", "240", "1440"];

test("future microstructure never qualifies before both the frame and row are available", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const source = await fixtureFrame("market-picture.m1-components.fixture.json");
  const decision = source.available_at_ms;
  for (const pending of ["frame", "row", "both"]) {
    const frame = structuredClone(source);
    const flow = frame.microstructure.flows.find(row => row.confirmationImbalance != null && row.complete && !row.reasons.length);
    const book = frame.microstructure.liquidity.find(row => row.vwap != null && Number(row.uncovered) === 0);
    assert.ok(flow && book);
    frame.microstructure.flows = [flow];
    frame.microstructure.liquidity = [book];
    Object.assign(book, { reasons: [], totalCostBps: "25", costPercentile7d: 0.75, costPercentileReasons: [] });
    frame.available_at_ms = pending === "row" ? decision - 2 : decision;
    flow.available = book.available = pending === "frame" ? decision - 2 : decision;
    const render = (Component, asOf) => renderToStaticMarkup(React.createElement(Component, { frame, horizon: "15", asOf }));
    const future = render(pulse.MicrostructurePanel, decision - 1);
    const families = render(pulse.EvidenceMatrixPanel, decision - 1);
    const tables = [...future.matchAll(/<tbody>(.*?)<\/tbody>/gs)].map(match => match[1]);
    const cells = html => [...html.matchAll(/<td(?:\s[^>]*)?>(.*?)<\/td>/gs)].map(match => match[1]);
    assert.deepEqual(cells(tables[0]).slice(0, 7), Array(7).fill("Unavailable · FUTURE"), `${pending}: no future flow values`);
    assert.deepEqual(cells(tables[1]).slice(0, 8), Array(8).fill("Unavailable · FUTURE"), `${pending}: no future book values`);
    assert.match(future, /FUTURE/);
    assert.doesNotMatch(families, /OBSERVED · QUALIFIED/);
    assert.match(families, /data-state="OBSERVED · FUTURE"/);
    assert.match(families, /0 complete, reason-free, available and unexpired/);
    const available = render(pulse.MicrostructurePanel, decision);
    assert.doesNotMatch(available, /FUTURE/);
    assert.match(available, /75 percentile/);
    assert.match(available, /25 bps/);
    assert.match(available, /\+0\.2/);
    assert.match(available, /USDC 21\.614/);
    assert.match(render(pulse.EvidenceMatrixPanel, decision), /OBSERVED · QUALIFIED/);
  }
});

test("frozen assessment never advances the clock to a future frame", () => {
  const frame = { available_at_ms: 1000 };
  assert.equal(model.observationAsOf(frame, 999, false), 999);
  assert.equal(model.observationAsOf(frame, 999, true), 999);
  assert.equal(model.observationAsOf(frame, 1000, true), 1000);
  assert.equal(model.observationAsOf(frame, 2000, true), 1000);
  assert.equal(model.observationAsOf(frame, 2000, false), 2000);
  assert.equal(model.observationAsOf(null, 2000, true), 2000);
});

test("microstructure qualification ends exactly at the earlier frame or row expiry", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const source = await fixtureFrame("market-picture.m1-components.fixture.json");
  const expiry = source.available_at_ms + 5_000;
  for (const firstExpiry of ["frame", "row"]) {
    const frame = structuredClone(source);
    const flow = frame.microstructure.flows.find(row => row.confirmationImbalance != null && row.complete && !row.reasons.length);
    const book = frame.microstructure.liquidity.find(row => row.vwap != null && Number(row.uncovered) === 0);
    frame.microstructure.flows = [flow];
    frame.microstructure.liquidity = [book];
    frame.expires_at_ms = firstExpiry === "frame" ? expiry : expiry + 1;
    flow.expires = book.expires = firstExpiry === "row" ? expiry : expiry + 1;
    Object.assign(book, { reasons: [], totalCostBps: "25", costPercentile7d: 0.75, costPercentileReasons: [] });
    const render = (Component, asOf) => renderToStaticMarkup(React.createElement(Component, { frame, horizon: "15", asOf }));
    assert.match(render(pulse.EvidenceMatrixPanel, expiry - 1), /OBSERVED · QUALIFIED/);
    assert.match(render(pulse.MicrostructurePanel, expiry - 1), /75 percentile/);
    const expired = render(pulse.MicrostructurePanel, expiry);
    assert.match(expired, /Unavailable · EXPIRED/);
    assert.doesNotMatch(expired, /75 percentile|25 bps/);
    assert.doesNotMatch(render(pulse.EvidenceMatrixPanel, expiry), /OBSERVED · QUALIFIED/);
    assert.match(render(pulse.EvidenceMatrixPanel, expiry), /OBSERVED · EXPIRED/);
  }
});

function frameWith({ pressure = {}, mean = {}, vol = 0.5, advancing = 3 } = {}) {
  return {
    expected: 5,
    pressure: Object.fromEntries(HORIZONS.map((h) => [h, metric(pressure[h] ?? 0)])),
    distribution: Object.fromEntries(HORIZONS.map((h) => [h, { mean: metric(mean[h] ?? 0), total: 5 }])),
    summary: { realized_volatility_24h: metric(vol) },
    breadth: Object.fromEntries(HORIZONS.map((h) => [h, { advancing, declining: 5 - advancing, unchanged: 0, valid: 5, expected: 5, positive: metric(advancing / 5), negative: metric((5 - advancing) / 5), flat: metric(0) }])),
  };
}

function completeVerdictHistory(cutoff, pressure = 0) {
  return Array.from({ length: 360 }, (_, i) => ({
    time: cutoff - (360 - i) * 60_000,
    gapBefore: false,
    breadth: Object.fromEntries(HORIZONS.map((h) => [h, { pressure }])),
  }));
}

test("positive verdicts require current data and historical inspection stays explicit", () => {
  const { VerdictCard } = load("features/market-picture/MarketPulse.tsx");
  const frame = {
    ...frameWith({ pressure: Object.fromEntries(HORIZONS.map(h => [h, 3])), mean: { 15: 5 } }),
    cutoff_ms: 100_000, available_at_ms: 101_000, expires_at_ms: 220_000,
  };
  const stateHistory = completeVerdictHistory(frame.cutoff_ms, 3);
  const render = (asOf, historical = false) => renderToStaticMarkup(React.createElement(VerdictCard, {
    frame, horizon: "15", history: stateHistory, smooth: false, asOf, historical,
  }));
  for (const [now, state] of [[100_999, "FUTURE"], [190_001, "LAGGING"], [220_000, "STALE"]]) {
    const html = render(now);
    assert.match(html, new RegExp(`Unavailable · ${state}`));
    assert.doesNotMatch(html, /data-state="risk-on"|mp-score__fill|Market state: Risk-on/);
  }
  assert.match(render(101_000), /data-state="risk-on"/);
  const historical = render(101_000, true);
  assert.match(historical, /Recorded market state: Risk-on/);
  assert.match(historical, /data-state="historical"/);
  assert.doesNotMatch(historical, /data-state="risk-on"/);
  assert.match(render(100_999, true), /Unavailable · FUTURE/);
});

test("stale or lagging breadth cannot produce positive conditional readings", () => {
  const { EvidenceMatrixPanel } = load("features/market-picture/MarketPulse.tsx");
  const frame = {
    ...frameWith({ pressure: Object.fromEntries(HORIZONS.map(h => [h, 3])), advancing: 5 }),
    cutoff_ms: 100_000, available_at_ms: 101_000, expires_at_ms: 220_000,
    sourceCapabilities: [],
  };
  for (const [asOf, state] of [[190_001, "LAGGING"], [220_000, "STALE"]]) {
    const html = renderToStaticMarkup(React.createElement(EvidenceMatrixPanel, { frame, horizon: "15", asOf }));
    assert.match(html, new RegExp(`data-state="${state}"`));
    assert.match(html, /Deterministic reading unavailable/);
    assert.match(html, /Continuation conditions are unavailable/);
  }
});

test("verdict averages the three disclosed components and applies the published thresholds", () => {
  const strong = marketVerdict(frameWith({ pressure: Object.fromEntries(HORIZONS.map((h) => [h, 3])), mean: { 15: 5 } }), "15");
  assert.equal(strong.state, "risk-on");
  assert.deepEqual(strong.components.map((c) => c.id), ["breadth", "persistence", "return"]);
  assert.equal(strong.score, 1, "all components saturate at +1");
  const weak = marketVerdict(frameWith({ pressure: Object.fromEntries(HORIZONS.map((h) => [h, -3])), mean: { 15: -5 } }), "15");
  assert.equal(weak.state, "risk-off");
  assert.equal(weak.score, -1);
  const flat = marketVerdict(frameWith(), "15");
  assert.equal(flat.state, "mixed");
  assert.equal(flat.score, 0);
  // Breadth +2.25 (0.75), persistence mean(2.25,0,0,0)/3 (0.1875), return 0 -> (0.75 + 0.1875) / 3.
  const above = marketVerdict(frameWith({ pressure: { 15: 2.25 } }), "15");
  assert.ok(Math.abs(above.score - 0.3125) < 1e-9);
  assert.equal(above.state, "risk-on");
  const below = marketVerdict(frameWith({ pressure: { 15: 1.5 } }), "15");
  assert.ok(Math.abs(below.score - 0.20833333) < 1e-6);
  assert.equal(below.state, "mixed", "just under +0.25 stays Mixed");
  assert.equal(VERDICT_THRESHOLD, 0.25);
  assert.match(strong.rule, /Risk-on/);
  assert.match(strong.rule, /not a trade signal/);
});

test("verdict normalises mean return by the volatility-implied move and survives missing inputs", () => {
  const move = impliedMove(0.5, 15);
  assert.ok(Math.abs(move - 0.5 * Math.sqrt(15 / 525600) * 100) < 1e-12);
  const frame = frameWith({ mean: { 15: move } });
  const verdict = marketVerdict(frame, "15");
  const part = verdict.components.find((c) => c.id === "return");
  assert.ok(Math.abs(part.score - 0.5) < 1e-9, "one sigma is half the clamped ±2σ range");
  frame.summary.realized_volatility_24h = metric(null);
  assert.deepEqual(marketVerdict(frame, "15").components.map((c) => c.id), ["breadth", "persistence"]);
  const empty = frameWith();
  empty.pressure = Object.fromEntries(HORIZONS.map((h) => [h, metric(null)]));
  empty.distribution = {};
  assert.equal(marketVerdict(empty, "15"), null, "no verdict is drawn instead of a placeholder");
  assert.equal(marketVerdict(null, "15"), null);
});

test("breadth ladder keeps one row per horizon with a valid share", () => {
  const rows = breadthLadder(frameWith({ pressure: { 60: 1.8 } }));
  assert.equal(rows.length, 6);
  assert.equal(rows.find((r) => r.horizon === "60").pressure, 1.8);
  const partial = frameWith();
  partial.breadth["240"].positive = metric(null);
  assert.equal(breadthLadder(partial).length, 5);
});

const asset = (predicates, indicators, regimes = []) => ({
  instrument_id: "okx:spot:BTC-USDC",
  symbol: "BTC",
  price: metric(105),
  returns: { 1440: metric(1.2) },
  indicators: Object.fromEntries(Object.entries(indicators).map(([k, v]) => [k, metric(v)])),
  predicates: Object.fromEntries(Object.entries(predicates).map(([k, v]) => [k, metric(v)])),
  regimes,
});

test("regimes are derived from observed ADX/ATR/EMA predicates and say so; stored models win", () => {
  const up = derivedRegime(asset({ trending: 1, compression: 0, high_volatility: 0, elevated_rvol: 0 }, { ema21: 100, adx14: 31, rsi14: 62 }));
  assert.equal(up.label, "Uptrend", "same vocabulary as the instrument trend pill");
  assert.equal(up.basis, "derived");
  assert.match(up.detail, /derived from observed ADX14/);
  const down = derivedRegime(asset({ trending: 1, compression: 1, high_volatility: 0, elevated_rvol: 0 }, { ema21: 110, adx14: 31 }));
  assert.equal(down.label, "Downtrend");
  assert.deepEqual(down.tags, ["Compression"]);
  assert.equal(derivedRegime(asset({ trending: 0, compression: 1, high_volatility: 0 }, { ema21: 100 })).label, "Compression");
  assert.equal(derivedRegime(asset({ trending: 0, compression: 0, high_volatility: 1 }, { ema21: 100 })).label, "Volatile range");
  assert.equal(derivedRegime(asset({ trending: 0, compression: 0, high_volatility: 0 }, { ema21: 100 })).label, "Range");
  assert.equal(derivedRegime(asset({}, {})), null, "no inputs, no label");
  const stored = derivedRegime(asset({ trending: 1 }, { ema21: 100 }, [{ label: "Bull", origin: "owner", model: "hmm-1" }]));
  assert.deepEqual([stored.label, stored.basis], ["Bull", "stored"]);
});

test("asset state reads trend and RSI zone from observed values", () => {
  const state = assetState(asset({ trending: 1 }, { ema21: 100, adx14: 28, rsi14: 71 }));
  assert.equal(state.trend, "Uptrend");
  assert.equal(state.rsiZone, "Overbought");
  assert.ok(Math.abs(state.emaDistance - 5) < 1e-9);
  assert.equal(assetState(asset({ trending: 0 }, { ema21: 100, rsi14: 25 })).rsiZone, "Oversold");
  assert.equal(assetState(asset({}, {})).trend, null);
});

test("return heat intensity is the move in units of twice the volatility-implied move", () => {
  const a = asset({}, { realized_volatility_24h: 0.5 });
  a.returns = { 15: metric(2 * impliedMove(0.5, 15)) };
  assert.equal(returnHeat(a, "15").intensity, 1);
  a.returns = { 15: metric(null) };
  assert.deepEqual(returnHeat(a, "15"), { value: null, intensity: 0 });
});

test("regime summary lists only predicate shares that have values", () => {
  const frame = { participation: { trending: metric(0.2, { valid: 5 }), compression: metric(1, { valid: 5 }), high_volatility: metric(null) } };
  assert.deepEqual(regimeSummary(frame).map((r) => [r.key, r.count]), [["trending", 1], ["compression", 5]]);
});

const point = (minute, extra = {}) => ({
  time: Date.parse("2026-10-01T00:00:00Z") + minute * 60_000, snapshot_id: null, source_kind: "observed", valid: 5, expected: 5, membership: "m",
  gapBefore: false, summary: {}, breadth: { 15: { positive: minute % 2 ? 1 : 0, negative: minute % 2 ? 0 : 1, flat: 0, pressure: minute % 2 ? 3 : -3 } }, ...extra,
});

test("pulse series averages fixed buckets, discloses them, and never bridges a coverage gap", () => {
  assert.equal(bucketMinutes(6 * 3600_000), 2);
  assert.equal(bucketMinutes(24 * 3600_000), 10);
  const history = Array.from({ length: 40 }, (_, i) => point(i));
  const result = pulseSeries(history, "6h", "15");
  assert.equal(result.bucketMinutes, 1, "a short span keeps one-minute resolution");
  assert.equal(result.pressure.length, 40);
  const long = Array.from({ length: 1440 }, (_, i) => point(i));
  const day = pulseSeries(long, "24h", "15");
  assert.equal(day.bucketMinutes, 10);
  assert.match(day.label, /10-minute means/);
  assert.ok(day.pressure.length <= 145);
  assert.ok(Math.abs(day.pressure[1].value) <= 3);
  const gap = long.map((p, i) => (i === 720 ? { ...p, gapBefore: true } : p));
  const withGap = pulseSeries(gap, "24h", "15");
  assert.ok(withGap.pressure.some((p) => p.value === null), "the break is an explicit gap");
  const times = withGap.pressure.map((p) => p.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "series stays time ordered");
  assert.equal(new Set(times).size, times.length);
});

test("correlation and distribution panels appear only when they carry information", () => {
  assert.equal(hasCorrelationValues([{ instrument_id: "a", benchmark_id: "b", value: null }]), false);
  assert.equal(hasCorrelationValues([{ instrument_id: "a", benchmark_id: "a", value: 1 }]), false, "self pairs do not count");
  assert.equal(hasCorrelationValues([{ instrument_id: "a", benchmark_id: "b", value: 0.4 }]), true);
  assert.equal(showDistribution({ distribution: { 1440: { total: 5 } } }), false);
  assert.equal(showDistribution({ distribution: { 1440: { total: 240 } } }), true);
});

async function fixtureFrame(name) {
  return projectFrame(await validateFrame(read(name), { allowFixture: true }));
}

test("home sections render current frames with explicit evidence-gated states", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const assets = load("features/market-picture/AssetPanels.tsx");
  const overview = load("features/market-picture/OverviewPanels.tsx");
  for (const name of ["market-picture.240.fixture.json", "market-picture.v1.json"]) {
    const frame = await fixtureFrame(name);
    const history = Array.from({ length: 60 }, (_, i) => point(i, { summary: { market_participation: 0.4, trend_strength: 20 } }));
    const noop = () => {};
    const common = { frame, selected: null, select: noop, cohort: new Set(), search: "" };
    const markup = [
      React.createElement(pulse.MarketPulseHero, { frame, history, horizon: "15", window: "24h", setHorizon: noop, setWindow: noop, replay: noop }),
      React.createElement(pulse.MarketSnapshotTiles, { frame, history, window: "24h" }),
      React.createElement(pulse.EvidenceMatrixPanel, { frame, horizon: "15" }),
      React.createElement(assets.InstrumentsPanel, common),
      React.createElement(assets.RegimePanel, common),
      React.createElement(assets.LeadersLaggardsPanel, { ...common, benchmark: "BTC" }),
      React.createElement(overview.ParticipationPanel, { frame, selectPredicate: noop }),
    ].map((element) => renderToStaticMarkup(element)).join("\n");
    // A missing relative-strength reference is named once, in the availability line.
    const availability = renderToStaticMarkup(React.createElement(pulse.AvailabilityLine, { frame, asOf: frame.available_at_ms, horizon: "15" }));
    assert.match(availability, /Relative-strength change vs BTC/);
    assert.match(availability, /no qualified prior relative-strength reference/);
    assert.match(markup, /Market Pulse/);
  }
});

test("evidence matrix keeps correlated price inputs together and unqualified families explicit", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.240.fixture.json");
  const markup = renderToStaticMarkup(React.createElement(pulse.EvidenceMatrixPanel, { frame, horizon: "15" }));
  assert.match(markup, /Price &amp; participation/);
  assert.match(markup, /count as one correlated family/);
  assert.match(markup, /Displayed liquidity/);
  assert.match(markup, /Derivatives positioning/);
  assert.match(markup, /Options/);
  assert.match(markup, /External context/);
  assert.match(markup, /Private exposure/);
  assert.match(markup, /Conditional outcomes/);
  assert.match(markup, /NOT PROBED/);
  assert.match(markup, /Conditional outcomes/);
  assert.match(markup, /Deferred pending separately approved research/);
  assert.match(markup, /not a future cross/);
});

test("breadth scenarios describe the current pressure sign without stating a past cross as future", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.240.fixture.json");
  const renderAt = (value) => {
    frame.pressure["15"] = { ...frame.pressure["15"], value, original: String(value) };
    frame.breadth["15"].positive = { ...frame.breadth["15"].positive, value: value < 0 ? 0.4 : value > 0 ? 0.6 : 0.5 };
    return renderToStaticMarkup(React.createElement(pulse.EvidenceMatrixPanel, { frame, horizon: "15" }));
  };

  const negative = renderAt(-0.6);
  assert.match(negative, /Pressure is currently below zero/);
  assert.match(negative, /Continued weakness would require it to remain below zero/);
  assert.match(negative, /already below zero; that is the current deterioration sign/);
  assert.doesNotMatch(negative, /cross below zero in 15m breadth pressure would describe deterioration/i);

  const zero = renderAt(0);
  assert.match(zero, /Pressure is currently at zero/);
  assert.match(zero, /Continuation is not established/);
  assert.match(zero, /A cross below zero in 15m breadth pressure would describe deterioration/);

  const positive = renderAt(0.6);
  assert.match(positive, /Pressure is currently above zero/);
  assert.match(positive, /pressure staying above zero/);
  assert.match(positive, /A cross below zero in 15m breadth pressure would describe deterioration/);
});

test("source capability state never overrides operational degradation or creates missing metrics", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.240.fixture.json");
  frame.sourceCapabilities = [{
    sourceId: "example_flow", family: "spot_flow", qualification: "qualified",
    operational: "degraded", reasons: ["SOURCE_TIMEOUT"],
  }];
  const markup = renderToStaticMarkup(React.createElement(pulse.EvidenceMatrixPanel, { frame, horizon: "15" }));
  assert.match(markup, /QUALIFIED · DEGRADED/);
  assert.match(markup, /source status alone does not qualify a frame metric/i);
  assert.match(markup, /SOURCE_TIMEOUT/);
  assert.match(markup, /No visible-book component is attached/i);
  assert.doesNotMatch(markup, /Executed spot flow<\/strong><span data-state="QUALIFIED · HEALTHY"/);
});

test("microstructure panel keeps incomplete rows unavailable and never fills a full-size book cost", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.240.fixture.json");
  const absent = renderToStaticMarkup(React.createElement(pulse.MicrostructurePanel, { frame }));
  assert.equal(absent, "", "without an owner component the panel draws nothing");
  const availability = renderToStaticMarkup(React.createElement(pulse.AvailabilityLine, { frame, asOf: frame.available_at_ms, horizon: "15" }));
  assert.match(availability, /Executed spot flow/);
  assert.match(availability, /Status-only pointer/, "the status-only flow pointer is disclosed, not treated as an observation");
  const asOf = frame.available_at_ms;
  frame.microstructure = {
    componentId: "b".repeat(64), sourceKind: "reconstructed", cutoff: asOf, available: asOf,
    replayClass: "snapshot_only", rawInputsRetained: false,
    flows: [{ instrumentId: "okx:spot:BTC-USDC", sourceId: "fixture-flow", quoteAsset: "USDC", channel: "trades",
      windowStart: asOf - 60_000, windowEnd: asOf, available: asOf, expires: asOf + 1000,
      inputDigest: "a".repeat(64), resetId: "test-reset", resetAt: asOf - 300_000,
      coverageStart: asOf - 60_000, coverageEnd: asOf, gaps: [[asOf - 30_000, asOf - 20_000]],
      buyQuote: "100", sellQuote: "60", unknownQuote: "40", knownImbalance: "0.25", confirmationImbalance: null,
      unknownShare: "0.2", cumulativeBefore: null, cumulativeAfter: null, trades: 10, duplicates: 1,
      complete: false, reasons: ["UNKNOWN_AGGRESSOR"], capabilityUsable: true }],
    liquidity: [{ instrumentId: "okx:spot:BTC-USDC", sourceId: "fixture-book", channel: "books", sequence: 7,
      observed: asOf, available: asOf, expires: asOf + 1000, access: "non_rpi", side: "buy",
      requestedSize: "1000", sizeUnit: "quote", coveredBase: "0.005", coveredQuote: "300", uncovered: "700",
      coveredVwap: "60000", vwap: null, costBps: null, feeBps: null, feeSource: null, totalCostBps: null,
      spreadBps: "4", bandBps: "10", bidCovered: "500", askCovered: "600", bandComplete: false,
      bandImbalance: null, reasons: ["INSUFFICIENT_DEPTH"], capabilityUsable: true }],
  };
  const rendered = renderToStaticMarkup(React.createElement(pulse.MicrostructurePanel, { frame }));
  assert.match(rendered, /UNKNOWN_AGGRESSOR/);
  assert.match(rendered, /reset test-reset · 1 gap/);
  assert.ok(rendered.includes(`gaps ${asOf - 30_000}–${asOf - 20_000}`));
  assert.match(rendered, /Confirmation/);
  assert.match(rendered, /300 quote · 700 uncovered/);
  assert.match(rendered, /PARTIAL DEPTH/);
  assert.match(rendered, /Fee unavailable/);
  assert.match(rendered, /total unavailable/);
  assert.doesNotMatch(rendered, /USDC 60000/);
});

test("owner-produced combined fixture renders qualified daily and stored microstructure observations", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.m1-components.fixture.json");
  assert.equal(frame.dailyInternals.length, frame.assets.length);
  assert.equal(frame.microstructure?.replayClass, "snapshot_only");
  assert.ok(frame.candleAnomalies, "owner frame carries confirmed hourly anomaly aggregates");
  const daily = renderToStaticMarkup(React.createElement(pulse.DailyInternalsPanel, { frame }));
  const micro = renderToStaticMarkup(React.createElement(pulse.MicrostructurePanel, { frame }));
  const breadth = renderToStaticMarkup(React.createElement(pulse.BreadthContextPanel, { frame }));
  const evidence = renderToStaticMarkup(React.createElement(pulse.EvidenceMatrixPanel, { frame, horizon: "15" }));
  assert.match(daily, /Previous completed daily bars/);
  assert.match(daily, /SMA200/);
  assert.match(daily, /contiguous/);
  assert.match(daily, /USDC 19\.9434/, "the SMA value stays inspectable on its cell");
  assert.match(daily, />-0\.06%</);
  assert.match(daily, /-0\.06%\/day/);
  assert.match(daily, /Crossed below/);
  assert.match(daily, /title="No · /, "a qualified no is a value, not a gap");
  assert.match(micro, /snapshot only/);
  assert.match(micro, /Executed spot notional by aggressor side/);
  assert.match(micro, /Unknown share/);
  assert.match(micro, /USDC \+8\.58 → \+12\.9/);
  assert.match(micro, /UNKNOWN_AGGRESSOR/);
  assert.match(micro, /Visible-book walk for recorded order sizes/);
  assert.match(micro, /tabindex="0" role="region" aria-labelledby="mp-flow-observations-caption"/);
  assert.match(micro, /tabindex="0" role="region" aria-labelledby="mp-book-observations-caption"/);
  assert.match(micro, /USDC 21\.614/);
  assert.match(micro, /\+13\.33 bps/);
  assert.match(micro, /total unavailable/);
  assert.match(micro, /reset fixture-reset-1 · 0 gaps/);
  assert.match(breadth, /hourly cohort internals/);
  assert.match(breadth, /efficiency ratio 20 median/);
  assert.match(breadth, /Advance-share change/);
  assert.match(breadth, /Hourly internals/);
  assert.match(breadth, /Current completed-hour quote turnover ≥2× the median of the prior 20 disjoint completed hours/);
  assert.match(breadth, /lies strictly inside EMA20 ±1\.5 Wilder ATR20/);
  assert.match(breadth, /95th percentile of the prior 720 hourly observations/);
  assert.match(breadth, /tabindex="0" role="region" aria-labelledby="mp-hourly-internals-caption"/);
  assert.match(breadth, /tabindex="0" role="region" aria-labelledby="mp-breadth-trajectory-caption"/);
  assert.match(daily, /tabindex="0" role="region" aria-labelledby="mp-daily-internals-caption"/);
  assert.match(evidence, /Price &amp; participation/);
  assert.match(evidence, /count as one correlated family/);
  assert.match(evidence, /Executed spot flow/);
});

test("stored flow history shows per-point totals and breaks across scope, reset, gaps and unavailable points", () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const time = 1_800_000_000_000;
  const flow = (scopeHash, cumulativeDeltaQuote, reasonCodes = [], resetAtMs = time - 300_000) => ({
    componentId: "a".repeat(64), quoteAsset: "USDC", scopeHash,
    expectedInstruments: 5, observedInstruments: 5, completeInstruments: 5,
    buyQuote: "120.5", sellQuote: "100", unknownQuote: "0",
    cumulativeDeltaQuote, resetAt: resetAtMs, reasons: reasonCodes,
  });
  const history = [
    { time: time - 120_000, snapshot_id: "1".repeat(64), source_kind: "observed", expected: 5, gapBefore: false, flowHistory: flow("b".repeat(64), "20.5") },
    { time: time - 60_000, snapshot_id: "2".repeat(64), source_kind: "observed", expected: 5, gapBefore: false, flowHistory: flow("c".repeat(64), null, ["SCOPE_CHANGED"], time - 240_000) },
    { time, snapshot_id: "3".repeat(64), source_kind: "reconstructed", expected: 5, gapBefore: true, flowHistory: null },
  ];
  const markup = renderToStaticMarkup(React.createElement(pulse.FlowHistoryPanel, { history, window: "24h", fault: null }));
  assert.match(markup, /tabindex="0" role="region" aria-labelledby="mp-flow-history-caption"/);
  assert.match(markup, /Stored aggregate executed spot flow for the selected window/);
  assert.match(markup, /USDC 120\.5/);
  assert.match(markup, /USDC \+20\.5/);
  assert.match(markup, /Unavailable · SCOPE_CHANGED/);
  assert.match(markup, /Break · CVD unavailable, scope changed, reset changed/);
  assert.match(markup, /Break · stored history gap, flow unavailable/);
  assert.match(markup, /Unavailable · no flow aggregate in this stored point/);
  assert.match(markup, /totals are per stored point; they are never summed across gaps/);
});

test("combined owner preview uses stored per-point flow history and keeps its unknown-side gap", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.m1-components.fixture.json");
  const history = stored.projectHistory(read("market-picture.m1-components.history.json"), frame);
  const markup = renderToStaticMarkup(React.createElement(pulse.FlowHistoryPanel, { history, window: "1h", fault: null }));
  assert.match(markup, /showing 3 of 3 retained points/);
  assert.match(markup, /reset 1799999820000/);
  assert.match(markup, /UNKNOWN_AGGRESSOR/);
  assert.match(markup, /CVD unavailable/);
  assert.match(markup, /totals are per stored point; they are never summed across gaps/);
});

test("book-cost history percentile remains visible when fee provenance is unavailable", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.m1-components.fixture.json");
  const row = frame.microstructure.liquidity.find(item => item.feeBps == null && item.costBps != null);
  assert.ok(row);
  Object.assign(row, {
    costPercentile7d: 0.75, costPercentileSampleCount: 9500,
    costPercentileExpectedSamples: 10080, costPercentileReasons: [],
    costPercentileReferenceDigest: "c".repeat(64),
  });
  const markup = renderToStaticMarkup(React.createElement(pulse.MicrostructurePanel, { frame }));
  assert.match(markup, /75 percentile/);
  assert.match(markup, /9500\/10080 samples/);
  assert.match(markup, /ref cccccccccccc…/);
  assert.match(markup, /Fee unavailable \/ total unavailable/);
});

test("complete order-size cost stays visible when only the wider band lacks depth", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.m1-components.fixture.json");
  const row = frame.microstructure.liquidity.find(item => item.side === "buy" && Number(item.uncovered) === 0);
  assert.ok(row);
  row.reasons = ["BOOK_DEPTH_INSUFFICIENT"];
  row.bandComplete = false;
  row.bandImbalance = null;
  const markup = renderToStaticMarkup(React.createElement(pulse.MicrostructurePanel, { frame }));
  assert.match(markup, /USDC 21\.614/);
  assert.match(markup, /\+13\.33 bps/);
  assert.match(markup, /10 bps band · partial/);
  assert.match(markup, /BOOK_DEPTH_INSUFFICIENT/);
});

test("microstructure freshness follows the view clock while frozen snapshots stay evaluated at decision time", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.m1-components.fixture.json");
  const decisionTime = frame.available_at_ms;
  for (const row of frame.microstructure.flows) row.expires = decisionTime + 5_000;
  for (const row of frame.microstructure.liquidity) row.expires = decisionTime + 5_000;

  const live = renderToStaticMarkup(React.createElement(pulse.MicrostructurePanel, { frame, asOf: decisionTime + 6_000 }));
  assert.match(live, /assessed as of/);
  assert.match(live, /EXPIRED/);
  assert.match(live, /Confirmation<\/th><th>Cumulative delta/);
  assert.match(live, /Unavailable/);
  assert.doesNotMatch(live, /<td>USDC \+13\.33 bps<\/td>/);
  const evidence = renderToStaticMarkup(React.createElement(pulse.EvidenceMatrixPanel, { frame, horizon: "15", asOf: decisionTime + 6_000 }));
  assert.doesNotMatch(evidence, /OBSERVED · QUALIFIED/);
  assert.match(evidence, /unexpired at 2027-01-15T08:00:07\.000Z/);
  assert.match(evidence, /data-state="OBSERVED · EXPIRED"/);

  const frozen = renderToStaticMarkup(React.createElement(pulse.MicrostructurePanel, { frame, asOf: decisionTime }));
  assert.doesNotMatch(frozen, /EXPIRED/);
  assert.match(frozen, /COMPLETE/);
});

test("breadth context renders owner trajectory metadata and preserves unavailable historical comparisons", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.240.fixture.json");
  frame.breadthTrajectory = [{
    horizon: 15, interval: 5, cutoff: 1800000000000, matched: 4, expected: 5, membership: "a".repeat(64),
    level: metric(0.25, { unit: "index_minus1_to1" }),
    change: metric(null, { unit: "index_points", status: "UNAVAILABLE", reasons: ["INSUFFICIENT_HISTORY"] }),
    shareChange: metric(4.5, { unit: "percentage_points", definition: "breadth_advancing_share_change v1" }),
    velocity: metric(null, { unit: "index_points_per_minute", status: "UNAVAILABLE", reasons: ["INSUFFICIENT_HISTORY"] }),
    acceleration: metric(null, { unit: "index_points_per_minute_squared", status: "UNAVAILABLE", reasons: ["INSUFFICIENT_HISTORY"] }),
  }];
  frame.hourlyInternals = {
    interval: 60, cutoff: 1800000000000, decisionAvailable: 1800000000100, expires: 1800000001000,
    sourceKind: "observed", sourceDigest: "b".repeat(64), sourceCount: 4, expected: 5,
    metrics: {
      above_sma20_share: metric(0.8, { unit: "share_fraction", valid: 4, expected: 5, status: "PARTIAL", reasons: ["INSUFFICIENT_COVERAGE"] }),
      sma20_slope_pct_per_hour_median: metric(0.215, { unit: "return_percent", definition: "sma20_slope_pct_per_hour_median v1" }),
    },
  };
  const markup = renderToStaticMarkup(React.createElement(pulse.BreadthContextPanel, { frame }));
  assert.match(markup, /Matched-universe pressure level and its change, velocity, and acceleration/);
  assert.match(markup, /4\/5/);
  assert.match(markup, /INSUFFICIENT_HISTORY/);
  assert.match(markup, /Advance-share change/);
  assert.match(markup, /\+4\.500 pp/);
  assert.match(markup, /hourly cohort internals/);
  assert.match(markup, /above sma20 share/);
  assert.match(markup, /4\/5 · INSUFFICIENT_COVERAGE/);
  assert.match(markup, /\+0\.215%\/hour/);
  assert.doesNotMatch(markup, /\+0\.215 pp/);
  const availability = renderToStaticMarkup(React.createElement(pulse.AvailabilityLine, { frame, asOf: frame.available_at_ms, horizon: "15" }));
  assert.match(availability, /Price–breadth divergence/);
  assert.doesNotMatch(availability, /Breadth trajectory/, "a trajectory with one qualified value is drawn, not listed as missing");
});

test("daily internals render confirmed-source coverage and explicit unavailable features", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.240.fixture.json");
  const unavailable = renderToStaticMarkup(React.createElement(pulse.DailyInternalsPanel, { frame }));
  assert.equal(unavailable, "");
  assert.match(renderToStaticMarkup(React.createElement(pulse.AvailabilityLine, { frame, asOf: frame.available_at_ms, horizon: "15" })), /no owner-qualified daily-internals projection/i);
  frame.dailyInternals = [{
    instrumentId: "okx:spot:BTC-USDC", interval: "1d", cutoff: 1800000000000, decisionAvailable: 1800000001000,
    source: null, sourceCoverageStatus: "UNAVAILABLE", sourceCoverage: { expectedBars: 401, validBars: 200, gaps: 0 }, contiguousBars: 200, sourceReasons: ["SOURCE_UNAVAILABLE"],
    breaks: { high_break: { metricId: "daily_high_break_20d", definitionId: "current_daily_high_vs_prior_20d_highs", label: null, samples: 0, required: 21, metric: metric(null, { unit: "count", reasons: ["INSUFFICIENT_HISTORY"] }) } },
    averages: { "200": { sma: { metricId: "daily_sma_200", definitionId: "daily_sma_200", label: null, samples: 200, required: 200, metric: metric(101.2345, { unit: "price_quote" }) } } },
  }];
  const rendered = renderToStaticMarkup(React.createElement(pulse.DailyInternalsPanel, { frame }));
  assert.match(rendered, /Previous completed daily bars/);
  assert.doesNotMatch(rendered, /High &gt; 20d high/, "a column with no qualified value is left out");
  assert.match(rendered, /USDC 101\.2345/);
  assert.match(rendered, /200\/401 bars · 200 contiguous · 0 gaps · UNAVAILABLE/);
});

test("a populated frame states a verdict and its rule", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.240.fixture.json");
  const markup = renderToStaticMarkup(React.createElement(pulse.MarketPulseHero, {
    frame, history: [], horizon: "15", window: "24h", setHorizon() {}, setWindow() {}, replay() {},
  }));
  assert.match(markup, /Waiting for 6h history/);
  assert.doesNotMatch(markup, /Risk-on|Risk-off|Mixed|How is this decided\?/);
  assert.match(markup, /Recording market history/, "without stored history the chart area says it is recording instead of failing");
});

test("relative-strength history is unavailable without an owner comparison reference", async () => {
  const assets = load("features/market-picture/AssetPanels.tsx");
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const relative = load("features/market-picture/RelativeStrengthVisuals.tsx");
  const frame = await fixtureFrame("market-picture.v1.json");
  const markup = renderToStaticMarkup(React.createElement(assets.LeadersLaggardsPanel, {
    frame, selected: null, select() {}, cohort: new Set(), benchmark: "BTC",
  }));
  assert.match(markup, /Pullback candidates · positive 24h excess vs BTC, negative 1h/);
  const view = (f) => renderToStaticMarkup(React.createElement(relative.RelativeStrengthVisuals, { frame: f, benchmark: "BTC", asOf: f.available_at_ms, select() {}, selected: null }));
  assert.doesNotMatch(view(frame), /Strengthening|Weakening/, "no direction without a qualified reference");
  assert.match(renderToStaticMarkup(React.createElement(pulse.AvailabilityLine, { frame, asOf: frame.available_at_ms, horizon: "15" })), /Relative-strength change vs BTC/);
  const qualifiedFrame = {
    ...frame,
    comparisons: {
      ...frame.comparisons,
      "relative_strength/btc": metric(0.25, {
        unit: "percentage_points", valid: 2, expected: 2,
        definition: "relative_strength_change_btc v1",
      }),
    },
  };
  const qualified = view(qualifiedFrame);
  assert.match(qualified, /Strengthening/);
  assert.match(qualified, /median 24h excess return \+0\.25 pp over 1h/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(pulse.AvailabilityLine, { frame: qualifiedFrame, asOf: frame.available_at_ms, horizon: "15" })), /Relative-strength change/);
});

test("one-hour relative-rank movement renders owner ranks with explicit direction and baseline", async () => {
  const relative = load("features/market-picture/RelativeStrengthVisuals.tsx");
  const frame = await fixtureFrame("market-picture.relative-ranks.1h.fixture.json");
  const markup = renderToStaticMarkup(React.createElement(relative.RelativeStrengthVisuals, {
    frame, benchmark: "BTC", asOf: frame.available_at_ms, select() {}, selected: null,
  }));
  assert.match(markup, /One-hour relative-rank movement/);
  assert.match(markup, /2\/2 matched/);
  assert.match(markup, /baseline \d\d:\d\d UTC/);
  assert.match(markup, /ETH[\s\S]*\+1 places?[\s\S]*Improving/);
  assert.match(markup, /BTC[\s\S]*-1 places?[\s\S]*Weakening/);
});

test("the single page has no section tab bar and no taker-flow or 52-week tiles", () => {
  const page = fs.readFileSync(new URL("../src/features/market-picture/MarketPicture.tsx", import.meta.url), "utf8");
  for (const removed of ["Market Picture sections", "Command center", 'href="#mp-regimes"', 'href="#mp-correlations"', 'href="#mp-heatmap"', 'href="#mp-feed"', "mp-command-link"])
    assert.ok(!page.includes(removed), `${removed} was removed`);
  for (const kept of ["Coverage & sources", "Screener tools", "Share view", "Export", "Freeze"])
    assert.ok(page.includes(kept), `${kept} stays reachable`);
  const pulse = fs.readFileSync(new URL("../src/features/market-picture/MarketPulse.tsx", import.meta.url), "utf8");
  assert.ok(!/52W|highs_52w|lows_52w/.test(pulse), "52-week tiles are dropped: no daily history exists");
  const feed = fs.readFileSync(new URL("../src/features/market-picture/DetailViews.tsx", import.meta.url), "utf8");
  assert.ok(!/Taker flow unavailable/.test(feed), "the disabled flow source draws no tile");
});

// ---- Hero stability: smoothing, hold band, default horizon -------------------------------------

const MINUTE = 60_000;
const BASE = Date.parse("2026-10-01T00:00:00Z");
/** One stored minute with the same pressure on every horizon. */
const flat = (minute, pressure, extra = {}) => ({
  time: BASE + minute * MINUTE, snapshot_id: null, source_kind: "observed", valid: 5, expected: 5, membership: "m", gapBefore: false, summary: {},
  breadth: Object.fromEntries(HORIZONS.map((h) => [h, { positive: 0, negative: 0, flat: 1, pressure }])), ...extra,
});
const at = (minute, pressure) => ({ ...frameWith({ pressure: Object.fromEntries(HORIZONS.map((h) => [h, pressure])) }), cutoff_ms: BASE + minute * MINUTE });

test("the hold band keeps a state until the score is back inside it, and Mixed needs no history", () => {
  assert.equal(VERDICT_HOLD, 0.1);
  assert.equal(nextVerdictState("mixed", 0.24), "mixed");
  assert.equal(nextVerdictState("mixed", 0.25), "risk-on");
  assert.equal(nextVerdictState("risk-on", 0.2), "risk-on", "inside the band the held state stays");
  assert.equal(nextVerdictState("risk-on", 0.1), "mixed", "at the hold edge it is released");
  assert.equal(nextVerdictState("risk-off", -0.2), "risk-off");
  assert.equal(nextVerdictState("risk-off", -0.05), "mixed");
  assert.equal(nextVerdictState("risk-on", -0.3), "risk-off", "crossing straight through still flips");
});

test("canonical replay refuses a complete clock grid when required historical pressures are absent", async () => {
  const { canonicalVerdictHistoryFault } = await import("../src/features/market-picture/pulse.mjs");
  const until = 21_600_000;
  const horizons = ["1", "5", "15", "60", "240", "1440"];
  const history = Array.from({ length: 360 }, (_, i) => ({
    time: until - (360 - i) * 60_000,
    breadth: Object.fromEntries(horizons.map((h) => [h, { pressure: null }])),
  }));
  assert.match(canonicalVerdictHistoryFault(history, "60", until), /lacks historical pressure/);
  history.forEach((point) => {
    point.breadth["60"].pressure = 0;
    point.breadth["15"].pressure = 0;
  });
  assert.equal(canonicalVerdictHistoryFault(history, "60", until), null);
  history[100].breadth["60"].pressure = null;
  assert.match(canonicalVerdictHistoryFault(history, "60", until), /lacks historical pressure/);
});

test("a score drifting around the entry threshold does not flap the verdict", () => {
  // Prior frames sit at +0.4 (pressure +1.2): risk-on is entered. The latest frame dips to +0.2.
  const history = Array.from({ length: 30 }, (_, i) => flat(i, 1.2));
  const dipped = at(30, 0.6);
  const held = marketVerdict(dipped, "60", { history, smooth: false });
  assert.equal(held.state, "risk-on");
  assert.equal(held.held, true, "the state is kept by the band, and says so");
  assert.ok(held.instantScore < VERDICT_THRESHOLD);
  // Without stored history the same frame is Mixed: the band needs a state to hold.
  assert.equal(marketVerdict(dipped, "60").state, "mixed");
  // A score that falls back inside the band releases the state.
  assert.equal(marketVerdict(at(30, 0.15), "60", { history, smooth: false }).state, "mixed");
});

test("smoothing averages the trailing 15 minutes of stored frames and labels what it did", () => {
  assert.equal(SMOOTHING_MINUTES, 15);
  // Alternating +3/-3 pressure: the live coarse vote flips every minute.
  const history = Array.from({ length: 40 }, (_, i) => flat(i, i % 2 ? 3 : -3));
  const raw = marketVerdict(at(40, 3), "60", { history, smooth: false });
  assert.equal(raw.state, "risk-on", "unsmoothed, the last vote decides");
  assert.equal(raw.smoothed, false);
  const smooth = marketVerdict(at(40, 3), "60", { history, smooth: true });
  assert.equal(smooth.smoothed, true);
  assert.equal(smooth.state, "mixed", "the 15-minute mean of a +3/-3 alternation is near zero");
  assert.ok(Math.abs(smooth.score) < VERDICT_THRESHOLD);
  assert.equal(smooth.instantScore, raw.instantScore, "the latest-frame score stays visible");
  assert.deepEqual(smooth.components.filter((c) => c.id !== "return").map((c) => c.label.endsWith("15m mean")), [true, true], "smoothed components say so");
  assert.ok(smooth.components.find((c) => c.id === "breadth").detail.includes("latest score +1.00"), "the latest value stays in the detail");
  assert.ok(smooth.smoothedFrames > 1 && smooth.smoothedFrames <= SMOOTHING_MINUTES + 1);
  assert.match(smooth.rule, /trailing 15 minutes/);
  assert.match(smooth.rule, /±0\.10/);
});

test("the smoothing window restarts after a coverage break and skips missing pressure", () => {
  const pts = [flat(0, 3), flat(1, 3), flat(2, -3, { gapBefore: true }), flat(3, -3)];
  const v = (p) => p.breadth["60"].pressure;
  assert.deepEqual(rollingMean(pts, v, 15), [3, 3, -3, -3]);
  const withHole = [flat(0, 3), flat(1, null), flat(2, 1)];
  assert.deepEqual(rollingMean(withHole, v, 15), [3, 3, 2]);
  const sparse = [flat(0, 3), flat(20, -3)];
  assert.deepEqual(rollingMean(sparse, v, 15), [3, -3], "samples older than the window drop out");
});

test("pulse series keeps raw pressure and adds the 15-minute mean without bridging gaps", () => {
  const history = Array.from({ length: 60 }, (_, i) => flat(i, i % 2 ? 3 : -3));
  const result = pulseSeries(history, "6h", "60");
  assert.equal(result.pressure.length, result.smoothed.length);
  assert.ok(result.pressure.every((p) => Math.abs(p.value) === 3), "raw values are untouched");
  const settled = result.smoothed.slice(20);
  assert.ok(settled.every((p) => Math.abs(p.value) < 0.5), "alternation averages out");
  const gapped = pulseSeries(history.map((p, i) => (i === 30 ? { ...p, gapBefore: true } : p)), "6h", "60");
  assert.ok(gapped.smoothed.some((p) => p.value === null), "the break stays an explicit gap in both series");
});

test("the hero opens on the 1h horizon with every horizon on one timeline and no sliders", async () => {
  assert.equal(model.DEFAULT_HORIZON, "60");
  assert.equal(model.normalizeView({}).horizon, "60");
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.240.fixture.json");
  const history = Array.from({ length: 40 }, (_, i) => flat(i, i % 2 ? 3 : -3, { valid: frame.valid, expected: frame.expected }));
  const markup = renderToStaticMarkup(React.createElement(pulse.MarketPulseHero, {
    frame, history, horizon: "60", window: "6h", setHorizon() {}, setWindow() {}, replay() {}, onZoom() {},
  }));
  assert.match(markup, /aria-label="Breadth horizon"/);
  assert.match(markup, /aria-label="History window"/);
  assert.match(markup, /colour = breadth pressure per horizon/);
  assert.match(markup, /Drag to zoom/);
  assert.doesNotMatch(markup, /type="range"/);
  assert.match(markup, /Waiting for 6h history/);
});

test("the breadth chart exposes a keyboard-operable data-table disclosure", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.240.fixture.json");
  const history = [flat(0, 3), flat(1, -3), flat(3, 0, { gapBefore: true })];
  const markup = renderToStaticMarkup(React.createElement(pulse.MarketPulseHero, {
    frame, history, horizon: "60", window: "6h", setHorizon() {}, setWindow() {}, replay() {}, onZoom() {},
  }));
  assert.match(markup, /<details class="mp-pulse-data">/);
  assert.match(markup, /<summary>Breadth data table · 3 retained observations/);
  assert.doesNotMatch(markup, /id="mp-pulse-data-table"/, "table rows stay unmounted until disclosure opens");
});

test("breadth table rows preserve zeros, nulls and gap flags for every horizon, newest first", () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const sample = (minute, pressure, gapBefore = false) => ({
    ...flat(minute, pressure, { gapBefore }),
    breadth: Object.fromEntries(HORIZONS.map((h) => [h, { positive: null, negative: null, flat: 0, pressure }])),
  });
  const history = [sample(0, null), sample(1, -3), sample(3, 0, true)];
  const markup = renderToStaticMarkup(React.createElement(pulse.PulseDataTable, { samples: history, label: "Requested 6h · available 3m" }));
  const rows = markup.split("<tr>").slice(2);
  assert.equal(rows.length, 3, "one row per retained observation");
  assert.match(rows[0], /2026-10-01 00:03.*after gap/, "newest first, with its owner gap flag");
  assert.equal((rows[0].match(/>0\.00</g) ?? []).length, HORIZONS.length, "a real zero stays zero");
  assert.equal((rows[1].match(/>-3\.00</g) ?? []).length, HORIZONS.length);
  assert.equal((rows[2].match(/>—</g) ?? []).length, HORIZONS.length, "a missing value is not filled");
});

test("opened breadth table discloses its window and bounds long histories to the newest rows", () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const history = Array.from({ length: 320 }, (_, i) => flat(i, i % 2 ? 3 : -3));
  const markup = renderToStaticMarkup(React.createElement(pulse.PulseDataTable, { samples: history, label: "Requested 6h · available 5h 19m" }));
  assert.match(markup, /Breadth pressure \(−3…\+3\) by horizon · Requested 6h · available 5h 19m · newest first · newest 300 of 320/);
  assert.equal((markup.match(/<tr\b/g) ?? []).length, 301, "header plus the newest 300 observations");
});

test("single-bar relative volume is recognised by its owner definition and nothing else", () => {
  for (const definition of ["median_relative_volume_24h v1.0.0", "rvol24h v1.2.0", "rvol20 v1.0.0"])
    assert.equal(isSingleBarRelativeVolume({ definition }), true, definition);
  for (const definition of ["median_relative_volume_1h v1.0.0", "median_relative_volume_24h v2.0.0", "", undefined])
    assert.equal(isSingleBarRelativeVolume({ definition }), false, String(definition));
  assert.equal(isSingleBarRelativeVolume(undefined), false);
});

test("the Relative volume tile is dropped for the single-bar definition and returns for an aggregated one", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.240.fixture.json");
  const render = (definition) => renderToStaticMarkup(React.createElement(pulse.MarketSnapshotTiles, {
    frame: { ...frame, summary: { ...frame.summary, relative_volume_24h: metric(0.003, { unit: "ratio", definition }) } }, history: [], window: "24h",
  }));
  assert.doesNotMatch(render("median_relative_volume_24h v1.0.0"), /Relative volume/);
  assert.match(render("median_relative_volume_1h v1.0.0"), /Relative volume/);
});

test("the hourly relative-volume definition is recognised separately from the single-bar ones", () => {
  for (const definition of ["median_relative_volume_1h v1.0.0", "rvol1h v1.0.0"])
    assert.equal(isHourlyRelativeVolume({ definition }), true, definition);
  for (const definition of ["median_relative_volume_24h v1.0.0", "rvol20 v1.0.0", "median_relative_volume_1h v2.0.0", "", undefined])
    assert.equal(isHourlyRelativeVolume({ definition }), false, String(definition));
  assert.equal(isHourlyRelativeVolume(undefined), false);
});

test("a withheld value is labelled with its owner reason code, never a generic word", () => {
  assert.equal(nullReasonLabel(metric(null, { reasons: ["ZERO_BASELINE"] })), "no volume in the 24h baseline (ZERO_BASELINE)");
  assert.equal(nullReasonLabel(metric(null, { reasons: ["BAR_GAP"] })), "BAR_GAP");
  assert.equal(nullReasonLabel(metric(null, { reasons: [] })), null);
  assert.equal(nullReasonLabel(metric(1.2, { reasons: [] })), null);
  assert.equal(nullReasonLabel(undefined), null);
});

const tilesFor = (pulse, frame, history = []) =>
  renderToStaticMarkup(React.createElement(pulse.MarketSnapshotTiles, { frame, history, window: "24h" }));

test("the hourly generation shows a Relative volume (1h) tile and the legacy one keeps hiding the single-minute tile", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const current = await fixtureFrame("market-picture.v1.json");
  assert.ok("relative_volume_1h" in current.summary && !("relative_volume_24h" in current.summary));
  const withValue = (frame, key, definition, value = 1.37) => ({
    ...frame, summary: { ...frame.summary, [key]: metric(value, { unit: "ratio", definition }) },
  });
  const shown = tilesFor(pulse, withValue(current, "relative_volume_1h", "median_relative_volume_1h v1.0.0"));
  assert.match(shown, /Relative volume \(1h\)/);
  assert.match(shown, /last 60 min vs prior 24h hourly mean/);
  assert.match(shown, /1\.37/);
  // Withheld relative volume draws no tile; independent source-family readings can be unavailable.
  const withheld = tilesFor(pulse, {
    ...current, summary: { ...current.summary, relative_volume_1h: metric(null, { unit: "ratio", reasons: ["ZERO_BASELINE"], definition: "median_relative_volume_1h v1.0.0" }) },
  });
  assert.doesNotMatch(withheld, /Relative volume/);
  const legacy = await fixtureFrame("market-picture.240.fixture.json");
  assert.ok("relative_volume_24h" in legacy.summary && !("relative_volume_1h" in legacy.summary));
  const hidden = tilesFor(pulse, withValue(legacy, "relative_volume_24h", "median_relative_volume_24h v1.0.0", 0.003));
  assert.doesNotMatch(hidden, /Relative volume/);
});

test("tile history reads whichever relative-volume key a stored point carries, never bridging definitions", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const current = await fixtureFrame("market-picture.v1.json");
  const frame = { ...current, summary: { ...current.summary, relative_volume_1h: metric(1.5, { unit: "ratio", definition: "median_relative_volume_1h v1.0.0" }) } };
  // Points from before the switch carry the retired key; they are not drawn on the hourly tile.
  const history = Array.from({ length: 60 }, (_, i) => point(i, {
    summary: i < 30 ? { relative_volume_24h: 0.2 } : { relative_volume_1h: 1 + i / 100 },
  }));
  const markup = tilesFor(pulse, frame, history);
  assert.match(markup, /Relative volume \(1h\)/);
  assert.doesNotMatch(markup, /NaN|undefined/);
});

test("the asset inspector labels hourly relative volume and any withheld reason code", async () => {
  const views = load("features/market-picture/DetailViews.tsx");
  const frame = await fixtureFrame("market-picture.v1.json");
  const asset = frame.assets[0];
  assert.ok("rvol_1h" in asset.indicators && !("rvol_24h" in asset.indicators));
  const render = (rvol) => renderToStaticMarkup(React.createElement(views.AssetInspector, {
    asset: { ...asset, indicators: { ...asset.indicators, rvol_1h: rvol } }, frame, watched: false, toggleWatch() {}, note: "", saveNote() {}, openNativeTools() {},
  }));
  const hourly = (extra) => metric(extra.value ?? null, { unit: "ratio", definition: "rvol1h v1.0.0", ...extra });
  const shown = render(hourly({ value: 0.8123 }));
  assert.match(shown, /Relative volume \(1h\) · last 60 min vs prior 24h hourly mean/);
  assert.match(shown, /0\.8123/);
  const zero = render(hourly({ value: null, reasons: ["ZERO_BASELINE"] }));
  const row = zero.match(/<tr><th scope="row">Relative volume \(1h\)[\s\S]*?<\/tr>/)[0];
  assert.match(row, /no volume in the 24h baseline \(ZERO_BASELINE\)/);
  assert.doesNotMatch(row, /navailable|UNAVAILABLE/);
  const legacy = await fixtureFrame("market-picture.240.fixture.json");
  const old = renderToStaticMarkup(React.createElement(views.AssetInspector, {
    asset: legacy.assets[0], frame: legacy, watched: false, toggleWatch() {}, note: "", saveNote() {}, openNativeTools() {},
  }));
  assert.ok("rvol_24h" in legacy.assets[0].indicators);
  assert.match(old, /rvol 24h/);
});

test("asset drawer reuses the selected frame daily and flow/book observations without fabricating full cost", async () => {
  const views = load("features/market-picture/DetailViews.tsx");
  const frame = await fixtureFrame("market-picture.m1-components.fixture.json");
  const asset = frame.assets.find(row => row.instrument_id === "okx:spot:BTC-USDC");
  const bookOnly = frame.microstructure.liquidity.find(row => row.side === "buy" && Number(row.uncovered) === 0);
  bookOnly.reasons = ["BOOK_DEPTH_INSUFFICIENT"];
  bookOnly.bandComplete = false;
  bookOnly.bandImbalance = null;
  const markup = renderToStaticMarkup(React.createElement(views.AssetInspector, {
    asset, frame, watched: false, toggleWatch() {}, note: "", saveNote() {}, openNativeTools() {},
  }));
  assert.match(markup, /Daily internals/);
  assert.match(markup, /SMA 200 sma/);
  assert.match(markup, /USDC 22\.7774/);
  assert.match(markup, /SMA 20 above close/);
  assert.match(markup, />No</);
  assert.match(markup, /\+0\.16%\/day/);
  assert.match(markup, /No cross/);
  assert.match(markup, /Executed flow &amp; displayed book/);
  assert.match(markup, /BTC|BTC-USDC/);
  assert.match(markup, /PARTIAL DEPTH/);
  assert.match(markup, /USDC 21\.614 · \+13\.33 bps/);
  assert.match(markup, /10 bps band · partial/);
  assert.match(markup, /Fee unavailable \/ total unavailable/);
  assert.match(markup, /fee absence does not hide a complete book-only estimate/);
  assert.match(markup, /tabindex="0" role="region" aria-labelledby="mp-drawer-flow-caption"/);
  assert.match(markup, /tabindex="0" role="region" aria-labelledby="mp-drawer-book-caption"/);
  assert.match(markup, /no typed derivatives, liquidation, or options observation/);

  for (const row of frame.microstructure.flows) row.expires = frame.available_at_ms + 5_000;
  for (const row of frame.microstructure.liquidity) row.expires = frame.available_at_ms + 5_000;
  const stale = renderToStaticMarkup(React.createElement(views.AssetInspector, {
    asset, frame, asOf: frame.available_at_ms + 6_000,
    watched: false, toggleWatch() {}, note: "", saveNote() {}, openNativeTools() {},
  }));
  assert.match(stale, /EXPIRED/);
  assert.match(stale, /Unavailable · expired/);
  assert.match(stale, /USDC 12\.95 \/ 8\.63 \/ 0/);
});

// ---- Correlation history ------------------------------------------------------------------------

const corr = (value, samples, expected, extra = {}) => ({ instrument_id: "okx:spot:ETH-USDC", benchmark_id: "okx:spot:BTC-USDC", value, samples, expected, cutoff: 1, reasons: value === null ? ["INSUFFICIENT_HISTORY"] : [], trend: [], ...extra });

test("correlation readout reports the real window and paired count and never fills in a coefficient", () => {
  assert.deepEqual(correlationReadout([]), { kind: "none" });
  assert.deepEqual(correlationReadout([corr(null, 177, 2160, { benchmark_id: "okx:spot:ETH-USDC" })]), { kind: "none" }, "self pairs are ignored");
  const building = correlationReadout([corr(null, 177, 2160), corr(null, 120, 2160)]);
  assert.equal(building.kind, "building");
  assert.equal(building.samples, 177);
  assert.equal(building.needed, 2052);
  assert.equal(building.window, "90D");
  assert.ok(Math.abs(building.share - 177 / 2160) < 1e-12);
  const week = correlationReadout([corr(0.62, 168, 168), corr(null, 168, 2160)]);
  assert.deepEqual(week, { kind: "values", expected: 168, samples: 168, window: "7D", definition: "pearson_log_1h_168h", partial: true });
  assert.equal(correlationReadout([corr(0.4, 2160, 2160)]).definition, "pearson_log_1h_90d");
  assert.equal(correlationReadout([corr(0.4, 24, 24)]).definition, "pearson_log_1h_24h");
  assert.equal(correlationReadout([corr(null, 12, 24)]).definition, "pearson_log_1h_24h");
  const full = correlationReadout([corr(0.62, 2160, 2160), corr(0.4, 168, 168)]);
  assert.equal(full.window, "90D");
  assert.equal(full.partial, false);
});

test("the correlations panel labels a partial window and shows progress while every coefficient is withheld", () => {
  const assets = load("features/market-picture/AssetPanels.tsx");
  const frame = { assets: [{ instrument_id: "okx:spot:ETH-USDC", symbol: "ETH" }, { instrument_id: "okx:spot:BTC-USDC", symbol: "BTC" }] };
  const props = { frame, selected: null, select() {}, cohort: new Set(), benchmark: "BTC", setBenchmark() {}, openMatrix() {} };
  const building = renderToStaticMarkup(React.createElement(assets.CorrelationsPanel, { ...props, correlations: [corr(null, 177, 2160)] }));
  assert.match(building, /177 of 2,160 paired hourly returns/);
  assert.match(building, /2,052/);
  assert.match(building, /building history/);
  assert.doesNotMatch(building, /<table/);
  const partial = renderToStaticMarkup(React.createElement(assets.CorrelationsPanel, { ...props, correlations: [corr(0.62, 168, 168, { definition: "pearson_log_1h_168h" })] }));
  assert.match(partial, /7D of 90D/);
  assert.match(partial, /168 paired hours/);
  assert.match(partial, /pearson_log_1h_168h/);
  assert.match(partial, /0\.62/);
  assert.equal(renderToStaticMarkup(React.createElement(assets.CorrelationsPanel, { ...props, correlations: [] })), "");
});

test("the alert feed folds one- and five-minute breadth crossings behind a count", () => {
  const views = load("features/market-picture/DetailViews.tsx");
  const event = (id, type, horizon) => ({ event_id: id, instrument_id: null, type, severity: "info", observed: 1, available: 1, status: "original", reconstructed: false, snapshot_id: "s", horizon_minutes: horizon, value: `v-${id}` });
  const events = [event("a", "breadth_threshold_crossing", 1), event("b", "breadth_threshold_crossing", 5), event("c", "breadth_threshold_crossing", 60), event("d", "provider_quality_transition", null)];
  assert.deepEqual(events.map(isShortBreadthCrossing), [true, true, false, false]);
  const markup = renderToStaticMarkup(React.createElement(views.MarketEventFeed, { events, frame: null, select() {}, nextPage() {}, hasMore: false }));
  assert.match(markup, /2 one- and five-minute breadth crossings folded/);
  assert.doesNotMatch(markup, /v-a|v-b/);
  assert.match(markup, /v-c/);
  assert.match(markup, /v-d/);
});
