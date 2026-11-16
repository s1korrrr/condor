import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { paperWalletOwnerDegraded, paperLastWalletToKeep, paperLastWalletToShow, paperExitProjection, paperPairHoldings, paperPairBag, paperReadFailureMessage, paperRiskControllers, paperRiskUsage } from '../src/v5/policy.ts';
import { frontendModules, paperWorkspaceModules } from './helpers/frontend-module.mjs';

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
  // The engine's own words: all 9 rows are explicit false with no_active_fixed_target_executor, i.e. without a
  // fixed-target exit order. Nothing is inferred about the bag policy selling them; no other reason is published.
  assert.deepEqual([holdings.noFixedTargetCount, holdings.unprotectedCount, holdings.unprotectedReasons], [9, 0, []]);
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

test('rendered position card shows exact holdings, excludes dust and retains native rails', () => {
  const {load} = paperWorkspaceModules();
  const {PaperWorkspace} = load('pages/tabs/ActiveBotsTab.tsx');
  const reads = Object.values({...final3, positions: livePositions});
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads, now, reportAt:final3.status.generated_at_ms, heartbeat:'Fresh', bot:'meridian_v5_paper'}));
  assert.match(html, /<dt>Holding<\/dt><dd><span title="0\.3615174">0\.361517 BNB/);
  assert.match(html, /\+ <span title="0\.0000016">0\.000002 BNB<\/span> dust/);
  assert.match(html, /<dt>Lots<\/dt><dd>6<\/dd>/);
  assert.match(html, /<dt>Sell orders placed<\/dt><dd>— · protection unknown for 6 lot\(s\)/);
  assert.doesNotMatch(html, /bag-managed|sold by the bag policy|no resting order/);
  assert.match(html, /Breakeven:.*748\.17 USDC/);
  assert.match(html, /Bag reason<\/dt><dd>Below target/);
  assert.match(html, /Trailing armed<\/dt><dd>No/);
  assert.match(html, /Trailing peak<\/dt><dd>— · not published/);
  assert.match(html, /Release<\/dt><dd>— · not published/);
  assert.match(html, /Reported native entry hold: No|Native evidence complete/);
  assert.match(html, /Pair cap 40000 USDC/);
  assert.doesNotMatch(html, /Numeric rail limits are not published/);
});

test('position card formats money and quantities without losing exact values', () => {
  const {PaperPositions} = frontendModules().load('v5/PaperPositions.tsx');
  const decisions = structuredClone(final3.decisions);
  const bag = decisions.data.controllers.find(row => row.pair === 'BNB-USDC').custom_info.bag;
  Object.assign(bag,{breakeven_price:'680.8963033983613722931914460',trail_peak:'800.123456789123456789'});
  const wallet = structuredClone(final3.wallet);
  const asset = wallet.data.assets.find(row => row.asset === 'BNB');
  Object.assign(asset,{marked_value_quote:'1234.567890000000',mark_at_ms:now});
  const money = {rows:[{bot:'v5',at_ms:now,snapshot_at_ms:now,unit:'USDC',coins:{BNB:{realized:'114.1396691483993272381433853',unrealized:'0'}}}]};
  const prices = {'BNB-USDC':{buckets:[[Math.floor(now/60000)*60-60,1,2,1,680.896303,0,1]]}};
  const html = renderToStaticMarkup(React.createElement(PaperPositions,{positions:livePositions,decisions,wallet,money,prices,now}));
  assert.ok(html.includes('title="114.1396691483993272381433853 + 0 = 114.1396691483993272381433853"'));
  for (const exact of ['680.8963033983613722931914460','800.123456789123456789','1234.567890000000','0.3615174','0.0000016']) assert.ok(html.includes(`title="${exact}"`),exact);
  for (const formatted of ['114.14 USDC','680.90 USDC','800.12 USDC','1,234.57 USDC','0.361517 BNB','0.000002 BNB']) assert.ok(html.includes(formatted),formatted);
});

