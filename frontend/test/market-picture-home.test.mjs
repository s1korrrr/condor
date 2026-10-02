import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";
import { projectFrame, validateFrame } from "../src/features/market-picture/contract.mjs";
import {
  VERDICT_THRESHOLD,
  assetState,
  breadthLadder,
  bucketMinutes,
  derivedRegime,
  hasCorrelationValues,
  impliedMove,
  marketVerdict,
  pulseSeries,
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
});
const read = (file) =>
  JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/${file}`, import.meta.url), "utf8"));
const metric = (value, extra = {}) => ({ value, original: String(value), unit: "x", status: value == null ? "UNAVAILABLE" : "VALID", reasons: [], valid: 5, expected: 5, available: 1, expires: 2, definition: "d v1", ...extra });
const HORIZONS = ["1", "5", "15", "60", "240", "1440"];

function frameWith({ pressure = {}, mean = {}, vol = 0.5, advancing = 3 } = {}) {
  return {
    expected: 5,
    pressure: Object.fromEntries(HORIZONS.map((h) => [h, metric(pressure[h] ?? 0)])),
    distribution: Object.fromEntries(HORIZONS.map((h) => [h, { mean: metric(mean[h] ?? 0), total: 5 }])),
    summary: { realized_volatility_24h: metric(vol) },
    breadth: Object.fromEntries(HORIZONS.map((h) => [h, { advancing, declining: 5 - advancing, unchanged: 0, valid: 5, expected: 5, positive: metric(advancing / 5), negative: metric((5 - advancing) / 5), flat: metric(0) }])),
  };
}

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
  assert.equal(up.label, "Trend up");
  assert.equal(up.basis, "derived");
  assert.match(up.detail, /derived from observed ADX14/);
  const down = derivedRegime(asset({ trending: 1, compression: 1, high_volatility: 0, elevated_rvol: 0 }, { ema21: 110, adx14: 31 }));
  assert.equal(down.label, "Trend down");
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

test("home sections render real frames without printing Unavailable", async () => {
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
      React.createElement(assets.InstrumentsPanel, common),
      React.createElement(assets.RegimePanel, common),
      React.createElement(assets.LeadersLaggardsPanel, { ...common, benchmark: "BTC" }),
      React.createElement(overview.ParticipationPanel, { frame, selectPredicate: noop }),
    ].map((element) => renderToStaticMarkup(element)).join("\n");
    assert.doesNotMatch(markup, /Unavailable|unavailable/, `${name} must not render an Unavailable label`);
    assert.match(markup, /Market Pulse/);
  }
});

test("a populated frame states a verdict and its rule", async () => {
  const pulse = load("features/market-picture/MarketPulse.tsx");
  const frame = await fixtureFrame("market-picture.240.fixture.json");
  const markup = renderToStaticMarkup(React.createElement(pulse.MarketPulseHero, {
    frame, history: [], horizon: "15", window: "24h", setHorizon() {}, setWindow() {}, replay() {},
  }));
  assert.match(markup, /Risk-on|Risk-off|Mixed/);
  assert.match(markup, /How is this decided\?/);
  assert.match(markup, /Recording market history/, "without stored history the chart area says it is recording instead of failing");
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
