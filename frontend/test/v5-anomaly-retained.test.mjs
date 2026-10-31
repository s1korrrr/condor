// Round-8 repro: the pinned owner never removes quarantined clock anomalies.
// meridian_v5_paper_control.py (ee8ca6ad) appends to state['clock_anomalies'] (l.1883),
// clock maintenance only fills 'clock_anomalies_reviewed' (l.2315-2318), and every risk
// snapshot publishes clock_recovery.anomalies = clock_anomalies[-64:] (l.2645).
// The owner's own clock-anomaly fixture records timestamp 1e18 (> Number.MAX_SAFE_INTEGER).
// The API does not bound that key (validate_tree only bounds *_ms), so every later risk read
// fails paperSectionError, can never qualify, and retained safety evidence never clears.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const FE = new URL('../', import.meta.url).pathname;
const require = createRequire(`${FE}/package.json`);
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {paperSafetyReads} = await import(`${FE}/src/v5/paper-safety.ts`);
const {paperSectionError} = await import(`${FE}/src/v5/policy.ts`);
const {frontendModules} = await import(`${FE}/test/helpers/frontend-module.mjs`);
const {ownerRisk} = await import(`${FE}/test/helpers/owner-risk.mjs`);

const fixture = section => JSON.parse(fs.readFileSync(`${FE}/../tests/fixtures/paper-api-final3/${section}.json`));
const anomaly = JSON.parse(fs.readFileSync(`${FE}/../tests/fixtures/paper-c1-1e131c74/clock-anomaly-hold.json`)).risk.data.clock_recovery.anomalies;
const stubs = {
  ...Object.fromEntries(['@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser', '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline', '@/hooks/useWebSocket', '@/hooks/useRates'].map(name => [name, {}])),
  '@/features/quant-ops/kit/DataTable': {DataTable:() => null},
  '@workspace-monitoring': {PaperStrategyCharts:() => null, StrategyCharts:() => null},
};
const {PaperWorkspace} = frontendModules(stubs).load('pages/tabs/ActiveBotsTab.tsx');
const advance = read => ({...read, snapshot_id:`${read.source.boot_id}:${read.source.sequence + 1}`, generated_at_ms:read.generated_at_ms + 15_000, source:{...read.source, sequence:read.source.sequence + 1}});

const older = ownerRisk('native-entry-holds', fixture('risk'));
const bnb = Object.keys(older.data.controllers)[0];
older.data.controllers[bnb].operator.emergency = true;

// Owner after clock maintenance and an emergency clear: clock hold gone, anomaly retained.
function cleared(withAnomaly) {
  const newer = advance(structuredClone(older));
  newer.data.controllers[bnb].operator.emergency = false;
  newer.data.holds = [];
  newer.data.control_hold = null;
  newer.data.clock_recovery = {required:false, hold:null, high_water_ms:newer.generated_at_ms, anomalies:withAnomaly ? structuredClone(anomaly) : []};
  return newer;
}

test('control: the same cleared owner read without a retained anomaly clears the emergency', () => {
  assert.deepEqual(paperSafetyReads([older], [], cleared(false)), []);
});

test('cleared owner read that still publishes the quarantined anomaly clears the retained emergency', () => {
  const newer = cleared(true);
  assert.equal(paperSectionError(newer), null, 'quarantined evidence must not invalidate current flags');
  assert.deepEqual(paperSafetyReads([older], [], newer), []);
});

test('the dashboard does not keep reporting an emergency the owner has cleared', () => {
  let newer = cleared(true);
  let retained = [older];
  for (let i = 0; i < 20; i++) {   // 20 owner snapshots (5 minutes at 15 s), all cleared
    retained = paperSafetyReads(retained, [], newer);
    if (i < 19) newer = advance(structuredClone(newer));
  }
  const reads = [...['status', 'wallet', 'positions', 'fills', 'executors', 'decisions', 'history'].map(section => advance(fixture(section))), newer];
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace, {reads, safetyReads:retained, complete:true, now:newer.generated_at_ms, reportAt:null, heartbeat:'Fresh', bot:older.bot_id}));
  assert.doesNotMatch(html, /Emergency halt reported/);
});

for (const withAnomaly of [false, true]) test(`received owner clock_anomaly hold clears after owner clock maintenance (anomaly still published: ${withAnomaly})`, () => {
  const sync = read => ({...read, snapshot_id:older.snapshot_id, generated_at_ms:older.generated_at_ms, source:{...older.source}});
  const status = sync(fixture('status'));
  const held = sync(ownerRisk('clock-anomaly-hold', fixture('risk')));
  let retained = paperSafetyReads([], [status, held]);          // real progress path: status + risk of one snapshot
  assert.equal(retained.length, 1, 'precondition: the received hold is retained');
  let newer = cleared(withAnomaly);
  for (let i = 0; i < 20; i++) { retained = paperSafetyReads(retained, [], newer); newer = advance(structuredClone(newer)); }
  const reads = [...['status', 'wallet', 'positions', 'fills', 'executors', 'decisions', 'history'].map(section => advance(fixture(section))), newer];
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace, {reads, safetyReads:retained, complete:true, now:newer.generated_at_ms, reportAt:null, heartbeat:'Fresh', bot:older.bot_id}));
  assert.doesNotMatch(html, /Retained clock evidence conflicts|Clock evidence exceeds provider authority|Clock anomaly/i);
});

test('a NEW current emergency renders normally while reviewed clock anomalies remain published', () => {
  const newer = cleared(true);
  const controller = Object.keys(newer.data.controllers)[1];
  newer.data.controllers[controller].operator.emergency = true;
  const retained = paperSafetyReads([older], [], newer);
  const reads = [...['status', 'wallet', 'positions', 'fills', 'executors', 'decisions', 'history'].map(section => advance(fixture(section))), newer];
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace, {reads, safetyReads:retained, complete:true, now:newer.generated_at_ms, reportAt:null, heartbeat:'Fresh', bot:older.bot_id}));
  assert.deepEqual(retained, []);
  assert.match(html, /Emergency halt reported/);
  assert.match(html, new RegExp(`<h3>${controller}</h3>.*?Reported emergency halt: Yes`));
  assert.doesNotMatch(html, /Risk owner schema invalid|section is unavailable/);
});