test('position cards cross-check protections and retain the snapshot buy decision', () => {
  const row = {...BNB_ROWS[0], protected_exit:true};
  const positions = {...livePositions, data:[row, BNB_ROWS[1]]};
  const executor = {executor_id:row.executor_id, controller_id:row.controller_id, trading_pair:row.trading_pair, state:'active', protected_exit:true};
  const decisions = {...final3.decisions, data:{...final3.decisions.data, conditions:[{trading_pair:'BNB-USDC', status:'held', reason:'candle_gap', event_at_ms:now}]}};
  const {PaperPositions} = frontendModules().load('v5/PaperPositions.tsx');
  const render = executors => renderToStaticMarkup(React.createElement(PaperPositions,{positions,executors,decisions,now,asOf:now,valuesAt:now}));
  const verified = {...final3.executors, data:[executor]};
  assert.match(render(verified), /1 of 1 · verified protected exits/);
  assert.match(render({...verified,data:[{...executor,protected_exit:false}]}), /— · protection unknown for 1 lot\(s\)/);
  assert.match(render({...verified,completeness:'partial'}), /1 of 1 · owner-reported · executor cross-check unavailable/);
  assert.match(render(undefined), /1 of 1 · owner-reported · executor cross-check unavailable/);
  const unknownPositions = {...positions, data:[{...row, protected_exit:null}]};
  assert.match(renderToStaticMarkup(React.createElement(PaperPositions,{positions:unknownPositions,executors:{...verified,completeness:'partial'},now})), /— · protection unknown for 1 lot\(s\)/);
  assert.match(render(verified), /Buy decision: Held · Candle gap · .*UTC/);
  assert.match(render(verified), /class="paper-dimmed-position"[^]*?Buy decision: Held · Candle gap/);
  const otherSnapshot = {...decisions, snapshot_id:'other:1'};
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(PaperPositions,{positions,executors:verified,decisions:otherSnapshot,now})), /Buy decision: Held · Candle gap/);
});

test('position details retain the owner trailing and release facts', () => {
  const decisions = structuredClone(final3.decisions);
  const bag = decisions.data.controllers.find(row => row.pair === 'BNB-USDC').custom_info.bag;
  Object.assign(bag, { reason:'below_target', trail_armed:true, trail_peak:'800.123456789123456789', release:'trailing_exit' });
  const {PaperWorkspace} = paperWorkspaceModules().load('pages/tabs/ActiveBotsTab.tsx');
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads:Object.values({...final3, decisions}), now, reportAt:final3.status.generated_at_ms, heartbeat:'Fresh', bot:'meridian_v5_paper'}));
  assert.match(html, /Bag reason<\/dt><dd>Below target/);
  assert.match(html, /Trailing armed<\/dt><dd>Yes/);
  assert.match(html, /Trailing peak<\/dt><dd><span title="800\.123456789123456789">800\.12 USDC/);
  assert.match(html, /Release<\/dt><dd>Trailing exit/);
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
  assert.equal(holdings.noFixedTargetCount, 1);
  assert.equal(holdings.unprotectedCount, 0);
  assert.equal(holdings.unknownCount, 7);
  assert.deepEqual(holdings.unprotectedReasons, []);
  const other = {...positions, data: positions.data.map(row => row === mixed[1] ? {...row, protection_reason: 'executor_missing'} : row)};
  assert.deepEqual([paperPairHoldings('BNB-USDC', other, now).unprotectedCount, paperPairHoldings('BNB-USDC', other, now).unprotectedReasons], [1, ['executor_missing']], 'any other explicit false is unprotected, with its reason');
  const allOmitted = {...positions, data:[...final3.positions.data.filter(row => row.trading_pair !== 'BNB-USDC'), ...BNB_ROWS.map(omit)]};
  assert.deepEqual([paperPairHoldings('BNB-USDC', allOmitted, now).unprotectedCount, paperPairHoldings('BNB-USDC', allOmitted, now).unknownCount], [0, 9]);
  const {load} = paperWorkspaceModules();
  const {PaperWorkspace} = load('pages/tabs/ActiveBotsTab.tsx');
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads:Object.values({...final3, positions:allOmitted}), now, reportAt:final3.status.generated_at_ms, heartbeat:'Fresh', bot:'meridian_v5_paper'}));
  const card = html.match(/<h3>BNB<\/h3>[^]*?<\/article>/)?.[0] ?? '';
  assert.doesNotMatch(card, /unprotected/, 'omitted flags are not unprotected');
  assert.match(card, /Sell orders placed<\/dt><dd>— · protection unknown for 6 lot\(s\)/);
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

