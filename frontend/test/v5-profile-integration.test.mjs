import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateV5ReadRequest } from "../src/v5/transport-policy.mjs";

test("V5 read bridge accepts only same-origin safe V1 GET paths", () => {
  assert.equal(validateV5ReadRequest("/api/v1/servers/rsibot-v5/status?fresh=1", "GET", false, "https://v5.example"), "/api/v1/servers/rsibot-v5/status?fresh=1");
  for (const [path, method, body] of [
    ["https://old-stack.example/api/v1/servers", "GET", false],
    ["//old-stack.example/api/v1/servers", "GET", false],
    ["/api/v1/servers/../portfolio", "GET", false],
    ["/api/v1/servers/%2e%2e/portfolio", "GET", false],
    ["/api/v1/servers/rsibot-v5/bots/command", "POST", true],
    ["/api/v1/auth/token-login", "GET", false],
  ]) assert.throws(() => validateV5ReadRequest(path, method, body, "https://v5.example"));
});

test("V5 entry reuses the actual dashboard pages under an isolated cookie profile", async () => {
  const app = await readFile(new URL("../src/v5/V5App.tsx", import.meta.url), "utf8");
  const config = await readFile(new URL("../vite.v5.config.ts", import.meta.url), "utf8");
  const auth = await readFile(new URL("../src/v5/auth-token.ts", import.meta.url), "utf8");
  for (const route of ["/capital", "/bots", "/operations", "/research", "/backtests"]) assert.match(app, new RegExp(`path=\\"${route.replaceAll("/", "\\/")}\\"`));
  for (const component of ["@/pages/Bots", "@/pages/Research", "@workspace-monitoring"]) assert.ok(app.includes(component));
  const market = await readFile(new URL("../src/v5/V5MarketHome.tsx", import.meta.url), "utf8");
  assert.match(market, /@\/features\/market-picture\/MarketPicture/);
  assert.match(market, /location\.pathname === "\/"/);
  assert.ok(market.indexOf("V5 multi-venue context") < market.indexOf("Condor Market Picture"));
  const pages = await readFile(new URL("../src/v5/V5Pages.tsx", import.meta.url), "utf8");
  assert.match(pages, /latest_by_task/);
  assert.match(pages, /result\.actual_usd/);
  assert.match(pages, /result\.expires_at_ms/);
  assert.match(pages, /last_success_at_ms/);
  assert.match(pages, /remaining_pilot_usd/);
  assert.match(pages, /authorized_ceiling_usd/);
  assert.match(pages, /Provider billing balance/);
  assert.match(pages, /secrets\/anthropic\.env/);
  assert.match(config, /@workspace-monitoring/);
  assert.match(config, /V5_WORKSPACE_ROOT/);
  assert.match(auth, /credentials:\s*"include"/);
  assert.doesNotMatch(auth, /localStorage/);
  assert.match(auth, /headers\.delete\("Authorization"\)/);
});
