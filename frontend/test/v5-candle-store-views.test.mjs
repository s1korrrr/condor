import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";

// Real owner output (hummingbot candle_store_dashboard 9ccf80087 over its fixture store), shared with the
// Python consumer tests. The server validator keeps exactly these fields.
const golden = name => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/candle_store_views/${name}.json`, import.meta.url), "utf8"));
const model = () => frontendModules().load("v5/candle-store-model");

test("heat cells label every state and never treat an outside hour as covered", () => {
  const { heatCell } = model();
  const hour = Date.parse("2026-11-03T07:00:00Z") / 1000;
  assert.equal(heatCell(null, hour).state, "outside");
  assert.equal(heatCell([0, 0, 0, 0, 12], hour).state, "pending");
  assert.notEqual(heatCell([0, 0, 0, 0, 12], hour).color, heatCell([60, 0, 0, 0, 0], hour).color);
  assert.equal(heatCell([58, 2, 0, 0, 0], hour).state, "complete");
  assert.equal(heatCell([50, 0, 4, 0, 6], hour).state, "unrecoverable");
  const gaps = heatCell([40, 0, 1, 19, 0], hour);
  assert.equal(gaps.state, "gaps");
  assert.match(gaps.label, /2026-11-03 07:00 UTC hour · final 40 · no-trade 0 · unrecoverable 1 · missing 19 · pending 0 min/);
});

test("row coverage excludes pending minutes and is unavailable, not 100%, without settled minutes", () => {
  const { heatRowCoverage } = model();
  assert.equal(heatRowCoverage({ cells: [null, [0, 0, 0, 0, 30]] }), null);
  assert.equal(heatRowCoverage({ cells: [[30, 10, 0, 0, 20], [20, 0, 0, 20, 0], null] }), 60 / 80);
});

test("heat strips put the newest owner hour on the left", () => {
  const { heatStripOrder } = model();
  assert.deepEqual(heatStripOrder({ hours: [10, 20, 30] }), [2, 1, 0]);
});

test("cross deviation keeps gaps as null on a shared time axis and colours venues consistently", () => {
  const { crossDeviationSeries } = model();
  const series = crossDeviationSeries({ start: 60, end: 120, res_s: 60, series: [
    { lane: "a__spot", venue: "a", pair: "BTC-USDT", deviation_bps: [[60, 1.5], [120, -0.5]] },
    { lane: "b__spot", venue: "b", pair: "BTC-USDC", deviation_bps: [[120, 0.5]] },
  ] });
  assert.deepEqual(series[1].points, [{ time: 60000, value: null }, { time: 120000, value: 0.5 }]);
  assert.equal(series[0].label, "a BTC-USDT");
  assert.notEqual(series[0].color, series[1].color);
});

test("a bucket where no venue has a comparison breaks every line instead of joining its neighbours", () => {
  const { crossDeviationSeries } = model();
  const { projectTimeSeries } = frontendModules().load("features/quant-ops/kit/series");
  const series = crossDeviationSeries({ start: 60, end: 180, res_s: 60, series: [
    { lane: "a__spot", venue: "a", pair: "BTC-USDT", deviation_bps: [[60, 1], [180, 2]] },
    { lane: "b__spot", venue: "b", pair: "BTC-USDC", deviation_bps: [[60, -1], [180, -2]] },
  ] });
  assert.deepEqual(series[0].points.map(point => point.value), [1, null, 2]);
  const projection = projectTimeSeries(series);
  assert.ok(projection.rows.some(row => row[series[0].id] === null || row[series[0].id] === undefined), "gap row present");
});

test("times outside the Date range are unavailable, not a crash", () => {
  const { utcText, storeTiles } = model();
  assert.equal(utcText(9007199254740991), "Unavailable");
  const store = golden("store");
  assert.doesNotThrow(() => storeTiles({ ...store, status: { ...store.status, started_at: 9007199254740991 } }));
});

test("assets come from the owner config, else from instrument names with a derived label", () => {
  const { crossAssets } = model();
  assert.deepEqual(crossAssets({ config: { assets: ["BTC", "ETH"] } }, ["X-USDT"]), { assets: ["BTC", "ETH"], source: "config" });
  assert.deepEqual(crossAssets(null, ["ETH-USDT", "BTC-USDT", "BTC-USDC"]), { assets: ["BTC", "ETH"], source: "pairs" });
});

test("store tiles warn on a late heartbeat, mismatched formats and injected faults", () => {
  const { storeTiles } = model();
  const view = golden("store");
  const calm = Object.fromEntries(storeTiles(view).map(tile => [tile.id, tile]));
  assert.equal(calm.versions.value, "As expected");
  assert.equal(calm.heartbeat.tone, undefined);
  const late = Object.fromEntries(storeTiles({ ...view, status: { ...view.status, age_s: 45, fault_injections: 2 }, versions: { ...view.versions, mismatches: ["format: x"] } }).map(tile => [tile.id, tile]));
  assert.equal(late.heartbeat.tone, "warning");
  assert.equal(late.versions.value, "1 mismatch");
  assert.equal(late.faults.tone, "warning");
});

function renderPanel(name, data, props = {}) {
  const { load } = frontendModules({
    "@tanstack/react-query": { useQuery: options => {
      const key = options.queryKey[0];
      const value = data[key];
      const isError = value instanceof Error;
      return { isError, error: isError ? value : null, errorUpdatedAt: isError ? Date.parse("2026-10-24T06:00:30Z") : 0, isPending: value === undefined, data: isError ? undefined : value };
    } },
  });
  return renderToStaticMarkup(React.createElement(load("v5/CandleStorePanels")[name], props));
}

test("cross panel discloses mixed quotes and lists every venue's statistics", () => {
  const cross = golden("cross_spot_24h");
  const html = renderPanel("CrossVenuePanel", { "candle-store-facts": golden("store"), "candle-cross": cross }, { pairs: [] });
  assert.match(html, /Quotes differ \(USDC, USDT\)/);
  assert.match(html, /No conversion is applied/);
  for (const row of cross.table) assert.match(html, new RegExp(`${row.venue} ${row.pair} \\(${row.quote}\\)`));
  assert.match(html, /aria-label="Venues in the chart"/);
  assert.match(html, /Spot lanes only; spot and perpetual are never mixed/);
});

test("a failed cross read is one alert without stale statistics", () => {
  const html = renderPanel("CrossVenuePanel", { "candle-store-facts": golden("store"), "candle-cross": new Error("owner_compute_timeout") }, { pairs: [] });
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
  assert.match(html, /owner_compute_timeout/);
  assert.doesNotMatch(html, /Minutes compared/);
});

test("heatmap renders one inspectable strip per instrument with a text legend", () => {
  const heat = golden("heatmap_spot");
  const html = renderPanel("CoverageHeatmapPanel", { "candle-heatmap": heat });
  assert.equal((html.match(/aria-roledescription="timeline"/g) ?? []).length, heat.rows.length);
  assert.match(html, /Every settled minute held/);
  assert.match(html, /Outside the store window/);
  assert.match(html, /% settled/);
});

test("store facts show alerts for collector errors and no host path", () => {
  const store = golden("store");
  const html = renderPanel("StoreFactsPanel", { "candle-store-facts": { ...store, status: { ...store.status, fatal_error: "OSError (details withheld; read them on the owner host)" } } });
  assert.match(html, /role="alert"[^>]*>Collector fatal error: OSError \(details withheld; read them on the owner host\)/);
  assert.doesNotMatch(html, /\/tmp\/|\/home\//);
  assert.match(html, /Candle store lanes on disk/);
});

test("the candle store page offers four views and loads only the coverage reads by default", () => {
  const requests = [];
  const { load } = frontendModules({
    "@tanstack/react-query": {
      useQueryClient: () => ({ invalidateQueries() {} }),
      useQuery: options => { requests.push(options); return { isError: false, isPending: true, data: undefined, refetch() {} }; },
    },
    "@/components/charts/RecordedCandleChart": { RecordedCandleChart: () => null },
  });
  const html = renderToStaticMarkup(React.createElement(load("v5/V5CandleStore").V5CandleStore));
  assert.equal((html.match(/role="tab"/g) ?? []).length, 4);
  assert.match(html, /aria-selected="true"[^>]*>Lanes &amp; chart/);
  assert.deepEqual(requests.map(request => request.queryKey[0]).sort(), ["candle-chart", "candle-summary"]);
  assert.ok(requests.filter(request => request.queryKey[0] !== "candle-chart").every(request => request.enabled === true));
});

test("a warming owner is one readable alert, retried every 5 s, and shows no earlier values", () => {
  const requests = [];
  const warming = new Error("owner_warming");
  const { load } = frontendModules({
    "@tanstack/react-query": {
      useQueryClient: () => ({ invalidateQueries() {} }),
      useQuery: options => {
        requests.push(options);
        const failed = options.queryKey[0] === "candle-summary";
        return { isError: failed, error: failed ? warming : null, errorUpdatedAt: Date.parse("2026-11-03T12:00:00Z"), isPending: false, data: undefined, refetch() {} };
      },
    },
    "@/components/charts/RecordedCandleChart": { RecordedCandleChart: () => null },
  });
  const html = renderToStaticMarkup(React.createElement(load("v5/V5CandleStore").V5CandleStore));
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
  assert.match(html, /warming up after a restart; retrying every 5 s \(owner_warming\)/);
  assert.doesNotMatch(html, /Instrument coverage · evaluated/);
  const summary = requests.find(request => request.queryKey[0] === "candle-summary");
  assert.equal(summary.refetchInterval({ state: { error: warming } }), 5000);
  assert.equal(summary.refetchInterval({ state: { error: new Error("owner_unreachable") } }), 30000);
  assert.equal(summary.refetchInterval({ state: { error: null } }), 30000);
});
