import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";
import * as model from "../src/features/market-picture/model.mjs";

// The real component's state persists between explicit renders, following the
// existing component-test convention. Browser evidence verifies native events.
function heatmap() {
  const slots = [];
  let index = 0;
  const { load } = frontendModules({
    "./model.mjs": model,
    react: { ...React, useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
      return [slots[slot], value => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }];
    } },
  }, { "features/market-picture/OverviewPanels.tsx": ["MarketHeatmapPanelView"] });
  const { MarketHeatmapPanelView } = load("features/market-picture/OverviewPanels.tsx");
  return props => { index = 0; return MarketHeatmapPanelView(props); };
}

function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== "object" || !node.props) return;
  yield node;
  yield* walk(node.props.children);
}

const asset = (symbol, value, sector = "Test sector") => ({
  instrument_id: `TEST:${symbol}-USD`, symbol, sector, weight: 1,
  returns: { "1440": { value, unit: "return_percent", status: value === null ? "UNAVAILABLE" : "VALID" } },
});
const propsFor = assets => ({
  frame: { expected: assets.length, assets }, selected: null, select: () => {},
  cohort: new Set(), sector: "Test sector", setSector: () => {},
});

test("heatmap distinguishes missing qualified returns from an empty sector", () => {
  const render = heatmap();
  const props = propsFor([asset("AAA", null), asset("BBB", null), asset("CCC", 2, "Other sector")]);
  const unavailable = renderToStaticMarkup(render(props));
  assert.match(unavailable, /2 \/ 3 symbols/);
  assert.match(unavailable, /No qualified 24h returns in this sector/);
  assert.doesNotMatch(unavailable, /No assets in this sector/);
  const empty = renderToStaticMarkup(render({ ...props, sector: "Absent sector" }));
  assert.match(empty, /0 \/ 3 symbols/);
  assert.match(empty, /No assets in this sector/);
  assert.doesNotMatch(empty, /No qualified 24h returns/);
});

test("heatmap list keeps unavailable members selectable and preserves mixed coverage", () => {
  const render = heatmap();
  const selected = [];
  const props = { ...propsFor([asset("AAA", null), asset("BBB", null), asset("CCC", 2, "Other sector")]),
    select: id => selected.push(id) };
  let tree = render(props);
  assert.equal(tree.props.actions.props.children, "Accessible list");
  tree.props.actions.props.onClick();
  tree = render(props);
  assert.equal(tree.props.actions.props["aria-pressed"], true);
  const memberButtons = () => [...walk(tree)].filter(node => node.type === "button" &&
    React.Children.toArray(node.props.children).some(child => child.type === "strong"));
  assert.equal(memberButtons().length, 2);
  const list = renderToStaticMarkup(tree);
  assert.match(list, /<strong>AAA<\/strong><span>—<\/span>/);
  assert.match(list, /<strong>BBB<\/strong><span>—<\/span>/);
  assert.doesNotMatch(list, /<strong>CCC<\/strong>|No assets in this sector/);
  memberButtons()[1].props.onClick();
  assert.deepEqual(selected, ["TEST:BBB-USD"]);
  tree = render({ ...props, selected: selected[0], frame: { ...props.frame,
    assets: [asset("AAA", 2), asset("BBB", null), asset("CCC", 2, "Other sector")] } });
  assert.equal(memberButtons().length, 2);
  assert.equal(memberButtons()[1].props["aria-pressed"], true);
  assert.match(renderToStaticMarkup(tree), /<strong>AAA<\/strong><span>\+2\.00%<\/span>/);
  tree.props.actions.props.onClick();
  const tiles = renderToStaticMarkup(render(props));
  assert.match(tiles, /No qualified 24h returns in this sector/);
});
