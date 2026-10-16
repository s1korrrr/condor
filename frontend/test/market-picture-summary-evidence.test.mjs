import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules, memoryStorage } from "./helpers/frontend-module.mjs";
import * as model from "../src/features/market-picture/model.mjs";
import * as pulse from "../src/features/market-picture/pulse.mjs";
import * as contract from "../src/features/market-picture/contract.mjs";
import * as health from "../src/features/market-picture/health.mjs";

const START = Date.parse("2026-10-01T00:00:00Z");
const metric = (value, unit = "count") => ({ value, original: String(value), unit, status: "VALID", reasons: [], valid: 4, expected: 5, available: START + 2000, expires: START + 62_000, definition: "synthetic v1" });
const frame = {
  snapshot_id: "a".repeat(64), cutoff_ms: START, available_at_ms: START + 2000, expires_at_ms: START + 62_000,
  stream_id: "test-stream", epoch: "test-epoch", sequence: 1, payload_digest: "d".repeat(64),
  source_kind: "fixture", fixture_marker: "synthetic evidence test", universeId: "test-universe", universeRevision: "v1", membershipHash: "m", quote: "USD",
  valid: 4, expected: 5, comparisons: {}, comparisonContext: null, assets: [], distribution: {},
  summary: { market_participation: metric(0.5, "share_fraction"), trend_strength: metric(20),
    realized_volatility_24h: metric(0.5, "volatility_fraction_annualized"), relative_volume_1h: metric(1.2, "ratio"),
    new_highs_24h: metric(3), new_lows_24h: metric(2) },
};
const point = (minute, summary, gapBefore = false) => ({ time: START + minute * 60_000,
  snapshot_id: null, source_kind: "fixture", valid: 4, expected: 5, membership: "m", gapBefore, summary, breadth: {} });
const history = [point(-2, { market_participation: 0.25, new_highs_24h: 0, new_lows_24h: 0 }),
  point(-1, { market_participation: null, new_highs_24h: 3, new_lows_24h: null }),
  point(0, { market_participation: 0.5, new_highs_24h: 3, new_lows_24h: 2 }, true)];

const { load } = frontendModules({ "./model.mjs": model, "./pulse.mjs": pulse,
  react: { ...React, useMemo: callback => callback() },
}, { "features/market-picture/MarketPulse.tsx": ["MarketSnapshotTilesView"] });

function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== "object" || !node.props) return;
  yield node;
  yield* walk(node.props.children);
}

test("each visible summary tile opens its own evidence with the exact selected history", () => {
  const { MarketSnapshotTilesView } = load("features/market-picture/MarketPulse.tsx");
  const selected = [];
  const tree = MarketSnapshotTilesView({ frame, history, window: "24h", onInspect: (tile, samples) => selected.push({ tile, samples }) });
  const actions = [...walk(tree)].filter(node => node.type === "button" && node.props["aria-haspopup"] === "dialog");
  // Unqualified returns and source families are named in the availability line, not drawn as tiles.
  assert.equal(actions.length, 6, "every observation tile and coverage has an evidence action");
  for (const action of actions) action.props.onClick();
  assert.deepEqual(selected.map(v => v.tile.key), ["market_participation", "trend_strength", "realized_volatility_24h", "relative_volume_1h", "range_breaks", "coverage"]);
  assert.ok(selected.every(v => v.samples.length === 3 && v.samples.every((p, i) => p === history[i])));
  assert.deepEqual(selected[0].tile.points.map(p => p.value), [0.25, null, null, 0.5]);
  assert.deepEqual(selected[4].tile.points.map(p => p.value), [0, null, null, 1]);
  assert.match(renderToStaticMarkup(tree), /Inspect New highs \/ lows evidence/);
});

function selection(key, selectedFrame = frame, selectedHistory = history, window = "24h") {
  const { MarketSnapshotTilesView } = load("features/market-picture/MarketPulse.tsx");
  let selected;
  const tree = MarketSnapshotTilesView({ frame: selectedFrame, history: selectedHistory, window,
    onInspect: (tile, samples) => { if (tile.key === key) selected = { tile, samples, frame: selectedFrame, window }; } });
  for (const node of walk(tree)) if (node.type === "button" && node.props["aria-haspopup"] === "dialog") node.props.onClick();
  assert.ok(selected, `${key} is selectable`);
  return selected;
}
const evidence = selected => renderToStaticMarkup(React.createElement(load("features/market-picture/SummaryEvidence.tsx").SummaryEvidence, { selection: selected }));

test("range evidence retains the plotted zeros, missing counts and explicit gap row", () => {
  const html = evidence(selection("range_breaks"));
  const body = html.match(/<tbody>(.*?)<\/tbody>/s)[1];
  const rows = [...body.matchAll(/<tr(?:\s[^>]*)?>(.*?)<\/tr>/gs)].map(match => match[1]);
  assert.equal(rows.length, 4);
  assert.match(rows[0], /<td>0<\/td><td>0<\/td><td>0<\/td>/, "a genuine zero remains observed");
  assert.match(rows[1], /<td>Unavailable<\/td><td>3<\/td><td>Unavailable<\/td>/, "no fabricated net when the low count is missing");
  assert.match(rows[2], /Coverage gap before 2026-10-01T00:00:00.000Z/);
  assert.match(rows[2], /Unavailable · chart line interrupted/);
  assert.match(rows[3], /<td>1<\/td><td>3<\/td><td>2<\/td>/);
  assert.match(html, /Historical metric definitions, metric coverage, availability and expiry are not retained/);
  assert.match(html, /<th scope="col">Frame coverage<\/th>/);
  assert.match(html, /Not retained/, "absent history snapshot IDs remain explicit");
  assert.match(html, /New highs \(24h\) change<\/h4><p>Unavailable/);
});

