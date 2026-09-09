import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDeploymentPolicy, requireSettingsMutation } from '../src/lib/deployment-policy.ts';

test('unknown and malformed policies cannot become write authority', () => {
  for (const value of [undefined, null, {}, {read_only:false}, {read_only:true,settings_mutation:'false',account_management:true,native_lifecycle:true}]) {
    assert.throws(() => parseDeploymentPolicy(value), /unavailable/);
  }
  assert.throws(() => parseDeploymentPolicy({read_only:true,settings_mutation:true,account_management:true,native_lifecycle:true}), /inconsistent/);
  assert.throws(() => requireSettingsMutation(false), /unavailable/);
});

test('credential and native lifecycle exceptions do not enable settings writes', () => {
  const value = {read_only:true,settings_mutation:false,account_management:true,native_lifecycle:true};
  assert.deepEqual(parseDeploymentPolicy(value), value);
  assert.throws(() => requireSettingsMutation(value.settings_mutation));
  assert.doesNotThrow(() => requireSettingsMutation(parseDeploymentPolicy({...value,read_only:false,settings_mutation:true}).settings_mutation));
});
