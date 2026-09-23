import test from 'node:test'
import assert from 'node:assert/strict'
import { toFleetRow } from '../src/fleet/toFleetRow.mjs'

test('partial federation keeps available peers', () => {
  const rows = [
    toFleetRow({ bot_key: 'ok', identity: { authority_id: 'v2', stack_id: 'rsibot-stack-v2', bot_instance_id: '00000000-0000-4000-8000-000000000001' }, identity_verified: true }),
    toFleetRow({ bot_key: 'gap', identity: { authority_id: 'v1', stack_id: 'rsibot-stack', bot_instance_id: '00000000-0000-4000-8000-000000000002' }, identity_verified: false, reason_code: 'source_unavailable' }),
  ]
  assert.equal(rows[0].identityVerified, true)
  assert.equal(rows[1].reasonCode, 'source_unavailable')
})
