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

test('full and glance require positive recorded time for execution attestation', () => {
  for (const view of ['full', 'glance']) {
    for (const recorded of [0, 1]) {
      const body = example(view);
      const raw = body.fills[0];
      Object.assign(raw, { time_ms: recorded, execution_timestamp_ms: 1, execution_timestamp_source: 'okx.fillTime' });
      const row = client.parseFleetSummary(body, view).fills[0];
      assert.equal(row.time_ms, recorded);
      assert.equal(row.execution_timestamp_ms, recorded === 0 ? null : 1);
      assert.equal(row.execution_timestamp_source, recorded === 0 ? null : 'okx.fillTime');
      assert.equal(row.amount, raw.amount);
      assert.equal(row.volume, raw.volume);
    }
  }
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

test('summary fills retain only locally qualified execution attestations in full and glance', () => {
  for (const view of ['full', 'glance']) {
    const body = structuredClone(example(view));
    const raw = body.fills[0];
    const recorded = raw.time_ms;
    const volume = raw.volume;
    raw.execution_timestamp_ms = recorded - 2000;
    raw.execution_timestamp_source = 'okx.fillTime';
    const valid = client.parseFleetSummary(body, view).fills[0];
    assert.equal(valid.execution_timestamp_ms, recorded - 2000, view);
    assert.equal(valid.execution_timestamp_source, 'okx.fillTime', view);
    assert.equal(valid.time_ms, recorded, 'attestation never replaces the recorded clock');
    assert.equal(valid.volume, volume, 'attestation never changes money');

    for (const [timestamp, source] of [[true, 'okx.fillTime'], [0, 'okx.fillTime'],
      [recorded + 5001, 'okx.fillTime'], [recorded - 2000, 'okx.uTime'],
      [String(recorded), 'okx.fillTime'], [Number.MAX_SAFE_INTEGER, 'okx.fillTime'],
      [body.generated_at_ms + 5001, 'okx.fillTime']]) {
      raw.execution_timestamp_ms = timestamp;
      raw.execution_timestamp_source = source;
      const unknown = client.parseFleetSummary(body, view).fills[0];
      assert.equal(unknown.execution_timestamp_ms, null, `${view}: ${String(timestamp)} / ${source}`);
      assert.equal(unknown.execution_timestamp_source, null);
      assert.equal(unknown.time_ms, recorded);
      assert.equal(unknown.volume, volume);
    }
    raw.time_ms = null;
    raw.execution_timestamp_ms = recorded - 2000;
    raw.execution_timestamp_source = 'okx.fillTime';
    assert.equal(client.parseFleetSummary(body, view).fills[0].execution_timestamp_ms, null, 'no recorded anchor');
    raw.time_ms = body.generated_at_ms + 5000;
    raw.execution_timestamp_ms = body.generated_at_ms + 5001;
    assert.equal(client.parseFleetSummary(body, view).fills[0].execution_timestamp_ms, null, 'after publication tolerance');
    raw.time_ms = recorded;
    delete raw.execution_timestamp_ms;
    delete raw.execution_timestamp_source;
    const legacy = client.parseFleetSummary(body, view).fills[0];
    assert.equal(legacy.execution_timestamp_ms, null, 'older v1 payload stays readable');
    assert.equal(legacy.execution_timestamp_source, null);
  }
});

test('glance keeps the quote unit of each PnL window', () => {
  const body = structuredClone(example('glance'));
  body.pnl.unit = 'USDT';
  body.pnl.day.unit = 'USDC';
  body.pnl.week.unit = null;
  delete body.pnl.month.unit;
  body.pnl.all.unit = 'USDT';
  const glance = client.parseFleetSummary(body, 'glance');
  assert.equal(glance.pnl.unit, 'USDT');
  assert.deepEqual(['day', 'week', 'month', 'all'].map(name => glance.pnl[name].unit),
    ['USDC', null, null, 'USDT'], 'a window never borrows the global quote or fabricates a missing unit');
});

test('native account wallet must retain scope and subtotal coverage', () => {
  const body = structuredClone(example('full'));
  body.wallet.valuation_complete = false;
  body.wallet.unpriced_assets = ['PLN'];
  body.wallet.unpriced_count = 1;
  body.sections.wallet.status = 'partial';
  assert.equal(client.parseFleetSummary(body, 'full').wallet.unpriced_count, 1);
  body.wallet.account_scope.identity = '';
  assert.throws(() => client.parseFleetSummary(body, 'full'), /wallet/);
});

test('USDC native account wallet requires and preserves the materiality policy in both views', () => {
  for (const view of ['full', 'glance']) {
    const body = structuredClone(example(view));
    Object.assign(body.wallet, {
      unit: 'USDC', valuation_complete: true, unpriced_assets: [], unpriced_count: 0,
      valuation_basis: 'native_account_usdc_material_v1', dust_threshold_usd: '1',
      excluded_dust_assets: ['PLN'], excluded_dust_count: 1,
    });
    const wallet = client.parseFleetSummary(body, view).wallet;
    assert.equal(wallet.unit, 'USDC');
    assert.equal(wallet.valuation_basis, 'native_account_usdc_material_v1');
    assert.equal(wallet.dust_threshold_usd, '1');
    assert.deepEqual(wallet.excluded_dust_assets, ['PLN']);
    assert.equal(wallet.excluded_dust_count, 1);
    delete body.wallet.valuation_basis;
    assert.throws(() => client.parseFleetSummary(body, view), /wallet/);
    body.wallet.valuation_basis = 'native_account_usdc_material_v1';
    body.wallet.dust_threshold_usd = '0.99';
    assert.throws(() => client.parseFleetSummary(body, view), /wallet/);
    body.wallet.dust_threshold_usd = '1';
    body.wallet.excluded_dust_count = 2;
    assert.throws(() => client.parseFleetSummary(body, view), /wallet/);
  }
});

test('section age and staleness are computed by the client from observed_at_ms', () => {
  const full = example('full');
  const now = full.generated_at_ms;
  assert.equal(client.sectionAgeMs(full.sections.wallet, now), 30_000);
  assert.equal(client.sectionIsStale(full.sections.wallet, now), false);
  assert.equal(client.sectionIsStale(full.sections.wallet, now + 200_000), true, 'older than its own stale_after_ms');
  assert.equal(client.sectionIsStale(full.sections.bots, now), true, 'the server flagged it');
});

test('request path encodes the server, selects the view and pins the major schema', () => {
  assert.equal(client.fleetSummaryPath('my server'), '/api/v1/servers/my%20server/fleet/summary?schema=fleet-summary.v1');
  assert.equal(client.fleetSummaryPath('v2', 'glance'), '/api/v1/servers/v2/fleet/summary?view=glance&schema=fleet-summary.v1');
});

test('the actual fleet hook opts into native-account wallet claims for both views', async () => {
  const calls = [];
  const { load: hookLoad } = frontendModules({
    '@tanstack/react-query': { useQuery: options => options },
    '@/lib/auth-token': { authFetch: async (path, init) => {
      calls.push({ path, init });
      return new Response(JSON.stringify(example(path.includes('view=glance') ? 'glance' : 'full')), { status: 200 });
    } },
  });
  const hook = hookLoad('features/quant-ops/use-fleet-summary.ts').useFleetSummary;
  for (const view of ['full', 'glance']) {
    const query = hook('v2', view);
    const result = await query.queryFn({ signal: new AbortController().signal });
    assert.equal(result.view, view);
  }
  assert.equal(calls.length, 2);
  for (const { init } of calls) assert.equal(new Headers(init.headers).get('X-RSIBOT-Wallet-Claims'), 'native-account-v1');
});
