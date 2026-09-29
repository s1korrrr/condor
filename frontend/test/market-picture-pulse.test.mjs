import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(
  new URL("../src/features/market-picture/MarketPulse.tsx", import.meta.url),
  "utf8",
);
const parsed = ts.createSourceFile("MarketPulse.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const functionNode = parsed.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "coverageChangePoints",
);
assert.ok(functionNode, "the pulse must expose its coverage marker decision");
const compiled = ts.transpileModule(functionNode.getText(parsed), {
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
