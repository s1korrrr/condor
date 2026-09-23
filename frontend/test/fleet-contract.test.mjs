import test from 'node:test'
import assert from 'node:assert/strict'
import { fleetQueryKey, sameNameCollision, clearForbiddenCache } from '../src/fleet/contracts.mjs'
import { toFleetRow } from '../src/fleet/toFleetRow.mjs'

test('query keys include authority stack bot and projection', () => {
  assert.deepEqual(fleetQueryKey({
    principal: 'ops', authorityId: 'rsibot-api-v2', stackId: 'rsibot-stack-v2',
    botInstanceId: '7c2e2a10-6d3a-4b91-8f11-0b6c4d2e1a01', session: 'boot-1', projection: 'equity',
  }), ['fleet', 'ops', 'rsibot-api-v2', 'rsibot-stack-v2', '7c2e2a10-6d3a-4b91-8f11-0b6c4d2e1a01', 'boot-1', 'equity'])
})

test('same display name on two stacks does not share cache identity', () => {
  const left = toFleetRow({
    bot_key: 'a', identity: { authority_id: 'v1', stack_id: 'rsibot-stack', bot_instance_id: '00000000-0000-4000-8000-000000000001' },
    display_name: 'RSI', catalogue_revision: 'r1',
  })
  const right = toFleetRow({
    bot_key: 'b', identity: { authority_id: 'v2', stack_id: 'rsibot-stack-v2', bot_instance_id: '00000000-0000-4000-8000-000000000001' },
    display_name: 'RSI', catalogue_revision: 'r2',
  })
  assert.equal(sameNameCollision({
    displayName: left.displayName, authorityId: left.authorityId, stackId: left.stackId, botInstanceId: left.botInstanceId,
  }, {
    displayName: right.displayName, authorityId: right.authorityId, stackId: right.stackId, botInstanceId: right.botInstanceId,
  }), true)
  assert.notDeepEqual(left.queryKey, right.queryKey)
})

test('revoked scope drops cached rows', () => {
  assert.deepEqual(clearForbiddenCache({ a: 1 }, 'ops', 'other'), {})
})
