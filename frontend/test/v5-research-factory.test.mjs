import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const base = new URL('../../condor/v5/schemas/learning_projection/', import.meta.url);
const load = relative => JSON.parse(readFileSync(new URL(relative, base), 'utf8'));
const golden = name => load(`examples/stage-b/${name}.json`);
const modules = frontendModules();
const validator = modules.load('v5/learning-projection-validate.ts');
const { FactoryDataset, FactoryStatus } = modules.load('v5/ResearchFactoryPanel.tsx');
const { ownerTitle } = modules.load('v5/format.mjs');
const render = (envelope, overrides = {}) => {
  const view = { state: envelope?.status === 'UNAVAILABLE' ? 'unavailable' : 'ready', envelope, rows: envelope?.items ?? [], first() {}, ...overrides };
  return renderToStaticMarkup(['manifest', 'records'].includes(envelope?.dataset)
    ? React.createElement(FactoryStatus, view)
    : React.createElement(FactoryDataset, { dataset: envelope?.dataset ?? 'campaigns', view }));
};

for (const entry of load('golden-index-stage-b.json').examples) {
  test(`validates and renders ${entry.path}`, async () => {
    const raw = readFileSync(new URL(entry.path, base), 'utf8');
    const document = validator.parseStrictJson(raw);
    assert.equal(validator.schemaError('browser-response-stage-b', document), null);
    await validator.validateEnvelope(document.dataset, document, {
      stageB: true, maxAgeMs: 90_000, nowMs: document.served_at_ms, recordType: entry.query.record_type,
      ideaRevisionId: entry.query.idea_revision_id,
    });
    const html = render(document);
    assert.match(html, new RegExp(document.status));
    if (document.status === 'UNAVAILABLE') {
      for (const reason of document.reason_codes) assert.ok(html.includes(reason));
      assert.doesNotMatch(html, /could not be reached/i);
    }
  });
}

test('missing seal is partial historical evidence, changed seal discloses only owner reasons', () => {
  const missing = render(golden('campaigns-real-scope')).replaceAll('&#x27;', "'");
  assert.ok(missing.includes("preregistration seal not found in this store snapshot; the campaign's plan could not be verified as frozen"));
  assert.match(missing, /PARTIAL/);
  assert.match(missing, /historical/i);
  const changed = render(golden('campaigns-seal-integrity-failure'));
  assert.match(changed, /UNAVAILABLE.*SOURCE_CHANGED/);
  assert.doesNotMatch(changed, /seal not found|could not be reached/);
});

test('candidates register, never claim a verdict or missing references', () => {
  const document = golden('candidates-real-scope');
  const html = render(document);
  assert.match(html, /PROPOSED.*registered/i);
  assert.match(html, /not published/i);
  assert.match(html, /execution permission.*NONE/i);
  assert.match(html, /shortened/i);
  assert.match(html, /more may exist/);
  assert.doesNotMatch(html, /verdict/i);
  assert.ok(html.includes(document.items[0].idea_revision_id));
});

test('empty, qualified, and whole-omission assessment presentation', () => {
  assert.match(render(golden('assessments-real-scope-empty')), /no recorded assessments for this revision/);
  const document = golden('assessments-wide-conditions-synthetic');
  const assessmentSchema = load('stage-b-common.schema.json');
  const hurdle = assessmentSchema.$defs.Assessment.properties.hurdle_status.enum[0];
  document.items[0].hurdle_status = hurdle;
  const html = render(document);
  for (const value of ['SUPPORTED', 'VALID', 'ISOLATED', hurdle, ownerTitle(document.items[0].comparison.delta)]) {
    assert.ok(html.includes(value), value);
  }
  const omitted = render(golden('assessments-omitted-comparison'));
  assert.match(omitted, /content was omitted/i);
  assert.doesNotMatch(omitted, /SUPPORTED/);
});

test('typed failures have no rows; 409 offers first, warming and expiry are explicit', () => {
  assert.match(render(null, { state: 'unavailable', error: { code: 'SNAPSHOT_CHANGED' } }), /SNAPSHOT_CHANGED.*First page/);
  assert.match(render(null, { state: 'unavailable', error: { code: 'WARMING' } }), /WARMING/);
  assert.match(render(null, { state: 'unauthenticated' }), /Signed out/);
  assert.match(render(null, { state: 'expired' }), /Expired/);
});

test('Factory page cannot read fixtures or import fixture UI', () => {
  const text = readFileSync(new URL('../src/v5/ResearchFactoryPanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /learningRead|\/learning\/research|from ['"].\/LearningPanel['"]|\bfetch\(/);
});
