import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

test('paper snapshot polling defaults to 15 seconds and can be paused per observer', () => {
  const options = [];
  const cache = { getQueryCache: () => ({ find: () => undefined }) };
  const { load } = frontendModules({
    react: { useRef: value => ({ current: value }), useState: value => [value, () => {}] },
    '@tanstack/react-query': {
      useQueryClient: () => cache,
      useQuery: value => { options.push(value); return { data: undefined, isFetching: false }; },
    },
  });
  const { usePaperSnapshot } = load('v5/usePaperSnapshot.ts');
  usePaperSnapshot(['default'], true, 1, async () => null);
  usePaperSnapshot(['system'], true, 1, async () => null, false);
  assert.equal(options[0].refetchInterval, 15_000);
  assert.equal(options[1].refetchInterval, false);
  assert.equal(options[1].enabled, true);
});

test('System observation uses a separate cache and can pause without stopping the global observer', () => {
  const calls = [];
  const {load} = frontendModules({
    './usePaperClock': {usePaperClock: () => 1_000_000},
    './usePaperSnapshot': {usePaperSnapshot: (key, enabled, total, load, interval) => {calls.push({key,enabled,total,interval}); return {reads:[],journalReads:[],complete:false,isPending:true,isFetching:false,isError:false};}},
  });
  const {usePaperObservation} = load('v5/usePaperObservation.ts');
  usePaperObservation('paper');
  usePaperObservation('paper', false, 'system');
  assert.deepEqual(calls[0].key, ['v5-paper-observation-health','paper']);
  assert.deepEqual(calls[1].key, ['v5-paper-observation-health','paper','system']);
  assert.equal(calls[0].interval, 15_000);
  assert.equal(calls[1].interval, false);
});
