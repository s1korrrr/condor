import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { replacementServer } = frontendModules().load('lib/server-selection.ts');
const servers = [{ name: 'rsibot-stack-v2', online: true }];

test('a retired saved server is replaced by the first online server', () => {
  assert.equal(replacementServer('native-ok-rsi', servers), 'rsibot-stack-v2');
  assert.equal(replacementServer(null, servers), 'rsibot-stack-v2');
});

test('a known selection, an unread list or no online server changes nothing', () => {
  assert.equal(replacementServer('rsibot-stack-v2', servers), null);
  assert.equal(replacementServer('native-ok-rsi', undefined), null);
  assert.equal(replacementServer('native-ok-rsi', []), null);
  assert.equal(replacementServer('native-ok-rsi', [{ name: 'rsibot-stack-v2', online: false }]), null);
});
