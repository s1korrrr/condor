/**
 * Parity between the browser and the server-side fleet summary (`GET /servers/{name}/fleet/summary`).
 *
 * The server computes the Market verdict and the fleet PnL windows once so the iPhone/Watch app and the
 * dashboard never re-derive them. These tests replay the SAME shared fixtures that the Python tests replay
 * (`condor/tests/fixtures/fleet_summary/*.json`) through the browser implementations and require the same
 * numbers. `FLEET_SUMMARY_WRITE_GOLDEN=1` rewrites the `expected` blocks from the browser implementation
 * (the reference semantics); a normal run only asserts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { marketVerdict } from "../src/features/market-picture/pulse.mjs";
import { projectFrame } from "../src/features/market-picture/contract.mjs";
import { projectHistory } from "../src/features/market-picture/stored.mjs";
import { frontendModules } from "./helpers/frontend-module.mjs";

const fixtureUrl = (name) => new URL(`../../tests/fixtures/${name}`, import.meta.url);
const readJson = (name) => JSON.parse(fs.readFileSync(fixtureUrl(name), "utf8"));
const WRITE = process.env.FLEET_SUMMARY_WRITE_GOLDEN === "1";
const CUT = 1_800_000_000_000;
const MINUTE = 60_000;
const TOLERANCE = 1e-12;
const HORIZONS = ["1", "5", "15", "60", "240", "1440"];

/** Expand the compact history spec (see `history_spec` in verdict_cases.json) into display history points. */
function expandHistory(spec) {
  if (spec === null || spec === undefined) return undefined;
  const points = [];
  for (const seg of spec) {
    for (let k = seg.from_min; k >= seg.to_min; k--) {
      const pressure = seg.pressure + (seg.step ?? 0) * (seg.from_min - k);
      points.push({
        time: CUT - k * MINUTE,
        gapBefore: seg.gap_first === true && k === seg.from_min,
        breadth: Object.fromEntries(HORIZONS.map((h) => [h, { pressure: ["15", "60", "240", "1440"].includes(h) ? pressure : null }])),
      });
    }
  }
  return points;
}

/** The same spec as stored wire rows, for the raw-frame path through `projectHistory`. */
function wireHistory(spec, frame) {
  const items = [];
  for (const seg of spec) {
    for (let k = seg.from_min; k >= seg.to_min; k--) {
      const pressure = String(seg.pressure + (seg.step ?? 0) * (seg.from_min - k));
      const cutoff = CUT - k * MINUTE;
      items.push({
        cutoff_ms: cutoff,
        available_at_ms: cutoff + 1000,
        snapshot_id: "ab".repeat(32),
        source_kind: "observed",
        coverage: { valid_instruments: 2, expected_instruments: 2 },
        membership_hash: "cd".repeat(32),
        gap_before: seg.gap_first === true && k === seg.from_min,
        summary: {},
        breadth: Object.fromEntries(HORIZONS.map((h) => [h, { positive: null, negative: null, flat: null, pressure: ["15", "60", "240", "1440"].includes(h) ? pressure : null }])),
      });
    }
  }
  return projectHistory({ schema_version: "market-picture.v1", snapshot_id: frame.snapshot_id, read_at_ms: CUT, items }, frame);
}

/** The server's snake_case verdict, from the browser's camelCase one. */
function serverShape(verdict) {
  if (verdict === null) return null;
  return {
    state: verdict.state,
    label: verdict.label,
    score: verdict.score,
    instant_score: verdict.instantScore,
    smoothed: verdict.smoothed,
    smoothed_frames: verdict.smoothedFrames,
    smoothing_minutes: verdict.smoothingMinutes,
    held: verdict.held,
    horizon: verdict.horizon,
    components: verdict.components.map((c) => ({ id: c.id, score: c.score })),
    advancing: verdict.advancing,
    declining: verdict.declining,
    unchanged: verdict.unchanged,
    valid: verdict.valid,
    expected: verdict.expected,
  };
}

