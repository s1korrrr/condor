import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAPER_DIMMED_MAX_MS, PAPER_SNAPSHOT_FRESH_MS, paperDimmedSnapshot } from '../src/v5/snapshot-presentation.ts';

const AT = Date.parse('2026-11-15T07:00:00Z');

test('a complete snapshot is dimmed only between the 30 s line and the 120 s cap (Falco option B)', () => {
  assert.equal(PAPER_SNAPSHOT_FRESH_MS, 30_000);
  assert.equal(PAPER_DIMMED_MAX_MS, 120_000);
  assert.deepEqual(paperDimmedSnapshot(AT, AT + 30_000), { dimmed: false, snapshotAt: null, judgedAt: AT + 30_000 });
  assert.deepEqual(paperDimmedSnapshot(AT, AT + 30_001), { dimmed: true, snapshotAt: AT, judgedAt: AT + 1_000 });
  assert.deepEqual(paperDimmedSnapshot(AT, AT + 120_000), { dimmed: true, snapshotAt: AT, judgedAt: AT + 1_000 });
  // Past the cap the values are withheld again by the normal stale rules at the real clock.
  assert.deepEqual(paperDimmedSnapshot(AT, AT + 120_001), { dimmed: false, snapshotAt: null, judgedAt: AT + 120_001 });
});

test('no snapshot, an invalid time or an owner clock ahead is never dimmed', () => {
  for (const value of [null, undefined, NaN, -1, 1.5, '1763190000000']) assert.equal(paperDimmedSnapshot(value, AT).dimmed, false);
  assert.deepEqual(paperDimmedSnapshot(AT + 60_000, AT), { dimmed: false, snapshotAt: null, judgedAt: AT });
});
