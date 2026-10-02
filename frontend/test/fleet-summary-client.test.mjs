import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const client = load('lib/fleet-summary.ts');
const example = view => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/fleet_summary/summary_${view}.example.json`, import.meta.url), 'utf8'));

test('the server\'s documented full and glance examples satisfy the typed client', () => {
  const full = client.parseFleetSummary(example('full'), 'full');
  assert.equal(full.schema_version, 'fleet-summary.v1');
  assert.equal(full.pnl.day.total, '4.5');
  assert.equal(full.wallet.equity, '1000');
  assert.equal(full.market.verdict.state, 'mixed');
  assert.equal(full.bots.find(bot => bot.bot === 'ok_rsi').generation, 'V1');
  const glance = client.parseFleetSummary(example('glance'), 'glance');
  assert.equal(glance.view, 'glance');
  assert.equal(glance.bots_total, 3);
  assert.ok(new TextEncoder().encode(JSON.stringify(example('glance'))).length < 8192);
});

test('a different major schema or view is refused, never guessed', () => {
  assert.throws(() => client.parseFleetSummary({ ...example('full'), schema_version: 'fleet-summary.v2' }, 'full'), /Unsupported fleet summary schema/);
  assert.throws(() => client.parseFleetSummary(example('glance'), 'full'), /does not match/);
  assert.throws(() => client.parseFleetSummary(null, 'full'), /not an object/);
});

test('extra fields are ignored (v1 only adds) but a wrong headline type is rejected', () => {
  const extra = { ...example('full'), new_in_v1_1: { anything: true } };
  assert.equal(client.parseFleetSummary(extra, 'full').server, 'v2');
  const bad = structuredClone(example('full'));
  bad.pnl.day.total = 4.5;
  assert.throws(() => client.parseFleetSummary(bad, 'full'), /PnL window day/);
  const noWallet = structuredClone(example('full'));
  noWallet.wallet.equity = 'NaN';
  assert.throws(() => client.parseFleetSummary(noWallet, 'full'), /wallet/);
  const badSection = structuredClone(example('full'));
  badSection.sections.market.status = 'great';
  assert.throws(() => client.parseFleetSummary(badSection, 'full'), /sections/);
});

test('null sections stay null: absent data is not turned into a value', () => {
  const body = structuredClone(example('full'));
  body.wallet = null; body.market = null; body.fills = null; body.incidents = null;
  body.sections.wallet = { status: 'missing', observed_at_ms: null, stale_after_ms: 120000, reason: 'NO_SAMPLES' };
  const parsed = client.parseFleetSummary(body, 'full');
  assert.equal(parsed.wallet, null);
  assert.equal(parsed.market, null);
  assert.equal(client.sectionAgeMs(parsed.sections.wallet, 1_800_000_030_000), null);
});

test('section age and staleness are computed by the client from observed_at_ms', () => {
  const full = example('full');
  const now = full.generated_at_ms;
  assert.equal(client.sectionAgeMs(full.sections.wallet, now), 30_000);
  assert.equal(client.sectionIsStale(full.sections.wallet, now), false);
  assert.equal(client.sectionIsStale(full.sections.wallet, now + 200_000), true, 'older than its own stale_after_ms');
  assert.equal(client.sectionIsStale(full.sections.bots, now), true, 'the server flagged it');
});

test('request path encodes the server and selects the view', () => {
  assert.equal(client.fleetSummaryPath('my server'), '/api/v1/servers/my%20server/fleet/summary');
  assert.equal(client.fleetSummaryPath('v2', 'glance'), '/api/v1/servers/v2/fleet/summary?view=glance');
});