function assertSame(actual, expected, path = "verdict") {
  if (expected === null || typeof expected !== "object") {
    if (typeof expected === "number") {
      assert.ok(typeof actual === "number" && Math.abs(actual - expected) <= TOLERANCE, `${path}: ${actual} != ${expected}`);
    } else assert.equal(actual, expected, path);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual) && actual.length === expected.length, `${path}: length`);
    expected.forEach((item, index) => assertSame(actual[index], item, `${path}[${index}]`));
    return;
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: keys`);
  for (const key of Object.keys(expected)) assertSame(actual[key], expected[key], `${path}.${key}`);
}

const verdictFile = readJson("fleet_summary/verdict_cases.json");

test("browser verdict reproduces the shared display-frame cases (server parity)", () => {
  assert.ok(verdictFile.cases.length >= 6, "at least six shared frames");
  for (const entry of verdictFile.cases) {
    const history = expandHistory(entry.history);
    const verdict = serverShape(marketVerdict(entry.frame, entry.horizon, { history, ...(entry.smooth === undefined ? {} : { smooth: entry.smooth }) }));
    if (WRITE) entry.expected = verdict;
    else assertSame(verdict, entry.expected, entry.name);
  }
});

function rawVerdict(entry) {
  const raw = readJson(`${entry.fixture}`);
  for (const mutation of entry.mutations) raw.market_metrics[mutation.metric_id].value = mutation.value;
  const frame = projectFrame(raw);
  const history = entry.history ? wireHistory(entry.history, frame) : undefined;
  return serverShape(marketVerdict(frame, entry.horizon, { history }));
}

test("browser verdict reproduces the shared raw owner-frame cases (server wire adapter parity)", () => {
  for (const entry of verdictFile.raw_cases) {
    const verdict = rawVerdict(entry);
    if (WRITE) entry.expected = verdict;
    else assertSame(verdict, entry.expected, entry.name);
  }
});

test("the shared cases cover both held states, a coverage reset and a null verdict", () => {
  const states = verdictFile.cases.map((entry) => entry.expected?.state ?? null);
  assert.ok(states.includes("risk-on") && states.includes("risk-off") && states.includes("mixed") && states.includes(null));
  assert.ok(verdictFile.cases.some((entry) => entry.expected?.held === true), "a hold-band case exists");
});

// ── fleet PnL: the browser's own computation on the shared recorded reads ──

const performanceFile = readJson("fleet_summary/performance_cases.json");

test("browser fleet windows reproduce the shared performance cases (server parity)", () => {
  const { parseBotHistory, fleetWindow } = frontendModules().load("features/quant-ops/fleet-performance.ts");
  const now = performanceFile.now_ms;
  const clock = now + 5_000;
  assert.ok(performanceFile.cases.length >= 4, "day, week, month and all");
  for (const entry of performanceFile.cases) {
    const histories = performanceFile.bots.map((bot) => parseBotHistory(performanceFile.reads[bot][entry.range], bot, entry.range, clock));
    const starts = histories.flatMap((history) => (history.samples.length ? [history.samples[0].time] : []));
    const from = entry.all ? Math.min(...starts) : now - entry.span_ms;
    const window = fleetWindow(histories, performanceFile.bots, from, now, clock);
    const actual = {
      total: window.total === null ? null : Number(window.total),
      realized: window.realized === null ? null : Number(window.realized),
      unrealized: window.unrealized === null ? null : Number(window.unrealized),
      counted: window.counted,
      expected: window.expected,
      partial: window.partial,
      since_ms: window.since === null ? null : Math.round(window.since),
      latest_at_ms: window.latestAt === null ? null : Math.round(window.latestAt),
      missing: window.missing.map((item) => item.bot),
      restarts: Object.fromEntries(window.bots.map((bot) => [bot.bot, bot.restarts])),
      per_bot: Object.fromEntries(window.bots.map((bot) => [bot.bot, Number(bot.change)])),
    };
    assertSame(actual, entry.expected, entry.name);
  }
});

test("the documented example's verdict is what the browser computes from the same frame and stored history", () => {
  const example = readJson("fleet_summary/summary_full.example.json");
  const frame = projectFrame(readJson("market-picture.240.fixture.json"));
  const items = [];
  for (let k = 60; k >= 1; k--) {
    const cutoff = CUT - k * MINUTE;
    items.push({
      cutoff_ms: cutoff, available_at_ms: cutoff + 1000, snapshot_id: "ab".repeat(32), source_kind: "observed",
      coverage: { valid_instruments: 2, expected_instruments: 2 }, membership_hash: "cd".repeat(32), gap_before: false, summary: {},
      breadth: Object.fromEntries(HORIZONS.map((h) => [h, { positive: null, negative: null, flat: null, pressure: "-0.4" }])),
    });
  }
  const history = projectHistory({ schema_version: "market-picture.v1", snapshot_id: frame.snapshot_id, read_at_ms: CUT, items }, frame);
  const browser = serverShape(marketVerdict(frame, "60", { history }));
  const { horizon_label: label, ...served } = example.market.verdict;
  assert.equal(label, "1h");
  assertSame(browser, served, "example verdict");
  assert.equal(example.market.history_points, 60);
});

test.after(() => {
  if (WRITE) {
    fs.writeFileSync(fixtureUrl("fleet_summary/verdict_cases.json"), JSON.stringify(verdictFile));
  }
});
