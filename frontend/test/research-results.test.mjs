import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceResultBars,
  comparisonGroups,
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
