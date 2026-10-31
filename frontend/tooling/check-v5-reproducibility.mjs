import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function distHashes(directory) {
  const result = {};
  function visit(relative) {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const name = path.posix.join(relative, entry.name);
      assert(!entry.isSymbolicLink(), `Unexpected dist symlink: ${name}`);
      if (entry.isDirectory()) visit(name);
      else result[name] = createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex');
    }
  }
  visit('');
  return result;
}

export function verifyDist(directory, manifest) {
  const actual = distHashes(directory);
  assert.deepEqual(actual, manifest.files, 'V5 dist differs from the reviewed manifest');
  assert.equal(actual[manifest.entry], manifest.entrySha256, 'V5 entry differs from the reviewed hash');
  return { entry: manifest.entry, sha256: actual[manifest.entry], files: Object.keys(actual).length };
}

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory, firstWorkspace, secondWorkspace = firstWorkspace] = process.argv.slice(2);
  assert(directory && ['verify', 'rebuild'].includes(mode), 'Usage: check-v5-reproducibility.mjs verify DIST | rebuild NEW_OUTPUT WORKSPACE [SECOND_WORKSPACE]');
  const manifest = JSON.parse(readFileSync(path.join(frontend, 'v5-reviewed-build.json'), 'utf8'));
  if (mode === 'verify') console.log(JSON.stringify(verifyDist(directory, manifest)));
  else {
    assert(firstWorkspace && path.isAbsolute(firstWorkspace) && path.isAbsolute(secondWorkspace), 'Absolute workspace roots required');
    mkdirSync(directory, { recursive: false });
    const require = createRequire(path.join(frontend, 'package.json'));
    const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
    for (const [index, workspace] of [firstWorkspace, secondWorkspace].entries()) {
      const output = path.resolve(directory, `build-${index + 1}`);
      const result = spawnSync(process.execPath, [vite, 'build', '--config', path.join(frontend, 'vite.v5.config.ts'), '--outDir', output, '--emptyOutDir', 'false'], {
        cwd: frontend, env: { ...process.env, V5_WORKSPACE_ROOT: workspace }, stdio: 'inherit',
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `V5 build ${index + 1} failed`);
      console.log(JSON.stringify({ build: index + 1, workspace, ...verifyDist(output, manifest) }));
    }
  }
}
