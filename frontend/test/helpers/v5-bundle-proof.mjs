import assert from 'node:assert/strict';

export function assertV5Bundle(built, observed) {
  assert.equal(observed.entryPath, built.entryPath, 'Evidence bundle entry must equal the built entry');
  assert.match(observed.entrySha256 ?? '', /^[a-f0-9]{64}$/, 'Evidence bundle SHA256 is required');
  assert.equal(observed.entrySha256, built.entrySha256, 'Evidence bundle bytes must equal the built bundle');
  assert.equal(observed.htmlSha256, built.htmlSha256, 'Evidence HTML must equal the built HTML');
}
