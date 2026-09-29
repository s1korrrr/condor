import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceResultBars,
  comparisonGroups,
  metricsReceiptReadout,
} from "../src/features/research/results.ts";
test("historical quote metrics retain source values and never invent missing results", () => {
  assert.deepEqual(
    sourceResultBars({
      net_pnl_quote: 432.93,
      fees_quote: 29.99,
      max_drawdown_usd: -122.58,
    }).map((x) => [x.key, x.value]),
    [
      ["net_pnl_quote", 432.93],
      ["fees_quote", 29.99],
    ],
  );
  assert.deepEqual(
    sourceResultBars({ net_pnl_quote: "12", fees_quote: null }),
    [],
  );
  assert.equal(sourceResultBars({ net_pnl_quote: 0 })[0].value, 0);
});
test("captured metrics receipts render complete finite statistics and preserve zero", () => {
  const receipt = metricsReceiptReadout({
    metrics_state: "CAPTURED",
    pair: "ETH-USDC",
    net_pnl_quote: 0,
    return_fraction: 0,
    max_drawdown_quote: 0,
    max_drawdown_over_initial_cash: 0,
    initial_cash_quote: 500,
    trades: 0,
    window_start_utc: "2026-05-01T00:00:00Z",
    window_end_utc: "2026-09-01T00:00:00Z",
    reason: "ignored on captured receipts",
  });
  assert.equal(receipt.state, "CAPTURED");
  assert.equal(receipt.values.net_pnl_quote, "0 quote");
  assert.equal(receipt.values.return_fraction, "0%");
  assert.equal(receipt.values.max_drawdown_quote, "0 quote");
  assert.equal(receipt.values.max_drawdown_over_initial_cash, "0%");
  assert.equal(receipt.values.trades, "0");
  assert.equal(receipt.values.initial_cash_quote, "500 quote");
  assert.match(receipt.values.window, /end exclusive/);
  assert.equal(receipt.reason, null);
});
test("captured receipts with missing, nonfinite, or invalid counts hide all metrics", () => {
  const base = {
    metrics_state: "CAPTURED",
    pair: "ETH-USDC",
    net_pnl_quote: 1,
    return_fraction: 0.1,
    max_drawdown_quote: -2,
    max_drawdown_over_initial_cash: 0.02,
    initial_cash_quote: 100,
    trades: 2,
    window_start_utc: "2026-05-01T00:00:00Z",
    window_end_utc: "2026-09-01T00:00:00Z",
  };
  for (const changed of [
    { net_pnl_quote: Number.NaN },
    { trades: 1.5 },
    { pair: "" },
    { window_end_utc: "not-a-date" },
    { max_drawdown_over_initial_cash: undefined },
  ]) {
    const receipt = metricsReceiptReadout({ ...base, ...changed });
    assert.equal(receipt.state, "RECEIPT_INVALID");
    assert.deepEqual(receipt.values, {});
    assert.match(receipt.reason, /hidden/);
  }
});
test("unavailable and unknown receipts never expose stray metric fields", () => {
  for (const state of ["UNAVAILABLE", "RECEIPT_INVALID", "FUTURES_RESULT"]) {
    const receipt = metricsReceiptReadout({
      metrics_state: state,
      reason: "source result was not recognized",
      net_pnl_quote: 999,
      trades: 44,
    });
    assert.equal(receipt.state, state);
    assert.equal(receipt.reason, "source result was not recognized");
    assert.deepEqual(receipt.values, {});
  }
  const missing = metricsReceiptReadout({ net_pnl_quote: 1 });
  assert.equal(missing.state, "UNAVAILABLE");
  assert.equal(missing.reason, "Reason not recorded");
  assert.deepEqual(missing.values, {});
});
test("metrics nodes do not enter the legacy result chart, even with stray numbers", () => {
  assert.deepEqual(
    sourceResultBars(
      { metrics_state: "UNAVAILABLE", net_pnl_quote: 500, fees_quote: 0 },
      "metrics",
    ),
    [],
  );
  assert.deepEqual(
    sourceResultBars({ metrics_state: "CAPTURED", net_pnl_quote: 10 }, "metrics"),
    [],
  );
  assert.equal(sourceResultBars({ net_pnl_quote: 10 }, "run").length, 1);
});
test("comparisons remain separated by explicit contract and unit", () => {
  const item = {
    label: "c1",
    value: 10,
    unit: "USDC",
    metric: "net_pnl",
    baseline: "b",
    comparable_group: "g",
    validity: "VALID",
    attribution: "ISOLATED",
    source_refs: ["evidence"],
  };
  const groups = comparisonGroups([
    item,
    { ...item, unit: "percent" },
    { ...item, comparable_group: "h" },
    { ...item, value: NaN },
    { ...item, source_refs: [] },
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups.flatMap((x) => x.items).length, 3);
});

test("comparison displays retain capital contracts and evidence identities", () => {
  const base = {
    id: "assessment:one",
    label: "c1",
    value: 10,
    unit: "USDC",
    metric: "net_pnl",
    baseline: "b",
    comparable_group: "g",
    validity: "VALID",
    attribution: "ISOLATED",
    source_refs: ["evidence:one"],
  };
  const groups = comparisonGroups([
    { ...base, conditions: { capital_model: "SPOT_1X", window: "May-August" } },
    {
      ...base,
      id: "assessment:two",
      comparable_group: "h",
      conditions: { capital_model: "FUTURES_3X" },
    },
  ]);
  assert.equal(groups[0].contract, "g");
  assert.equal(groups[0].conditions.capital_model, "SPOT_1X");
  assert.equal(groups[1].conditions.capital_model, "FUTURES_3X");
  assert.deepEqual(groups[0].items[0].sourceRefs, ["evidence:one"]);
  assert.equal(groups[0].items[0].id, "assessment:one");
});
