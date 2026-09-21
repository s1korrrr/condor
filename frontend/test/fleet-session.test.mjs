import test from 'node:test'
import assert from 'node:assert/strict'
import { fleetQueryKey, clearForbiddenCache } from '../src/fleet/contracts.mjs'

test('session change is a different cache row', () => {
  const first = fleetQueryKey({
    principal: 'ops', authorityId: 'rsibot-api-v2', stackId: 'rsibot-stack-v2',
    botInstanceId: '7c2e2a10-6d3a-4b91-8f11-0b6c4d2e1a01', session: 'boot-1', projection: 'equity',
  })
  const second = fleetQueryKey({
    principal: 'ops', authorityId: 'rsibot-api-v2', stackId: 'rsibot-stack-v2',
    botInstanceId: '7c2e2a10-6d3a-4b91-8f11-0b6c4d2e1a01', session: 'boot-2', projection: 'equity',
  })
  assert.notDeepEqual(first, second)
})

test('same principal keeps cache until scope changes', () => {
  assert.deepEqual(clearForbiddenCache({ a: 1 }, 'ops', 'ops'), { a: 1 })
})