test("metric evidence retains native precision, status and matched-comparison provenance", () => {
  const selectedFrame = structuredClone(frame);
  Object.assign(selectedFrame.summary.trend_strength, { value: 20.12345, original: "20.123450000", status: "PARTIAL", reasons: ["one_missing"], valid: 3 });
  selectedFrame.comparisons["summary/trend_strength"] = metric(0, "index_points");
  selectedFrame.comparisonContext = { interval: 3_600_000, baselineCutoff: START - 3_600_000, baselineSnapshotId: "b".repeat(64), common: 3, current: 4, baseline: 5, membership: "matched-members" };
  const html = evidence(selection("trend_strength", selectedFrame));
  assert.match(html, /20\.123450000 count/);
  assert.match(html, /PARTIAL · one_missing/);
  assert.match(html, /Metric coverage<\/dt><dd>3 \/ 5 instruments/);
  assert.match(html, /Frame coverage<\/dt><dd>4 \/ 5 instruments/);
  assert.match(html, /Stored value<\/dt><dd>0 index_points/);
  assert.match(html, /60 minutes/);
  assert.match(html, /2026-09-30T23:00:00.000Z/);
  assert.match(html, /3 common · 4 current · 5 baseline/);
  assert.match(html, /matched-members/);
  assert.match(html, new RegExp("b".repeat(64)));
  assert.match(html, /synthetic v1/);
});

test("coverage evidence shows recorded frame counts without inventing metric history or comparison", () => {
  const changed = history.map((point, index) => ({ ...point, valid: index + 1, expected: index + 2, membership: `cohort-${index}` }));
  const html = evidence(selection("coverage", frame, changed));
  assert.match(html, /Coverage · 3 retained observations/);
  assert.match(html, /<td>1 \/ 2<\/td>/);
  assert.match(html, /<td>3 \/ 4<\/td>/);
  assert.match(html, /cohort-2/);
  assert.match(html, /coverage gap before/);
  assert.doesNotMatch(html, /<th scope="col">Plotted value|Stored value|Metric coverage<\/dt>/);
  assert.match(html, /A change in coverage is unavailable/);
  const empty = evidence(selection("coverage", frame, []));
  assert.match(empty, /Unavailable · no retained history samples/);
  assert.doesNotMatch(empty, /<table/);
});

test("summary selection stays on the opened frame while the surface receives a newer frame", t => {
  const oldGlobals = { location: globalThis.location, localStorage: globalThis.localStorage };
  globalThis.location = { search: "", origin: "http://fixture.invalid", pathname: "/" };
  globalThis.localStorage = memoryStorage();
  t.after(() => Object.assign(globalThis, oldGlobals));
  let index = 0;
  const slots = [];
  const react = { ...React, useEffect: () => {}, useMemo: callback => callback(), useCallback: callback => callback,
    useRef: value => ({ current: value }), useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
      return [slots[slot], value => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }];
    } };
  const source = { data: { frame, history, events: [], correlations: [], faults: {}, eventCursor: null }, frozen: false, loading: false };
  const modules = frontendModules({ react, "./model.mjs": model, "./pulse.mjs": pulse, "./contract.mjs": contract, "./health.mjs": health,
    "@/lib/auth": {}, "@/hooks/useServer": {}, "@/lib/api": { api: {} }, "./source": {},
    "./useMarketPicture": { useMarketPicture: () => source },
  });
  const { MarketPictureSurface } = modules.load("features/market-picture/MarketPicture.tsx");
  const { MarketSnapshotTiles } = modules.load("features/market-picture/MarketPulse.tsx");
  const { SummaryEvidence } = modules.load("features/market-picture/SummaryEvidence.tsx");
  const { Drawer } = modules.load("features/market-picture/DetailViews.tsx");
  const render = () => { index = 0; return MarketPictureSurface({ server: "fixture", userId: "test", fixture: source.data }); };
  const find = (tree, type) => [...walk(tree)].find(node => node.type === type);
  const original = selection("range_breaks");
  find(render(), MarketSnapshotTiles).props.onInspect(original.tile, original.samples);
  assert.equal(find(render(), SummaryEvidence).props.selection.frame, frame);
  const nextFrame = { ...frame, snapshot_id: "c".repeat(64), cutoff_ms: START + 60_000, universeRevision: "v2", membershipHash: "new-members", sequence: 2,
    summary: { ...frame.summary, new_highs_24h: metric(5), new_lows_24h: metric(0) } };
  source.data = { ...source.data, frame: nextFrame, history: [] };
  const updated = render();
  assert.equal(find(updated, MarketSnapshotTiles).props.frame, nextFrame, "overview receives the new frame");
  const retained = find(updated, SummaryEvidence).props.selection;
  assert.equal(retained.frame, frame, "drawer retains its selected immutable frame");
  assert.equal(retained.samples, original.samples);
  assert.equal(retained.tile.value, "3 / 2");
  assert.equal(retained.window, "24h");
  find(updated, Drawer).props.close();
  assert.equal(find(render(), SummaryEvidence), undefined);
  const next = selection("range_breaks", nextFrame, []);
  find(render(), MarketSnapshotTiles).props.onInspect(next.tile, next.samples);
  assert.equal(find(render(), SummaryEvidence).props.selection.frame, nextFrame);
  assert.equal(find(render(), SummaryEvidence).props.selection.tile.value, "5 / 0");
});
