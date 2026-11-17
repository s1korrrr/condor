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
  try {
    new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  } catch (error) {
    cache.delete(path);
    throw error;
  }
  return module.exports;
}
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const viewFor = (envelope, state = 'ready', error = null) => ({ state, envelope, rows: envelope?.items ?? [], error, pageIndex: 0, hasNext: false, hasPrevious: false, snapshotChanged: error?.code === 'SNAPSHOT_CHANGED', expiresInMs: 1000, first() {}, previous() {}, next() {}, refresh() {} });

test('owner unavailable envelopes retain reasons and issues in every panel section', () => {
  const unavailable = fixture => ({ ...structuredClone(fixture), status: 'UNAVAILABLE', reason_codes: ['SOURCE_CHANGED'], items: [], issues: [{ code: 'SOURCE_CHANGED', record_id: null, detail: 'Owner source changed' }] });
  const { LearningPanel } = load('v5/LearningPanel.tsx');
  const { DecisionLineagePanel } = load('v5/DecisionLineagePanel.tsx');
  const lesson = render(LearningPanel, { view: viewFor(unavailable(fixtures.lessons), 'unavailable') });
  const lineage = render(DecisionLineagePanel, { nodeView: viewFor(unavailable(fixtures['records-nodes']), 'unavailable'), edgeView: viewFor(unavailable(fixtures['records-edges']), 'unavailable'), attemptView: viewFor(unavailable(fixtures.jobs), 'unavailable') });
  for (const html of [lesson, lineage]) {
    assert.match(html, /SOURCE_CHANGED/);
    assert.match(html, /Owner source changed/);
    assert.doesNotMatch(html, /could not be reached/);
  }
  assert.equal((lineage.match(/Owner source changed/g) ?? []).length, 3);
});

test('lineage sections clear independently and edge 409 offers First', () => {
  const { DecisionLineagePanel } = load('v5/DecisionLineagePanel.tsx');
  const html = render(DecisionLineagePanel, { nodeView: viewFor(fixtures['records-nodes']), edgeView: viewFor(fixtures['records-edges'], 'expired'), attemptView: viewFor(fixtures.jobs) });
  assert.ok(html.includes(fixtures['records-nodes'].items[0].record_id));
  assert.ok(html.includes(fixtures.jobs.items[0].record_id));
  assert.doesNotMatch(html, /edge:fixture-1/);
  const changed = render(DecisionLineagePanel, { edgeView: viewFor(null, 'unavailable', { status: 409, code: 'SNAPSHOT_CHANGED', retryable: true }) });
  assert.match(changed, /SNAPSHOT_CHANGED/);
  assert.match(changed, /First page/);
});

test('lesson reference previews preserve groups and shared completeness', () => {
  const { LearningPanel } = load('v5/LearningPanel.tsx');
  const data = structuredClone(fixtures.lessons);
  const row = data.items[0];
  row.contradictory_refs = [{ ...row.outcome_refs[0], record_id: 'contradiction:exact-123', kind: 'outcome' }];
  row.reference_total = 3;
  let html = render(LearningPanel, { data });
  assert.match(html, /2 of <span[^>]*title="3"[^>]*>3<\/span> shown/);
  assert.match(html, /Outcomes[\s\S]*decision:outcome:fixture-1[\s\S]*Contradicting records[\s\S]*contradiction:exact-123/);
  assert.doesNotMatch(html, /Evidence references/);
  row.reference_total = null;
  row.contradictory_refs = [];
  html = render(LearningPanel, { data });
  assert.match(html, /more may exist/i);
  assert.doesNotMatch(html, /Contradicting records<\/h3><span>None recorded/);
});

test('partial attempt reference preview never claims omitted artifacts are absent', () => {
  const { DecisionLineagePanel } = load('v5/DecisionLineagePanel.tsx');
  const attempts = structuredClone(fixtures.jobs);
  attempts.items[0].row_status = 'PARTIAL';
  attempts.items[0].reference_total = 2;
  const html = render(DecisionLineagePanel, { attempts });
  assert.match(html, /1 of <span[^>]*title="2"[^>]*>2<\/span> shown/);
  assert.doesNotMatch(html, /Artifacts<\/h4><span>None recorded/);
  assert.match(html, /more may exist/i);
});

test('historical scope, contradiction labels and partial reasons use plain words', () => {
  const { LearningPanel } = load('v5/LearningPanel.tsx');
  const data = structuredClone(fixtures.lessons);
  data.items[0].row_scope.recorded_scope.regimes = ['BEAR_ONLY'];
  data.reason_codes = ['CONTRADICTIONS_NOT_INDEXED', 'OMITTED_CONTENT'];
  let html = render(LearningPanel, { data });
  for (const expected of ['BEAR_ONLY', 'Contradictions not indexed: unknown, not none', 'Counter-evidence not indexed; recall not evaluated.', 'Preview shortened or scope details omitted; full recorded content remains in the source.']) assert.ok(html.includes(expected), expected);
  for (const [state, expected] of [['RECORDED', 'Contradictions recorded'], ['UNAVAILABLE', 'Contradictions unavailable: unknown, not none']]) {
    data.items[0].contradiction_state = state;
    html = render(LearningPanel, { data });
    assert.ok(html.includes(expected), expected);
  }
});

test('proposed count uses an owner title and idea revision registration is not readiness', () => {
  const { DecisionLineagePanel } = load('v5/DecisionLineagePanel.tsx');
  const nodes = structuredClone(fixtures['records-nodes']);
  nodes.items[0].kind = 'idea_revision';
  const edges = structuredClone(fixtures['records-edges']);
  edges.coverage.excluded_proposed_edges = 12345;
  const html = render(DecisionLineagePanel, { nodes, edges });
  assert.match(html, /title="12345"[^>]*>12345<\/span> proposed links not shown/);
  assert.match(html, /PROPOSED means registration, not readiness/);
});

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
  edges.items[0].to_ref = { owner: 'research_os', kind: 'secret-kind', record_id: 'opaque:12345678901234567890', revision: null, source_index: null, resolution: 'OUT_OF_SCOPE' };
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

test('recorded textual windows remain visible', () => {
  const { LearningPanel } = load('v5/LearningPanel.tsx');
  const data = structuredClone(fixtures.lessons);
  data.items[0].row_scope.recorded_scope.window = 'May–August 2026';
  assert.match(render(LearningPanel, { data }), /May–August 2026/);
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
