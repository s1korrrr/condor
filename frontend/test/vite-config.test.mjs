import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));

test('native config loader resolves public aliases without bundled CommonJS globals', async () => {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(root, 'vite.config.ts'), root, 'silent', undefined, 'native');
  assert.ok(loaded);
  assert.equal(loaded.config.resolve.alias['@'], path.join(root, 'src'));
  assert.equal(loaded.config.resolve.alias['@workspace-monitoring'], path.join(root, 'src/features/workspace-monitoring/unavailable.tsx'));
  assert.equal(loaded.config.build.chunkSizeWarningLimit, 600);
});

test('native config loader preserves explicit owner integration selection', async () => {
  const previous = process.env.CONDOR_WORKSPACE_ENTRY;
  const entry = path.join(root, 'src/main.tsx');
  process.env.CONDOR_WORKSPACE_ENTRY = entry;
  try {
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(root, 'vite.config.ts'), root, 'silent', undefined, 'native');
    assert.equal(loaded.config.resolve.alias['@workspace-monitoring'], entry);
  } finally {
    if (previous === undefined) delete process.env.CONDOR_WORKSPACE_ENTRY;
    else process.env.CONDOR_WORKSPACE_ENTRY = previous;
  }
});

test('production chunks remain bounded without eagerly importing chart vendors', async () => {
  const { build } = await import('vite');
  const result = await build({ root, build: { write: false }, logLevel: 'error' });
  const chunks = new Map(result.output.filter(item => item.type === 'chunk').map(chunk => [chunk.fileName, chunk]));
  const reached = new Set();
  function visit(chunk) {
    if (reached.has(chunk.fileName)) return;
    reached.add(chunk.fileName);
    for (const dependency of chunk.imports) if (chunks.has(dependency)) visit(chunks.get(dependency));
  }
  for (const chunk of chunks.values()) {
    assert.ok(Buffer.byteLength(chunk.code) <= 600 * 1000, `${chunk.fileName} exceeds the existing size budget`);
    if (chunk.isEntry) visit(chunk);
  }
  const initialModules = [...reached].flatMap(name => Object.keys(chunks.get(name).modules));
  assert.ok(!initialModules.some(id => /node_modules\/(recharts|lightweight-charts)\//.test(id)), 'chart-only libraries must retain demand loading');
});
