import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tradeMarkers } from "../src/v5/bots-chart-model.mjs";
import { frontendModules } from "./helpers/frontend-module.mjs";

const start = Date.parse("2026-11-16T10:20:00Z") / 1000;
const end = start + 120;
const buckets = [
  [start, 100, 110, 90, 105, 1, 1, 0, 0, 0, 0, 0],
  [start + 60, null, null, null, null, null, 0, 0, 0, 1, 0, 0],
  [end, 105, 115, 95, 110, 1, 1, 0, 0, 0, 0, 0],
];
const fill = (overrides = {}) => ({ trading_pair: "BNB-USDC", side: "BUY", event_at_ms: start * 1000 + 12345, price: "101.123456789012345678900", quantity: "0.100000000000000000001", ...overrides });

function renderFills(fills, snapshotDimmed = false) {
  let markers;
  let chartOptions;
  const mapped = tradeMarkers(fills, "BNB-USDC", start, end, buckets);
  const { load } = frontendModules({
    react: { useRef: () => ({ current: {} }), useState: () => [null, () => {}], useEffect: effect => effect() },
    "@/hooks/useTheme": { useTheme: () => ({ theme: "dark" }) },
    "@/lib/theme-colors": { getThemeColors: () => ({ up: "green", down: "red", text: "white" }) },
    "lightweight-charts": {
      ColorType: { Solid: "solid" }, CandlestickSeries: {},
      createSeriesMarkers: (_series, value) => { markers = value; },
      createChart: (_container, options) => {
        chartOptions = options;
        return { addSeries: () => ({ setData() {} }), subscribeCrosshairMove() {}, timeScale: () => ({ fitContent() {} }), remove() {} };
      },
    },
  });
  const html = renderToStaticMarkup(React.createElement(load("components/charts/RecordedCandleChart").RecordedCandleChart, { buckets, label: "BNB", volumeUnit: "base", markers: mapped.markers, snapshotDimmed }));
  return { markers, title: html.match(/title="([^"]*)"/)?.[1], mapped, chartOptions };
}

for (const [side, position, shape, color] of [["BUY", "atPriceBottom", "arrowUp", "green"], ["SELL", "atPriceTop", "arrowDown", "red"]]) {
  test(`${side} arrow uses the fill price on its containing minute`, () => {
    const owner = fill({ side });
    const { markers, chartOptions } = renderFills([owner]);
    assert.equal(markers.length, 1);
    assert.deepEqual({ position: markers[0].position, price: markers[0].price, shape: markers[0].shape, time: markers[0].time, color: markers[0].color }, { position, price: Number(owner.price), shape, time: start, color });
    assert.equal(chartOptions.timeScale.secondsVisible, false);
  });
}

for (const invalid of ["NaN", "Infinity", "-Infinity", NaN, Infinity, "0", 0, "-1", "", null, undefined]) {
  test(`invalid fill price ${String(invalid)} (${typeof invalid}) draws no marker`, () => {
    assert.deepEqual(renderFills([fill({ price: invalid })]).markers, []);
  });
}

for (const [side, eventAt, exactTime] of [["BUY", start * 1000 + 12345, "2026-11-16T10:20:12.345Z"], ["SELL", end * 1000 + 59000, "2026-11-16T10:22:59.000Z"]]) {
  test(`${side} label and hover title preserve exact UTC fill time, quantity and price`, () => {
    const owner = fill({ side, event_at_ms: eventAt });
    const { markers, title, mapped } = renderFills([owner]);
    const expected = `${side} ${owner.quantity} @ ${owner.price} · ${exactTime}`;
    assert.equal(markers[0].text, expected);
    assert.equal(title, expected);
    assert.equal(mapped.markers[0].event_at_ms, eventAt);
    assert.equal(owner.price, "101.123456789012345678900");
  });
}

test("gap minutes never snap to a neighboring candle and window bounds exclude outside fills", () => {
  const retained = fill({ side: "SELL", event_at_ms: (end + 60) * 1000 - 1 });
  const { markers, mapped } = renderFills([
    fill({ event_at_ms: start * 1000 - 1 }),
    fill({ event_at_ms: (start + 60) * 1000 + 12345 }),
    retained,
    fill({ event_at_ms: (end + 60) * 1000 }),
    fill({ trading_pair: "BTC-USDC" }),
  ]);
  assert.equal(mapped.entries, 1);
  assert.equal(mapped.exits, 1);
  assert.deepEqual(markers.map(marker => marker.time), [end]);
  assert.equal(markers[0].text, `SELL ${retained.quantity} @ ${retained.price} · 2026-11-16T10:22:59.999Z`);
});

test("dimmed BUY and SELL markers retain grey at their fill price", () => {
  const { markers } = renderFills([fill(), fill({ side: "SELL" })], true);
  assert.deepEqual(markers.map(marker => ({ color: marker.color, price: marker.price })), [
    { color: "rgba(128, 128, 128, 0.55)", price: 101.12345678901235 },
    { color: "rgba(128, 128, 128, 0.55)", price: 101.12345678901235 },
  ]);
});
