import test from 'node:test';
import assert from 'node:assert/strict';
import { paperWorkspaceLabel, paperReadiness } from '../src/v5/policy.ts';
import * as policy from '../src/v5/policy.ts';

test('paper routes select native read-only exports, not live fleet discovery', () => {
  assert.deepEqual(policy.paperWorkspaceReads('capital'), {presentation:'paper',paperReadUrl:'/api/v1/servers/rsibot-v5/account-balances',paperHistoryReadUrl:'/api/v1/servers/rsibot-v5/controller-performance/history',paperAccountingReadUrl:'/api/v1/servers/rsibot-v5/fleet/accounting'});
  assert.deepEqual(policy.paperWorkspaceReads('operations'), {presentation:'paper',paperReadUrl:'/api/v1/operations/workspace'});
  assert.deepEqual(policy.paperWorkspaceReads('tradepad'), {presentation:'paper'});
});

test('heartbeat cannot label missing, invalid or incoherent paper reads fresh', () => {
  assert.equal(policy.paperObservationSummary([], 'paper', Date.now()).label,'Unavailable');
  const now=1793275200000;
  const reads=['status','wallet','positions','executors','risk'].map(section=>({schema:'rsibot.v5-paper.read.v1',section,bot_id:'paper',execution_mode:'paper',simulated:true,state:'available',completeness:'complete',snapshot_id:'boot:1',generated_at_ms:now,data:['positions','executors'].includes(section)?[]:{}}));
  assert.equal(policy.paperObservationSummary(reads,'paper',now).label,'Available');
  for (const change of [{snapshot_id:'boot:2'},{state:'degraded',reason:'Owner export unavailable',data:null},{reason:{}},{completeness:'partial'}]) assert.notEqual(policy.paperObservationSummary(reads.map(read=>read.section==='risk'?{...read,...change}:read),'paper',now).label,'Available');
  assert.equal(policy.paperObservationSummary(reads,'paper',now+31000).label,'Stale');
});

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
  assert.equal(readiness.gates.filter(gate => gate.priority === 'P0').length, 4);
  assert.ok(readiness.gates.every(gate => gate.status === 'NOT_RUN' && gate.evidence === null));
});
