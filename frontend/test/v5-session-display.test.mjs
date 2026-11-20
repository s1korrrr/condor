import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionKindLabel, sessionSummaryText } from '../src/v5/session-display.mjs';

test('each row is labelled from its kind, and an unknown or missing kind is not guessed', () => {
  assert.equal(sessionKindLabel({ kind: 'inspect', loop_id: null }), 'Source inspection');
  assert.equal(sessionKindLabel({ kind: 'report', loop_id: null }), 'Report');
  assert.equal(sessionKindLabel({ kind: 'loop', loop_id: 'market_analyst_monitor' }), 'Report loop · market_analyst_monitor');
  assert.equal(sessionKindLabel({ kind: 'loop', loop_id: null }), 'Report loop');
  assert.equal(sessionKindLabel({ kind: 'report', loop_id: 'x' }), 'Report', 'a loop id never turns a report into a loop');
  for (const row of [{ loop_id: null }, { kind: 'bogus' }, { kind: null }, { kind: 'toString' }, null]) assert.equal(sessionKindLabel(row), 'Kind not reported');
});

test('old summaries: availability epoch ms becomes a UTC time and ready=True/False becomes plain words', context => {
  context.mock.method(Date, 'now', () => 1793929900000); // 6 Nov 2026: the year is omitted for 2026 times
  assert.equal(sessionSummaryText('Inspected source snapshot snap-1; availability=1793467481251'), 'Inspected source snapshot snap-1; available 31 Oct 17:24 UTC');
  assert.equal(sessionSummaryText('Inspected source snapshot snap-1; availability=123456'), 'Inspected source snapshot snap-1; available 1 Jan 1970 00:02 UTC');
  assert.equal(sessionSummaryText('Inspected paper status helm_v5_paper; ready=True; controllers=3; mode=PAPER (simulated wallet)'), 'Inspected paper status helm_v5_paper; ready; controllers=3; mode=PAPER (simulated wallet)');
  assert.equal(sessionSummaryText('Inspected paper status helm_v5_paper; ready=False; controllers=0; mode=PAPER (simulated wallet)'), 'Inspected paper status helm_v5_paper; not ready; controllers=0; mode=PAPER (simulated wallet)');
});

test('only the two exact patterns are rewritten; everything else is shown exactly as stored', () => {
  for (const text of [
    'Inspected source snapshot s; availability=unavailable',
    'Inspected paper status b; ready=None; controllers=1; mode=PAPER (simulated wallet)',
    'Inspected source snapshot s; availability=99999999999999999999',
    'Inspected source snapshot s; availability=12abc',
    'Inspected paper status ready=True; controllers=1',
    'Inspected source snapshot s; ready=true',
    'Source inspection started', '', 'Blocked: no fresh read-only V5 paper owner status',
  ]) assert.equal(sessionSummaryText(text), text, text);
  assert.equal(sessionSummaryText(undefined), undefined);
  assert.equal(sessionSummaryText(null), null);
});
