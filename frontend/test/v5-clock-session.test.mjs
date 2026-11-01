import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import fs from 'node:fs';
import {frontendModules} from './helpers/frontend-module.mjs';
import {PAPER_FUTURE_SKEW_MS, paperSnapshotPresentation} from '../src/v5/snapshot-presentation.ts';
import {paperReadState, paperTime} from '../src/v5/policy.ts';
import {createPaperClock} from '../src/v5/usePaperClock.ts';

function clockSession() {
  let slot;
  const {load} = frontendModules({react:{...React,
    useState:initial => { slot ??= typeof initial === 'function' ? initial() : initial; return [slot,() => {}]; },
    useSyncExternalStore:(_subscribe,_snapshot,serverSnapshot) => serverSnapshot(),
  }});
  const {usePaperClock} = load('v5/usePaperClock.ts');
  return now => {
    const realNow = Date.now; Date.now = () => now;
    try { return usePaperClock(); } finally { Date.now = realNow; }
  };
}

test('shared clock preserves millisecond precision at the freshness boundary', () => {
  const clock = clockSession();
  assert.equal(clock(1793268030999),1793268030999);
});

test('page-session clock high-water mark never regresses from 45 s to 25 s', () => {
  const clock = clockSession(), at = 1793268000000;
  assert.equal(clock(at + 45000),at + 45000);
  assert.equal(clock(at + 25000),at + 45000);
  assert.equal(paperSnapshotPresentation(at,clock(at + 25000),true).stale,true);
  assert.equal(clock(at + 61000),at + 61000);
});

test('shared snapshot label rejects future skew and uses compact ages', () => {
  const now = 1793268000000;
  const future = paperSnapshotPresentation(now + 5001,now,false);
  assert.equal(future.stale,true);
  assert.match(future.label,/owner clock ahead; not current/);
  assert.doesNotMatch(future.label,/0s? old|0 s old/);
  assert.match(paperSnapshotPresentation(now - 176400000,now,false).label,/2d 1h/);
});

test('fresh snapshot wording does not flip on each background refresh', () => {
  const now = 1793268000000;
  assert.equal(paperSnapshotPresentation(now - 10000,now,false).label,paperSnapshotPresentation(now - 10000,now,true).label);
});

test('snapshot, owner-read state and timestamp display share exact skew and age boundaries', () => {
  const read = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/paper-api-final3/native-replay/wallet.json',import.meta.url)));
  const at = read.generated_at_ms;
  for (const delta of [0,PAPER_FUTURE_SKEW_MS,PAPER_FUTURE_SKEW_MS + 1]) {
    const snapshot = {...read,generated_at_ms:at + delta};
    const invalid = delta > PAPER_FUTURE_SKEW_MS;
    assert.equal(paperSnapshotPresentation(snapshot.generated_at_ms,at,false).clockAhead,invalid);
    assert.equal(paperReadState(snapshot,at),invalid ? 'degraded' : 'available');
    assert.equal(paperTime(snapshot.generated_at_ms,at) === 'Not published',invalid);
  }
  for (const age of [30000,30001,30999]) {
    assert.equal(paperSnapshotPresentation(at,at + age,false).stale,age > 30000);
    assert.equal(paperReadState(read,at + age),age > 30000 ? 'stale' : 'available');
  }
  const server = fs.readFileSync(new URL('../../condor/v5/paper.py',import.meta.url),'utf8');
  assert.equal(PAPER_FUTURE_SKEW_MS,Number(server.match(/^FUTURE_SKEW_SECONDS = (\d+)$/m)[1]) * 1000);
});

test('focus and visibility sample the monotonic clock and unsubscribe cleanly', () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const windowTarget = new EventTarget(), documentTarget = new EventTarget();
  let tick, cleared = false, now = 1793268000000, notifications = 0;
  windowTarget.setInterval = callback => {tick = callback; return 17;};
  windowTarget.clearInterval = timer => {assert.equal(timer,17); cleared = true;};
  globalThis.window = windowTarget; globalThis.document = documentTarget;
  try {
    const clock = createPaperClock(() => now), unsubscribe = clock.subscribe(() => notifications++);
    now += 30999;
    windowTarget.dispatchEvent(new Event('focus'));
    assert.equal(clock.getSnapshot(),now);
    now -= 6000;
    tick();
    assert.equal(clock.getSnapshot(),1793268030999);
    now += 60000;
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(clock.getSnapshot(),now);
    unsubscribe();
    const before = notifications;
    windowTarget.dispatchEvent(new Event('focus'));
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(notifications,before);
    assert.equal(cleared,true);
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});

test('one shared clock interval serves all subscriptions and survives a zero-subscriber gap', () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const browser = new EventTarget();
  let intervals = 0, cleared = 0, now = 1793268045000;
  browser.setInterval = () => ++intervals;
  browser.clearInterval = () => cleared++;
  globalThis.window = browser; globalThis.document = new EventTarget();
  try {
    const clock = createPaperClock(() => now);
    const first = clock.subscribe(() => {}), second = clock.subscribe(() => {});
    assert.equal(intervals,1);
    first(); assert.equal(cleared,0);
    second(); assert.equal(cleared,1);
    now -= 30000;
    const remounted = clock.subscribe(() => {});
    assert.equal(intervals,2);
    assert.equal(clock.getSnapshot(),1793268045000);
    remounted(); assert.equal(cleared,2);
  } finally {globalThis.window = previousWindow; globalThis.document = previousDocument;}
});
