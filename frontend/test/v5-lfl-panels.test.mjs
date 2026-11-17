import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../src');
const require = createRequire(import.meta.url);
const fixtures = Object.fromEntries(['lessons', 'records-nodes', 'records-edges', 'jobs'].map(name => [name, JSON.parse(readFileSync(resolve(here, `fixtures/v5-lfl/${name}.json`), 'utf8'))]));
const cache = new Map();
function load(file) {
  const path = resolve(root, file);
  if (cache.has(path)) return cache.get(path).exports;
  const module = { exports: {} };
  cache.set(path, module);
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2023 } }).outputText;
  const localRequire = name => {
    if (name.endsWith('.css')) return {};
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name);
    const target = name.startsWith('@/') ? resolve(root, name.slice(2)) : resolve(dirname(path), name);
    const candidate = [target, `${target}.tsx`, `${target}.ts`, `${target}.mjs`].find(existsSync);
    if (!candidate) throw new Error(`Unresolved panel dependency ${name}`);
    return load(candidate);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test('golden lessons show historical owner evidence, not recall or a verdict', () => {
  const { LearningPanel } = load('v5/LearningPanel.tsx');
  const html = render(LearningPanel, { data: fixtures.lessons });
  for (const expected of ['Recorded fixture lesson', 'Historical', 'Recall: not evaluated', 'RESEARCH_PROCESS', 'PROVISIONAL', 'New contradictory evidence', 'CONTRADICTIONS_NOT_INDEXED', 'decision:lesson:fixture-1']) assert.ok(html.includes(expected), expected);
  assert.doesNotMatch(html, /Roles blocked|Knowledge releases|zero applied/i);
});

test('golden lineage shows separate explicit records and research attempts', () => {
  const { DecisionLineagePanel } = load('v5/DecisionLineagePanel.tsx');
  const html = render(DecisionLineagePanel, { nodes: fixtures['records-nodes'], edges: fixtures['records-edges'], attempts: fixtures.jobs });
  for (const expected of ['Research lineage', 'Native-action lineage: not published', 'edge:fixture-1', 'attempt_of', 'EXPLICIT', 'run:fixture-1', 'FAILED', 'not explicit assertions']) assert.ok(html.includes(expected), expected);
  assert.doesNotMatch(html, /Workflow lifecycle and usage|Full decision lineage/);
});

test('out-of-scope references remain opaque and unknown proposed counts are not zero', () => {
  const { DecisionLineagePanel } = load('v5/DecisionLineagePanel.tsx');
  const edges = structuredClone(fixtures['records-edges']);
  edges.coverage.excluded_proposed_edges = null;
  edges.items[0].to_ref = { owner: 'research_os', kind: 'secret-kind', record_id: 'opaque:12345678901234567890', revision: null, source_index: 0, resolution: 'OUT_OF_SCOPE' };
  const html = render(DecisionLineagePanel, { edges });
  assert.match(html, /opaque:12345678901234567890/);
  assert.doesNotMatch(html, /secret-kind/);
  assert.match(html, /unknown proposed links not shown/i);
});

test('panels do not read the old research fixture route', () => {
  for (const name of ['LearningPanel.tsx', 'DecisionLineagePanel.tsx']) {
    const source = readFileSync(resolve(root, `v5/${name}`), 'utf8');
    assert.doesNotMatch(source, /learningRead|learning\/research|research\?cursor/);
  }
});

test('partial lesson reports the owner issue and keeps long identifiers exact', () => {
  const { LearningPanel } = load('v5/LearningPanel.tsx');
  const data = structuredClone(fixtures.lessons);
  const id = 'decision:lesson:123456789012345678901234567890';
  data.items[0].record_id = id;
  const html = render(LearningPanel, { data });
  assert.match(html, /PARTIAL/);
  assert.match(html, /Counter-evidence is not indexed/);
  assert.ok(html.includes(id));
  assert.doesNotMatch(html, /1\.23456789e\+29/i);
  assert.match(html, /on this page/i);
});

test('unknown proposed count is not presented as an owner-measured zero', () => {
  const { DecisionLineagePanel } = load('v5/DecisionLineagePanel.tsx');
  const edges = structuredClone(fixtures['records-edges']);
  edges.coverage.excluded_proposed_edges = null;
  const html = render(DecisionLineagePanel, { edges });
  assert.match(html, /unknown proposed links not shown/i);
  assert.doesNotMatch(html, /0 proposed links not shown/i);
});

test('view renders fresh rows but clears them for expiry, warming and snapshot changes', () => {
  const { LearningPanel } = load('v5/LearningPanel.tsx');
  const view = { state: 'ready', envelope: fixtures.lessons, rows: fixtures.lessons.items, error: null, pageIndex: 0, hasNext: false, hasPrevious: false, snapshotChanged: false, expiresInMs: 1000, first() {}, previous() {}, next() {}, refresh() {} };
  assert.match(render(LearningPanel, { view }), /Recorded fixture lesson/);
  for (const [state, code] of [['expired', null], ['unavailable', 'WARMING'], ['unavailable', 'SNAPSHOT_CHANGED']]) {
    const unavailable = { ...view, state, error: code ? { status: code === 'SNAPSHOT_CHANGED' ? 409 : 503, code, retryable: true, snapshot_id: null, unauthenticated: false } : null, snapshotChanged: code === 'SNAPSHOT_CHANGED' };
    const html = render(LearningPanel, { view: unavailable });
    assert.match(html, /UNAVAILABLE/);
    if (code) assert.match(html, new RegExp(code));
    assert.doesNotMatch(html, /Recorded fixture lesson/);
  }
});
