import test from 'node:test';
import assert from 'node:assert/strict';
import { paperWorkspaceLabel, paperReadiness } from '../src/v5/policy.ts';

test('configured paper identity separates simulated execution from advisor authority', () => {
  assert.equal(paperWorkspaceLabel({readiness:{paper_owner:{mode:'PAPER'}}}), 'PAPER · simulated wallet · live disabled · advisor reports only');
  assert.equal(paperWorkspaceLabel(undefined), null);
});

test('paper uptime cannot clear program P0s or economic support', () => {
  const readiness = paperReadiness({ready:true, state:'FRESH'});
  assert.equal(readiness.production, 'NOT_READY');
  assert.equal(readiness.live, 'DISABLED');
  assert.equal(readiness.economics, 'V5_NOT_SUPPORTED');
  assert.ok(readiness.openGates.length > 0);
});
