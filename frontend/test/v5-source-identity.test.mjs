import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../tooling/check-v5-source-identity.mjs', import.meta.url));
const workspace = 'a'.repeat(40);
const condor = 'b'.repeat(40);
const staged = { workspace_commit: workspace, condor_gitlink: condor };
const args = { WORKSPACE_SOURCE_COMMIT: workspace, CONDOR_SOURCE_COMMIT: condor };

test('source identity requires both full build arguments to match the staged pair', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-source-identity-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'source-identity.json');
  const run = (env = args) => spawnSync(process.execPath, [script, file], { env, encoding: 'utf8' });

  function refuses(result, reason, env = args) {
    assert.equal(result.status, 1, result.stderr);
    for (const key of Object.keys(args)) {
      assert.ok(result.stderr.includes(`${key}=${JSON.stringify(env[key]) ?? '(missing)'}`), result.stderr);
    }
    assert.match(result.stderr, reason);
  }

  refuses(run(), /ENOENT.*source-identity\.json/);
  writeFileSync(file, JSON.stringify(staged));
  assert.equal(run().status, 0);
  for (const key of Object.keys(args)) {
    const missing = { ...args };
    delete missing[key];
    refuses(run(missing), /full 40-hex commits/, missing);
    const short = { ...args, [key]: args[key].slice(0, 8) };
    refuses(run(short), /full 40-hex commits/, short);
  }
  for (const key of Object.keys(staged)) {
    writeFileSync(file, JSON.stringify({ ...staged, [key]: 'c'.repeat(40) }));
    refuses(run(), /workspace_commit=.*condor_gitlink=.*must match/);
  }
  writeFileSync(file, '{');
  refuses(run(), /JSON/);
});
