import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceIntegrationEntry } from '../tooling/workspace-integration.ts';

test('public build uses its local unavailable entry regardless of adjacent source', () => {
  assert.equal(workspaceIntegrationEntry('/public/frontend'), '/public/frontend/src/features/workspace-monitoring/unavailable.tsx');
});
test('owner builds must opt in with an existing absolute entry and missing sources fail explicitly', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'condor-integration-'));
  try {
    const entry = path.join(directory, 'index.ts');
    writeFileSync(entry, 'export {};');
    assert.equal(workspaceIntegrationEntry('/public/frontend', entry), entry);
    assert.throws(() => workspaceIntegrationEntry('/public/frontend', './private/index.ts'), /existing absolute/);
    assert.throws(() => workspaceIntegrationEntry('/public/frontend', directory), /existing absolute/);
    assert.throws(() => workspaceIntegrationEntry('/public/frontend', path.join(directory, 'missing.ts')), /existing absolute/);
  } finally { rmSync(directory, {recursive:true}); }
});
