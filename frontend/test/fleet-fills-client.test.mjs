import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const client = load('lib/fleet-fills.ts');
// The server's own example documents: real builder output, kept current by condor/tests/test_fleet_fills.py.
const example = name => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/fleet_fills/${name}.example.json`, import.meta.url), 'utf8'));

test('the server\'s documented example pages satisfy the typed client', () => {
  const first = client.parseFleetFills(example('page_first'));
  assert.equal(first.schema_version, 'fleet-fills.v1');
  assert.equal(first.status, 'ok');
  assert.equal(first.partial, false);
  assert.equal(first.items.length, 4);
  assert.equal(first.matched, 7);
  assert.equal(first.has_more, true);
  assert.equal(typeof first.next_cursor, 'string');
  assert.deepEqual(first.bots.map(bot => bot.generation), ['V1', 'V2', 'V3']);
  const top = first.items[0];
  assert.equal(top.id, 'meridian_v3|db-v3|v3-1');
  assert.equal(top.amount, '1.5', 'money stays a decimal string');
  assert.equal(top.realized_pnl, null, 'realized_pnl is reserved: null, never zero');
  assert.equal(top.receipt, 'exact');
  const second = client.parseFleetFills(example('page_second'));
  assert.equal(second.has_more, false);
  assert.equal(second.next_cursor, null);
  const filtered = client.parseFleetFills(example('page_filtered'));
  assert.equal(filtered.bots.length, 1, 'bots[] describes the selected bots only');
  const partial = client.parseFleetFills(example('page_partial'));
  assert.equal(partial.status, 'partial');
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.bots.filter(bot => bot.status === 'unavailable').map(bot => [bot.bot, bot.reason]), [['meridian_v3', 'SOURCE_UNAVAILABLE']]);
});

test('V1 legacy rows keep their label and are not promoted to exact receipts', () => {
  const rows = client.parseFleetFills(example('page_first')).items.concat(client.parseFleetFills(example('page_second')).items);
  const v1 = rows.filter(row => row.generation === 'V1');
  assert.ok(v1.length > 0);
  assert.ok(v1.every(row => row.receipt === 'legacy_6dp'));
  assert.ok(rows.filter(row => row.generation !== 'V1').every(row => row.receipt === 'exact'));
});

test('a different schema is refused explicitly, never guessed', () => {
  assert.throws(() => client.parseFleetFills({ ...example('page_first'), schema_version: 'fleet-fills.v2' }), /Unsupported fleet fills schema fleet-fills\.v2: update the dashboard/);
  assert.throws(() => client.parseFleetFills({ ...example('page_first'), schema_version: undefined }), /Unsupported fleet fills schema undefined/);
  assert.throws(() => client.parseFleetFills(null), /not an object/);
  assert.throws(() => client.parseFleetFills([]), /not an object/);
});

test('extra fields are ignored (v1 only adds) and unknown enums fall back without inventing a value', () => {
  const body = structuredClone(example('page_first'));
  body.new_in_v1_1 = { anything: true };
  body.items[0].new_field = 1;
  body.items[0].generation = 'V9';
  body.items[0].receipt = 'quantum';
  body.items[1].side = 'hold';
  body.bots[0].status = 'degraded';
  const page = client.parseFleetFills(body);
  assert.equal(page.items[0].generation, null, 'an unknown generation is not guessed');
  assert.equal(page.items[0].receipt, 'unrecognised', 'an unknown receipt is not promoted to exact');
  assert.equal(page.items[1].side, null);
  assert.equal(page.bots[0].status, 'unavailable', 'an unknown bot status never reads as ok');
  assert.match(page.bots[0].reason, /UNRECOGNISED_STATUS:degraded/);
  const future = client.parseFleetFills({ ...example('page_first'), status: 'degraded' });
  assert.equal(future.status, 'partial', 'an unknown overall status never claims every bot answered');
  assert.equal(future.partial, true);
});

test('null money stays null and a non-decimal money value is rejected, never coerced to 0', () => {
  const body = structuredClone(example('page_first'));
  body.items[0].fee = null; body.items[0].fee_unit = null; body.items[0].time_ms = null; body.items[0].missing = ['fee', 'time_ms'];
  const parsed = client.parseFleetFills(body).items[0];
  assert.equal(parsed.fee, null);
  assert.equal(parsed.time_ms, null);
  assert.deepEqual(parsed.missing, ['fee', 'time_ms']);
  for (const [field, value] of [['amount', 1.5], ['price', 'NaN'], ['volume', '1e3'], ['fee', '0.1 USDC'], ['realized_pnl', 0]]) {
    const bad = structuredClone(example('page_first'));
    bad.items[0][field] = value;
    assert.throws(() => client.parseFleetFills(bad), new RegExp(`invalid ${field}`), `${field}=${String(value)}`);
  }
  const noTime = structuredClone(example('page_first'));
  noTime.items[0].time_ms = '1799999995000';
  assert.throws(() => client.parseFleetFills(noTime), /invalid time/);
});

test('a malformed envelope is rejected', () => {
  const missingIdentity = structuredClone(example('page_first'));
  delete missingIdentity.items[0].id;
  assert.throws(() => client.parseFleetFills(missingIdentity), /no identity/);
  const noCursor = { ...structuredClone(example('page_first')), next_cursor: null };
  assert.throws(() => client.parseFleetFills(noCursor), /gives no cursor/);
  assert.throws(() => client.parseFleetFills({ ...example('page_first'), window: { truncated: 'yes' } }), /window/);
  assert.throws(() => client.parseFleetFills({ ...example('page_first'), items: {} }), /items or bots/);
  assert.throws(() => client.parseFleetFills({ ...example('page_first'), matched: '7' }), /paging/);
});

test('request path encodes the server, repeats bot and leaves empty filters out', () => {
  assert.equal(client.fleetFillsPath('my server'), '/api/v1/servers/my%20server/fleet/fills');
  assert.equal(client.fleetFillsPath('v2', { limit: 50 }), '/api/v1/servers/v2/fleet/fills?limit=50');
  const path = client.fleetFillsPath('v2', { limit: 25, before: 'abc_-', bots: ['ok_rsi', 'meridian_v3'], side: 'buy', pair: ' BNB-USDC ' });
  assert.equal(path, '/api/v1/servers/v2/fleet/fills?limit=25&before=abc_-&bot=ok_rsi&bot=meridian_v3&side=buy&pair=BNB-USDC');
  assert.equal(client.fleetFillsPath('v2', { before: null, bots: [], side: null, pair: '  ' }), '/api/v1/servers/v2/fleet/fills');
});

test('cursor pages merge once per fill id in server order', () => {
  const first = client.parseFleetFills(example('page_first'));
  const second = client.parseFleetFills(example('page_second'));
  const merged = client.mergeFleetFillPages([first, second]);
  assert.equal(merged.length, first.items.length + second.items.length);
  assert.equal(merged.length, first.matched, 'walking the cursor to the end returns the whole matched window');
  assert.deepEqual(merged.map(row => row.id), [...first.items, ...second.items].map(row => row.id));
  assert.equal(new Set(merged.map(row => row.id)).size, merged.length);
  // A refresh may report a row on two neighbouring pages when new fills arrived: it is kept once, at its first place.
  const overlapping = structuredClone(second);
  overlapping.items.unshift(structuredClone(first.items.at(-1)));
  const dedup = client.mergeFleetFillPages([first, overlapping]);
  assert.equal(dedup.length, merged.length);
  assert.deepEqual(dedup.map(row => row.id), merged.map(row => row.id));
  assert.deepEqual(client.mergeFleetFillPages([]), []);
});
