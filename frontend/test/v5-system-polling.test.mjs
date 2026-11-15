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
