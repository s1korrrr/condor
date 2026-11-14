import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { paperExitProjection, paperPairHoldings, paperPairBag, paperReadFailureMessage, paperRiskControllers, paperRiskUsage } from '../src/v5/policy.ts';
import { frontendModules } from './helpers/frontend-module.mjs';

const final3 = Object.fromEntries(['status','wallet','positions','executors','fills','risk','decisions','history','operations'].map(section => [section, JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/${section}.json`, import.meta.url)))]));
const now = final3.status.read_at_ms;

// Live owner rows, 2026-11-05 14:37Z (trial-20261102T122017551925017Z, sequence 17276): BNB is nine tranche rows.
// Their exact sum equals the owner wallet BNB total 0.3615190 (held 0.3615174 + dust 0.0000016).
const BNB_ROWS = [
  ['held_reconciliation', '0.1411930'], ['terminal_dust', '0.0000005'], ['terminal_dust', '0.0000002'], ['terminal_dust', '0.0000009'],
  ['held_reconciliation', '0.0042402'], ['held_reconciliation', '0.0013493'], ['held_reconciliation', '0.1413610'],
  ['held_reconciliation', '0.0682854'], ['held_reconciliation', '0.0050885'],
].map(([state, quantity], index) => ({
  ...final3.positions.data[0], position_id: `bnb-${index}`, executor_id: `bnb-${index}`, controller_id: 'modular_spot_meridian_v5_paper_bnb',
  trading_pair: 'BNB-USDC', state, quantity, protected_exit: false, protected_exit_order: null, protection_reason: 'no_active_fixed_target_executor',
}));
const livePositions = {...final3.positions, data: [...final3.positions.data.filter(row => row.trading_pair !== 'BNB-USDC'), ...BNB_ROWS]};

test('pair holdings sum every owner tranche exactly instead of showing the first row', () => {
  const holdings = paperPairHoldings('BNB-USDC', livePositions, now);
  assert.equal(holdings.total, '0.3615190');
  assert.equal(holdings.count, 9);
  assert.deepEqual(holdings.states, [{state:'held_reconciliation',count:6,quantity:'0.3615174'},{state:'terminal_dust',count:3,quantity:'0.0000016'}]);
  assert.equal(holdings.protectedCount, 0);
  // Every row is a held bag stamped no_active_fixed_target_executor by the engine: bag-managed, not unprotected.
  assert.deepEqual([holdings.bagManagedCount, holdings.unprotectedCount, holdings.unprotectedReasons], [9, 0, []]);
  assert.equal(paperPairHoldings('BNB-USDC', {...livePositions, completeness:'partial'}, now), null, 'partial read publishes no total');
  assert.equal(paperPairHoldings('BNB-USDC', {...livePositions, next_cursor:'more'}, now), null, 'unread pages publish no total');
  assert.equal(paperPairHoldings('BNB-USDC', livePositions, now + 31_000), null, 'stale read publishes no total');
  assert.equal(paperPairHoldings('BNB-USDC', {...livePositions, data:[{...BNB_ROWS[0], quantity:1}]}, now), null, 'non-decimal quantity is refused');
});

test('pair bag comes only from a complete decisions read of the same snapshot', () => {
  const bag = paperPairBag('BNB-USDC', final3.decisions, final3.positions, now);
  assert.deepEqual(bag, {reason:'below_target', heldAmount:'0.0682854', breakevenPrice:'748.17', trailArmed:false, trailPeak:null, release:null});
  assert.equal(paperPairBag('BNB-USDC', {...final3.decisions, snapshot_id:'other:1'}, final3.positions, now), null);
  assert.equal(paperPairBag('BNB-USDC', final3.decisions, final3.positions, now + 31_000), null);
});

test('native entry hold follows the owner latch; unknown is never reported as No', () => {
  const risk = final3.risk;
  const withNative = native => ({...risk, data:{...risk.data, controllers:{...risk.data.controllers, modular_spot_meridian_v5_paper_bnb:{...risk.data.controllers.modular_spot_meridian_v5_paper_bnb, native}}}});
  const bnb = read => paperRiskControllers(read, now).find(row => row.id === 'modular_spot_meridian_v5_paper_bnb');
  const native = risk.data.controllers.modular_spot_meridian_v5_paper_bnb.native;
  assert.equal(bnb(risk).entryHold, false);
  assert.equal(bnb(withNative({...native, latched:true})).entryHold, true);
  assert.equal(bnb(withNative({...native, complete:false, latched:null, entry_hold:true})).entryHold, true);
  assert.equal(bnb(withNative({...native, complete:false, latched:null})).entryHold, null);
});

test('native per-controller rails are shown when the owner publishes no flat rail list', () => {
  const rails = paperRiskUsage(final3.risk, now);
  assert.equal(rails.length, 5);
  const bnb = rails.find(rail => rail.label.startsWith('modular_spot_meridian_v5_paper_bnb'));
  assert.equal(bnb.limit_quote, '40000');
  assert.equal(bnb.used_quote, final3.risk.data.controllers.modular_spot_meridian_v5_paper_bnb.native.marked_exposure);
  assert.match(bnb.note, /native entry latch: No/);
  const incomplete = {...final3.risk, data:{...final3.risk.data, controllers:{x:{operator:{}, native:{complete:false, stale_reason:'native_risk_unavailable', marked_exposure:'5', configured_limits:{pair_quote:'40000'}}}}}};
  assert.deepEqual([paperRiskUsage(incomplete, now)[0].used_quote, paperRiskUsage(incomplete, now)[0].used_percent], [null, null], 'incomplete native risk infers no use');
});

test('paper read failures are typed: timeouts are transient, invalid publications are not', () => {
  assert.match(paperReadFailureMessage(503, {detail:{code:'upstream_timeout'}}), /^Transient: .*HTTP 503 · upstream_timeout/);
  assert.match(paperReadFailureMessage(503, {detail:{code:'upstream_unavailable', upstream_code:'PAPER_READ_CAPACITY', upstream_reason:'wait_timeout'}}), /^Transient: .*PAPER_READ_CAPACITY · wait_timeout/);
  const invalid = paperReadFailureMessage(503, {detail:{code:'upstream_unavailable', upstream_code:'PAPER_SOURCE_INVALID', upstream_reason:'corruption'}});
  assert.match(invalid, /failed validation/);
  assert.doesNotMatch(invalid, /Transient/);
  assert.match(paperReadFailureMessage(502, null), /^Paper observations are unavailable \(HTTP 502\)/);
  assert.match(paperReadFailureMessage(409, null), /snapshot changed/);
});

test('rendered pair card shows the exact pair total, bag, protection summary and native rails', () => {
  const {load} = frontendModules(Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}])));
  const {PaperWorkspace} = load('pages/tabs/ActiveBotsTab.tsx');
  const reads = Object.values({...final3, positions: livePositions});
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads, now, reportAt:final3.status.generated_at_ms, heartbeat:'Fresh', bot:'meridian_v5_paper'}));
  assert.match(html, /<dt>Position<\/dt><dd>0\.3615190 BNB/);
  assert.doesNotMatch(html, /<dt>Position<\/dt><dd>0\.141193 BNB/);
  assert.match(html, /Held reconciliation: 6 · 0\.3615174 BNB · Terminal dust: 3 · 0\.0000016 BNB/);
  assert.match(html, /Owner-reported exits over 9 position rows: 0 resting exit orders/);
  assert.match(html, /<dt>Bag<\/dt><dd>Below target · breakeven 748\.1700 USDC/);
  assert.match(html, /Reported native entry hold: No|Native evidence complete/);
  assert.match(html, /Pair cap 40000 USDC/);
  assert.doesNotMatch(html, /Numeric rail limits are not published/);
});

// Live 2026-11-05 15:45Z: every position showed "Protection status unknown · executor data incomplete". The executors
// read is a bounded terminal window (partial), but the complete positions read carries the owner's own per-position
// protection statement. Risk-level protected_exits=preserved does not certify coverage (native risk says so).
test('protection falls back to the owner per-position statement when only the executor cross-check is unavailable', () => {
  const row = {...BNB_ROWS[0]};
  const positions = {...livePositions, data:[row]};
  const executors = {...final3.executors, completeness:'partial', stale_reason:'bounded_terminal_window_see_history_terminal_executors'};
  const exit = paperExitProjection(row, positions, executors, now);
  assert.equal(exit.verified, false, 'an owner statement is not an executor-verified exit');
  assert.match(exit.reason, /^Owner-reported: no protected exit · No active fixed target executor · executor cross-check unavailable \(executor data incomplete since /);
  const protectedRow = {...row, protected_exit:true, protection_reason:null};
  assert.match(paperExitProjection(protectedRow, {...positions, data:[protectedRow]}, executors, now).reason, /^Owner-reported: protected exit present · executor cross-check unavailable/);
  assert.match(paperExitProjection(row, positions, {...executors, completeness:'complete', stale_reason:null, data:[]}, now).reason, /^Protection status unknown/, 'a complete executor read without the position is a failed cross-check, not a missing one');
  assert.match(paperExitProjection(row, {...positions, completeness:'partial'}, executors, now).reason, /^Protection status unknown · position data incomplete/, 'an incomplete position read publishes no owner statement');
  assert.match(paperExitProjection(row, positions, executors, now + 31_000).reason, /^Protection status unknown · position data stale/, 'a stale position read publishes no owner statement');
  assert.match(paperExitProjection({...row, protected_exit:'yes'}, {...positions, data:[{...row, protected_exit:'yes'}]}, executors, now).reason, /^Protection status unknown/, 'a malformed owner flag is not interpreted');
});

// Sol review R97-SOL-1: an omitted owner protected_exit flag is unknown, never "unprotected" or a counted zero.
test('pair protection summary keeps omitted owner flags unknown', () => {
  const omit = ({protected_exit, protection_reason, ...rest}) => rest;
  const mixed = BNB_ROWS.map((row, index) => index === 0 ? {...row, protected_exit:true, protection_reason:null} : index === 1 ? row : omit(row));
  const positions = {...livePositions, data:[...final3.positions.data.filter(row => row.trading_pair !== 'BNB-USDC'), ...mixed]};
  const holdings = paperPairHoldings('BNB-USDC', positions, now);
  assert.equal(holdings.protectedCount, 1);
  // The engine stamps a held bag row false / no_active_fixed_target_executor by definition: bag-managed, not unprotected.
  assert.equal(holdings.bagManagedCount, 1);
  assert.equal(holdings.unprotectedCount, 0);
  assert.equal(holdings.unknownCount, 7);
  assert.deepEqual(holdings.unprotectedReasons, []);
  const other = {...positions, data: positions.data.map(row => row === mixed[1] ? {...row, protection_reason: 'executor_missing'} : row)};
  assert.deepEqual([paperPairHoldings('BNB-USDC', other, now).unprotectedCount, paperPairHoldings('BNB-USDC', other, now).unprotectedReasons], [1, ['executor_missing']], 'any other explicit false is unprotected, with its reason');
  const allOmitted = {...positions, data:[...final3.positions.data.filter(row => row.trading_pair !== 'BNB-USDC'), ...BNB_ROWS.map(omit)]};
  assert.deepEqual([paperPairHoldings('BNB-USDC', allOmitted, now).unprotectedCount, paperPairHoldings('BNB-USDC', allOmitted, now).unknownCount], [0, 9]);
  const {load} = frontendModules(Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}])));
  const {PaperWorkspace} = load('pages/tabs/ActiveBotsTab.tsx');
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads:Object.values({...final3, positions:allOmitted}), now, reportAt:final3.status.generated_at_ms, heartbeat:'Fresh', bot:'meridian_v5_paper'}));
  const card = html.match(/<h3>BNB-USDC<\/h3>[^]*?<\/article>/)?.[0] ?? '';
  const summary = card.match(/Owner-reported exits over[^<]+/)?.[0] ?? '';
  assert.doesNotMatch(summary, /unprotected/, 'omitted flags are not unprotected');
  assert.match(summary, /over 9 position rows: 0 resting exit orders · protection not published: 9/);
});

// Rebased onto #99: a native latch (owner native-risk.v1 `latched`) must still raise safety evidence through
// paperSafetyBeyondDisplayed; a repeated latch the displayed read already shows is not handed to the view twice.
test('a native latch survives the displayed-evidence dedupe and is not duplicated', async () => {
  const { paperSafetyBeyondDisplayed, paperSafetyReads } = await import('../src/v5/paper-safety.ts');
  const risk = final3.risk;
  const id = 'modular_spot_meridian_v5_paper_bnb';
  const withLatch = (read, latched, snapshot) => ({...read, snapshot_id:snapshot, data:{...read.data, controllers:{...read.data.controllers, [id]:{...read.data.controllers[id], native:{...read.data.controllers[id].native, latched}}}}});
  const displayed = withLatch(risk, false, risk.snapshot_id);
  const retained = withLatch(risk, true, 'next:1');
  // Displayed read shows no hold signal at all: #99 hands retained evidence on unchanged (nothing dropped).
  const added = paperSafetyBeyondDisplayed([retained], [displayed]);
  assert.equal(added.length, 1, 'the latch is new evidence');
  assert.equal(added[0].data.controllers[id].native.latched, true);
  // Displayed read already shows another controller's pause: the retained read is cut to the latch it adds.
  const other = 'modular_spot_meridian_v5_paper_btc';
  const paused = read => ({...read, data:{...read.data, controllers:{...read.data.controllers, [other]:{...read.data.controllers[other], operator:{...read.data.controllers[other].operator, paused:true}}}}});
  const cut = paperSafetyBeyondDisplayed([paused(retained)], [paused(displayed)]);
  assert.deepEqual(Object.keys(cut[0].data.controllers), [id], 'only the controller that adds the latch is handed on');
  assert.equal(cut[0].data.controllers[id].native.latched, true);
  assert.deepEqual(paperSafetyBeyondDisplayed([retained], [withLatch(risk, true, risk.snapshot_id)]), [], 'a latch already displayed is not repeated');
  assert.ok(paperSafetyReads([], [final3.status, withLatch(risk, true, final3.status.snapshot_id)]).length > 0, 'retention keeps a latched read');
});
