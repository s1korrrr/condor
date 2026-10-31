import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distHashes, verifyDist } from '../tooling/check-v5-reproducibility.mjs';

test('V5 reviewed artifact check rejects changed, missing and extra assets', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'v5-repro-test-'));
  writeFileSync(path.join(directory, 'entry.js'), 'reviewed');
  const manifest = { entry: 'entry.js', files: distHashes(directory) };
  manifest.entrySha256 = manifest.files[manifest.entry];
  assert.equal(verifyDist(directory, manifest).sha256, manifest.entrySha256);
  assert.throws(() => verifyDist(directory, { ...manifest, entrySha256: 'wrong' }));
  assert.throws(() => verifyDist(directory, { ...manifest, files: { ...manifest.files, 'missing.js': 'missing' } }));
  writeFileSync(path.join(directory, 'entry.js'), 'changed');
  assert.throws(() => verifyDist(directory, manifest));
  writeFileSync(path.join(directory, 'entry.js'), 'reviewed');
  writeFileSync(path.join(directory, 'extra.js'), 'unreviewed');
  assert.throws(() => verifyDist(directory, manifest));
});
