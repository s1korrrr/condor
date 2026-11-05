import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

// Sol round 2, R97-SOL-2 (oracle: review-97-r2-sol/latch-retention-oracle.mjs). A received native latch is a hold.
// A newer complete risk read that omits, nulls or malforms `latched` is unknown evidence, not a clear: the retained
// hold and "New acquisitions held" stay, and the view says the newer read did not publish the latch. Only an explicit
// boolean `latched === false` (with complete native evidence) in a qualified newer read clears it.
const fixture = Object.fromEntries(['status','wallet','positions','executors','fills','risk','decisions','history','operations'].map(section => [section, JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/${section}.json`, import.meta.url)))]));
const now = fixture.status.read_at_ms;
const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}]));
const {load} = frontendModules(stubs);
const policy = load('v5/policy.ts');
const {paperSafetyReads, paperSafetyBeyondDisplayed} = load('v5/paper-safety.ts');
const {PaperWorkspace} = load('pages/tabs/ActiveBotsTab.tsx');
const coherent = risk => Object.values(fixture).map(read => read.section === 'risk' ? risk : {...read, snapshot_id:risk.snapshot_id, generated_at_ms:risk.generated_at_ms});
const render = (risk, safetyReads = []) => renderToStaticMarkup(React.createElement(PaperWorkspace, {reads:coherent(risk), safetyReads, now, reportAt:fixture.status.generated_at_ms, heartbeat:'Fresh', bot:fixture.status.bot_id}));

const clear = structuredClone(fixture.risk);
Object.assign(clear.data, {holds:[], control_hold:null, native_entry_holds:[]});
for (const controller of Object.values(clear.data.controllers)) Object.assign(controller.operator, {paused:false, emergency:false}), Object.assign(controller.native, {entry_hold:false, latched:false});
const ids = Object.keys(clear.data.controllers);
const latched = structuredClone(clear);
latched.data.controllers[ids[0]].native.latched = true;
latched.snapshot_id += '-latched';
latched.source.sequence += 1;
const newer = flag => {
  const read = structuredClone(clear);
  read.snapshot_id += '-newer';
  read.source.sequence = latched.source.sequence + 1;
  if (flag === undefined) delete read.data.controllers[ids[0]].native.latched;
  else read.data.controllers[ids[0]].native.latched = flag;
  return read;
};

test('a received latch is retained as a hold', () => {
  assert.equal(paperSafetyReads([], [fixture.status, {...latched, snapshot_id:fixture.status.snapshot_id}]).length, 1);
});

for (const flag of [undefined, null, 'false']) {
  test(`a newer read with latched=${String(flag)} keeps the retained hold and says the latch was not published`, () => {
    const read = newer(flag);
    assert.equal(policy.paperSectionError(read), null, 'the payload is accepted, so the hold rule must decide');
    assert.equal(policy.paperRiskControllers(read, now).find(controller => controller.id === ids[0]).entryHold, null, 'unknown, never "No"');
    const safety = paperSafetyReads([latched], [], read);
    assert.equal(safety.length, 1, 'unknown latch evidence is not a clear');
    assert.equal(safety[0].data.controllers[ids[0]].native.latched, true);
    const html = render(read, paperSafetyBeyondDisplayed(safety, [read]));
    assert.match(html, /New acquisitions held/);
    assert.match(html, new RegExp(`<h3>${ids[0]}</h3>[^]*?Hold retained: the newer owner read did not publish the native latch\\.`));
  });
}

test('a qualified newer read with explicit latched=false clears the retained latch', () => {
  assert.deepEqual(paperSafetyReads([latched], [], newer(false)), []);
  assert.doesNotMatch(render(newer(false)), /New acquisitions held/);
});

test('unknown latch evidence on one controller does not keep another controller\'s cleared hold', () => {
  const twoHeld = structuredClone(latched);
  twoHeld.data.controllers[ids[1]].operator.paused = true;
  const read = newer(undefined);
  const safety = paperSafetyReads([twoHeld], [], read);
  assert.deepEqual(Object.keys(safety[0].data.controllers), [ids[0]], 'only the controller without explicit latch evidence stays');
});
