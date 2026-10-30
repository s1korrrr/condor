import test from 'node:test';
import assert from 'node:assert/strict';
import { assertV5Bundle } from './helpers/v5-bundle-proof.mjs';

test('visual evidence rejects an older entry name or mismatched bundle bytes', () => {
  const built = {entryPath:'/assets/v5-final.js',entrySha256:'a'.repeat(64),htmlSha256:'b'.repeat(64)};
  assert.doesNotThrow(() => assertV5Bundle(built, {...built}));
  for (const change of [{entryPath:'/assets/v5-old.js'}, {entrySha256:'c'.repeat(64)}, {htmlSha256:'d'.repeat(64)}, {entrySha256:undefined}]) {
    assert.throws(() => assertV5Bundle(built, {...built,...change}), /bundle|HTML/);
  }
});
