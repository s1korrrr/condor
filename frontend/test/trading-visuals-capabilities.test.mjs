import test from 'node:test';
import assert from 'node:assert/strict';
import { serverCapabilities, unavailableServerRoute } from '../src/lib/server-capabilities.ts';

const native = { status:'online', profile:'native', capabilities:{ accounts:false, executor_management:false, docker:false, native_status:true, native_controls_enabled:false, native_stop:false } };

test('native bot reads do not require accounts and unsupported routes explain their boundary', () => {
  const access = serverCapabilities(native);
  assert.equal(access.botRead, true);
  assert.equal(access.accounts, false);
  assert.equal(unavailableServerRoute('/bots', native), null);
  assert.equal(unavailableServerRoute('/trading-visuals', native), null);
  for (const route of ['/portfolio', '/trade', '/executors', '/executors/example']) assert.equal(typeof unavailableServerRoute(route, native), 'string');
  assert.equal(unavailableServerRoute('/trade-example', native), null);
  for (const key of ['deployment', 'botStop', 'controllerMutation']) assert.equal(access[key], false);
});

test('native controls require both flags and do not enable unsupported Docker or controller operations', () => {
  const enabled = {...native, capabilities:{...native.capabilities, native_controls_enabled:true, native_stop:true}};
  assert.equal(serverCapabilities(enabled).botStop, true);
  assert.equal(serverCapabilities({...enabled, capabilities:{...enabled.capabilities, native_controls_enabled:false}}).botStop, false);
  assert.equal(serverCapabilities(enabled).controllerMutation, false);
  assert.equal(serverCapabilities(enabled).deployment, false);
  assert.equal(serverCapabilities({status:'online', profile:'native'}).botRead, false);
});

test('only a verified full profile retains management routes; unknown or offline status grants no mutation', () => {
  for (const full of [{status:'online', profile:'full'}]) {
    const access = serverCapabilities(full);
    for (const key of ['accounts', 'executors', 'deployment', 'botRead', 'botStop', 'controllerMutation']) assert.equal(access[key], true);
    for (const route of ['/portfolio', '/trade', '/executors', '/bots']) assert.equal(unavailableServerRoute(route, full), null);
  }
  for (const offline of [undefined, {status:'online'}, {status:'online', profile:'unexpected'}, {...native,status:'error'}]) {
    const access = serverCapabilities(offline);
    for (const key of ['accounts', 'executors', 'deployment', 'botRead', 'botStop', 'controllerMutation']) assert.equal(access[key], false);
    assert.equal(typeof unavailableServerRoute('/bots', offline), 'string');
    assert.equal(unavailableServerRoute('/trading-visuals', offline), null);
  }
});

test('unknown capabilities and native profiles cannot mount automation routes', () => {
  for (const status of [undefined, {status:'online'}, native]) {
    for (const route of ['/agents', '/agents/example', '/routines', '/backtest', '/archived']) {
      assert.equal(typeof unavailableServerRoute(route, status), 'string');
    }
  }
});

test('controller history requires the native flag or a verified full profile', () => {
  assert.equal(serverCapabilities(native).controllerHistory, false);
  assert.equal(serverCapabilities({...native,capabilities:{...native.capabilities,performance_history:true}}).controllerHistory, true);
  assert.equal(serverCapabilities({status:'online',profile:'full'}).controllerHistory, true);
  assert.equal(serverCapabilities({status:'online'}).controllerHistory, false);
});
