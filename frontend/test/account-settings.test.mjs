import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialFields, credentialPayload, missingCredentialFields } from '../src/lib/credential-fields.ts';
import { serverCapabilities, unavailableServerRoute } from '../src/lib/server-capabilities.ts';

const schema = {
  okx_api_key: { type: 'SecretStr', required: true, label: 'API key', default: 'must-not-prefill' },
  okx_secret_key: { type: 'SecretStr', required: true },
  okx_passphrase: { type: 'SecretStr', required: true },
  okx_registration_sub_domain: {
    type: 'Literal', required: true, default: 'my', enum: ['my'],
    options: [{ value: 'my', label: 'EU / EEA' }],
  },
};

test('credential schema preserves region default while never prefilling secrets', () => {
  const fields = credentialFields(schema);
  assert.equal(fields[0].label, 'API key');
  assert.equal(fields[0].isSecret, true);
  assert.equal(fields[0].defaultValue, '');
  assert.deepEqual(fields[3].options, [{ value: 'my', label: 'EU / EEA' }]);
  const values = { okx_api_key: 'key', okx_secret_key: 'secret', okx_passphrase: 'phrase', injected: 'discard' };
  assert.deepEqual(credentialPayload(fields, values), {
    okx_api_key: 'key', okx_secret_key: 'secret', okx_passphrase: 'phrase', okx_registration_sub_domain: 'my',
  });
  assert.deepEqual(missingCredentialFields(fields, values), []);
});

test('empty or unavailable schema and missing fields cannot become a ready credential form', () => {
  assert.deepEqual(credentialFields(undefined), []);
  assert.deepEqual(credentialFields({ wrong: null, alsoWrong: 'text' }), []);
  assert.deepEqual(missingCredentialFields(credentialFields(schema), {okx_api_key:'   '}), [
    'okx_api_key', 'okx_secret_key', 'okx_passphrase',
  ]);
  assert.deepEqual(missingCredentialFields(credentialFields(schema), {
    okx_api_key:'key',okx_secret_key:'secret',okx_passphrase:'phrase',okx_registration_sub_domain:'www',
  }), ['okx_registration_sub_domain']);
});

test('native account setup and balances do not imply manual trading or bot mutation', () => {
  const status = { status:'online', profile:'native', capabilities:{
    accounts:true,account_management:true,portfolio_read:true,manual_trading:false,native_status:true,
  }};
  const access = serverCapabilities(status);
  assert.equal(access.accountManagement, true);
  assert.equal(access.portfolioRead, true);
  assert.equal(access.manualTrading, false);
  assert.equal(access.botStop, false);
  assert.equal(unavailableServerRoute('/portfolio', status), null);
  assert.equal(typeof unavailableServerRoute('/trade', status), 'string');
  assert.equal(unavailableServerRoute('/bots', status), null);
});