test('the last-complete-equity fallback needs a current wallet the owner itself marked degraded (Sol R1 S2)', () => {
  const at = 1794669611428;
  const wallet = { schema: 'rsibot.v5-paper.read.v1', section: 'wallet', state: 'degraded', execution_mode: 'paper', simulated: true, bot_id: 'meridian_v5_paper', snapshot_id: 'b:1', generated_at_ms: at, observed_at_ms: at, read_at_ms: at, source_at_ms: at, completeness: 'complete', reason: 'missing_fresh_marks:BTC', capabilities: ['read'], source: {}, next_cursor: null, data: { equity_quote: null } };
  assert.equal(paperWalletOwnerDegraded(wallet, at + 5_000), true);
  // The synthetic section that replaces a client schema failure (data null, unavailable) is not owner degradation.
  assert.equal(paperWalletOwnerDegraded({ ...wallet, data: null, completeness: 'unavailable', reason: 'Wallet owner schema invalid; this section is unavailable.' }, at + 5_000), false);
  assert.equal(paperWalletOwnerDegraded(wallet, at + 31_000), false, 'a stale read is never revived');
  assert.equal(paperWalletOwnerDegraded({ ...wallet, generated_at_ms: at + 60_000 }, at), false, 'a future timestamp is not current');
  assert.equal(paperWalletOwnerDegraded({ ...wallet, generated_at_ms: at + 1_000 }, at), false, 'even 1 s ahead (inside the 5 s skew tolerance) is not current (Sol R2 S3)');
  assert.equal(paperWalletOwnerDegraded({ ...wallet, state: 'available' }, at + 5_000), false);
  assert.equal(paperWalletOwnerDegraded({ ...wallet, section: 'positions' }, at + 5_000), false);
});

test('the remembered wallet is never a future value and is shown only when older than the degraded read (Terra R2)', () => {
  const now = 100_000;
  const read = (state, at) => ({ schema: 'rsibot.v5-paper.read.v1', section: 'wallet', state, execution_mode: 'paper', simulated: true, bot_id: 'meridian_v5_paper', snapshot_id: 'b:1', generated_at_ms: at, observed_at_ms: at, read_at_ms: at, source_at_ms: at, completeness: 'complete', reason: state === 'degraded' ? 'missing_fresh_marks:BTC' : null, capabilities: ['read'], source: {}, next_cursor: null, data: { equity_quote: state === 'degraded' ? null : '199000' } });
  const totals = { equity: '199000', cash: '193000' };
  // A complete wallet 4 s ahead (inside the 5 s skew tolerance) is not remembered.
  assert.equal(paperLastWalletToKeep('v5', totals, read('available', now + 4_000), now), null);
  const kept = paperLastWalletToKeep('v5', totals, read('available', now - 10_000), now);
  assert.deepEqual(kept, { bot: 'v5', equity: '199000', cash: '193000', asOf: now - 10_000 });
  // Shown for a newer owner-degraded read of the same bot...
  assert.equal(paperLastWalletToShow(kept, 'v5', read('degraded', now - 2_000), now), kept);
  // ...never when the remembered value is newer than (or as new as) the degraded read, for another bot, or a stale read.
  assert.equal(paperLastWalletToShow(kept, 'v5', read('degraded', now - 10_000), now), null);
  assert.equal(paperLastWalletToShow({ ...kept, asOf: now - 1_000 }, 'v5', read('degraded', now - 2_000), now), null);
  assert.equal(paperLastWalletToShow(kept, 'other', read('degraded', now - 2_000), now), null);
  assert.equal(paperLastWalletToShow(kept, 'v5', read('degraded', now - 40_000), now), null);
});

test('the entry hold opens with one sentence from what the owner published (Fable UI item 5)', () => {
  const {load} = frontendModules(Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}])));
  const {paperHoldSentence} = load('pages/tabs/ActiveBotsTab.tsx');
  assert.equal(paperHoldSentence([{operator:{paused:true, emergency:false}}], []), 'Buying is paused by an operator.');
  // An emergency halt's effect on exits is not published: no claim about selling.
  assert.equal(paperHoldSentence([{operator:{paused:false, emergency:true}}], []), 'The owner reports an emergency halt: buying is stopped.');
  assert.equal(paperHoldSentence([{operator:{paused:null, emergency:null}}], [{label:'Daily loss rail'}, {label:'Daily loss rail'}]), 'Buying is held: Daily loss rail.');
  assert.equal(paperHoldSentence([], []), null);
});
