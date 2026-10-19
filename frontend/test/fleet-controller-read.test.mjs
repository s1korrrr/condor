import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { frontendModules } from './helpers/frontend-module.mjs';

const require = createRequire(import.meta.url);
const { QueryClient } = require('@tanstack/react-query');
const now = Date.parse('2026-10-19T12:00:00Z');
const current = () => ({
  server_online: true,
  bots: [{ bot_name: 'v2', status: 'running', num_controllers: 1, controller_count_current: true,
    status_received_at: now / 1000 - 1, status_stale_after_seconds: 30,
    performance_received_at: now / 1000 - 1, performance_stale_after_seconds: 30 }],
  controllers: [{ bot_name: 'v2', controller_id: 'core', trading_pair: 'ETH-USDC',
    realized_pnl_quote: 1.2, unrealized_pnl_quote: 0.8, global_pnl_quote: 2, volume_traded: 15 }],
});

test('the current controller hook rejects offline HTTP200, fences cached values and recovers', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let response = { ok: true, status: 200, json: async () => current() };
  let options;
  const { load } = frontendModules({
    react: { useMemo: calculate => calculate() },
    '@tanstack/react-query': { useQuery: spec => {
      options = spec;
      const state = client.getQueryState(spec.queryKey);
      return { data: state?.data, isError: state?.status === 'error' };
    } },
    '@/lib/auth-token': { authFetch: async () => response },
  });
  const hook = load('features/quant-ops/fleet-reads.ts').useFleetControllerPnl;
  const view = () => hook('native', ['v2'], now);
  try {
    assert.equal(view().failed, false, 'initial absence is not a failed request');
    await client.fetchQuery(options);
    assert.equal(view().views.v2.total, 2);
    response = { ...response, json: async () => ({ server_online: false, error_hint: 'Connection error: fixture', bots: [], controllers: [] }) };
    await assert.rejects(client.fetchQuery(options), /controller.*unavailable/i);
    assert.equal(view().failed, true);
    assert.equal(view().views.v2.total, null, 'old successful economics are withheld after a failed current read');
    response = { ...response, json: async () => current() };
    await client.fetchQuery(options);
    assert.equal(view().failed, false);
    assert.equal(view().views.v2.total, 2);
    response = { ...response, json: async () => ({ server_online: true, bots: [], controllers: [] }) };
    await client.fetchQuery(options);
    assert.equal(view().failed, false, 'a successful empty owner read is distinct from offline');
    assert.equal(view().views.v2.total, null);
    response = { ...response, ok: false, status: 503 };
    await assert.rejects(client.fetchQuery(options), /503/);
    assert.equal(view().failed, true);
  } finally {
    client.clear();
  }
});
