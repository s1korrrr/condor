import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";

const checkedAt = Date.parse("2026-10-29T10:20:30Z");
const row = (lane, pair) => ({ lane, pair, venue: lane.split("__")[0], segment: lane.split("__")[1], health: "green", health_rules: [], last_minute: checkedAt / 1000 - 90, last_minute_age_s: 30, grace_s: 600, volume_unit: "base", coverage_1h: 1, coverage_24h: 1, coverage_7d: 1, gaps_7d: 0, pending: 1, unrecoverable_7d: 0, no_trade_7d: 0, ws_state: "connected" });

function render(rows, failed = []) {
  const requests = [];
  const { load } = frontendModules({
    "@tanstack/react-query": { useQuery: options => {
      const view = options.queryKey[0];
      requests.push(options);
      const isError = failed.includes(view);
      return { isError, error: isError ? new Error("owner_unreachable") : null, errorUpdatedAt: isError ? checkedAt : 0, isPending: false, refetch() {}, data: view === "candle-overview" ? { now: checkedAt / 1000, tiles: [], status_age_s: 2, status_error: null } : view === "candle-symbols" ? { now: checkedAt / 1000, rows } : undefined };
    } },
    "@/components/charts/RecordedCandleChart": { RecordedCandleChart: () => null },
  });
  return { html: renderToStaticMarkup(React.createElement(load("v5/V5CandleStore").V5CandleStore)), requests };
}

test("owner outage is one timestamped alert with no empty chart selectors", () => {
  const { html } = render([], ["candle-overview", "candle-symbols"]);
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
  assert.match(html, /2026-10-29 10:20:30 UTC/);
  assert.match(html, /owner_unreachable/);
  assert.doesNotMatch(html, /<select/);
});

test("V5 defaults to held OKX spot BTC-USDT and discloses missing USDC coverage", () => {
  const { html, requests } = render([row("hyperliquid__spot", "UBTC-USDC"), row("okx__perpetual", "BTC-USDC"), row("okx__spot", "BTC-USDT")]);
  assert.deepEqual(requests.find(request => request.queryKey[0] === "candle-chart").queryKey.slice(1, 3), ["okx__spot", "BTC-USDT"]);
  assert.match(html, /V5 trades OKX spot/);
  assert.match(html, /V5 pairs not held: BNB-USDC, BTC-USDC, ETH-USDC, SOL-USDC, XRP-USDC/);
  assert.match(html, /no conversion is applied/);
});

test("held BTC-USDC takes priority without borrowing another lane's coverage", () => {
  const { html, requests } = render([row("okx__spot", "BTC-USDT"), row("okx__spot", "BTC-USDC")]);
  assert.equal(requests.find(request => request.queryKey[0] === "candle-chart").queryKey[2], "BTC-USDC");
  assert.match(html, /V5 pairs not held: BNB-USDC, ETH-USDC, SOL-USDC, XRP-USDC/);
});

test("listed but unheld USDC is not presented as recorded coverage", () => {
  const { html, requests } = render([{ ...row("okx__spot", "BTC-USDC"), last_minute: null }, row("okx__spot", "BTC-USDT")]);
  assert.equal(requests.find(request => request.queryKey[0] === "candle-chart").queryKey[2], "BTC-USDT");
  assert.match(html, /V5 pairs not held: BNB-USDC, BTC-USDC/);
});

test("default coverage table fits the 1440px content area and retains resize handles", () => {
  const { html } = render([row("okx__spot", "BTC-USDT")]);
  const width = Number(html.match(/<table[^>]*style="width:max\(100%, (\d+)px\)/)?.[1]);
  assert.ok(width > 0 && width <= 1386, `table width ${width}`);
  assert.equal((html.match(/role="separator"/g) ?? []).length, 15);
});

test("a chart-only failure keeps valid selectors and uses the same single alert", () => {
  const { html } = render([row("okx__spot", "BTC-USDT")], ["candle-chart"]);
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
  assert.equal((html.match(/<select/g) ?? []).length, 2);
  assert.match(html, /candles: owner_unreachable/);
});

test("an empty successful instrument list has an explicit reason, not an empty dropdown", () => {
  const { html } = render([]);
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /Chart selection unavailable until the owner instrument list is available and non-empty/);
});

test("recorded candle time scale keeps the left boundary label inside the chart", () => {
  let options;
  let fitted = false;
  const { load } = frontendModules({
    react: { useRef: () => ({ current: {} }), useState: () => [null, () => {}], useEffect: effect => effect() },
    "@/hooks/useTheme": { useTheme: () => ({ theme: "dark" }) },
    "@/lib/theme-colors": { getThemeColors: () => ({}) },
    "lightweight-charts": { ColorType: { Solid: "solid" }, CandlestickSeries: {}, createChart: (_container, config) => {
      options = config;
      return { addSeries: () => ({ setData() {} }), subscribeCrosshairMove() {}, timeScale: () => ({ fitContent() { fitted = true; } }), remove() {} };
    } },
  });
  renderToStaticMarkup(React.createElement(load("components/charts/RecordedCandleChart").RecordedCandleChart, { buckets: [], label: "okx · spot · BTC-USDT", volumeUnit: "base" }));
  assert.equal(options.timeScale.fixLeftEdge, true);
  assert.equal(fitted, true);
});
