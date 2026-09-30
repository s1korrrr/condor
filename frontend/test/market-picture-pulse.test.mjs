import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { marketPulseWindow } from "../src/features/market-picture/model.mjs";

const source = fs.readFileSync(
  new URL("../src/features/market-picture/MarketPulse.tsx", import.meta.url),
  "utf8",
);
const parsed = ts.createSourceFile("MarketPulse.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const functions = parsed.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "coverageChangePoints",
);
assert.equal(functions.length, 1, "the pulse must expose its coverage marker decision");
const compiled = ts.transpileModule(functions.map((node) => node.getText(parsed)).join("\n"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { coverageChangePoints } = await import(
  `data:text/javascript,${encodeURIComponent(`${compiled}\nexport { coverageChangePoints };`)}`,
);

test("pulse marks every change in valid count, expected count, or membership", () => {
  const history = [
    { time: 1, membership: "same", valid: 220, expected: 240 },
    { time: 2, membership: "same", valid: 180, expected: 240 },
    { time: 3, membership: "same", valid: 180, expected: 240 },
    { time: 4, membership: "same", valid: 180, expected: 250 },
    { time: 5, membership: "changed", valid: 180, expected: 250 },
  ];
  assert.deepEqual(coverageChangePoints(history).map((point) => point.time), [2, 4, 5]);
});

test("pulse labels requested coverage and filters only to the selected window", () => {
  const history = [0, 8, 16].map((hours) => ({ time: Date.parse("2026-09-30T00:00:00Z") + hours * 3600000 }));
  const result = marketPulseWindow(history, "7d");
  assert.equal(result.samples.length, 3);
  assert.equal(result.label, "Requested 7d · available 16h");
  const short = marketPulseWindow(history, "6h");
  assert.equal(short.samples.length, 1);
  assert.equal(short.label, "Requested 6h · available 0h");
  assert.equal(marketPulseWindow(history.slice(2), "24h").label, "Requested 24h · available 0h");
});
