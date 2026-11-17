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
const projection = modules.load('v5/learning-projection.ts');
const { ProjectionStore } = modules.load('v5/learning-projection-store.ts');
const { AssessmentTraversal } = modules.load('v5/factory-assessment-relationships.ts');
const { FactoryDataset, FactoryStatus } = modules.load('v5/ResearchFactoryPanel.tsx');
const scope = golden('manifest').scope;
const membership = { program_id: scope.program_id, family_lane_pairs: scope.family_lane_pairs };
const session = projectionRevision => ({
  authenticated: true, learning_scope_id: scope.scope_id, learning_scope_membership: membership,
  learning_scope_sha256: scope.scope_sha256, learning_projection_revision: projectionRevision,
});
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
      stageB: true, maxAgeMs: 90_000, recordType: entry.query.record_type,
      scopeId: scope.scope_id, scopeSha256: scope.scope_sha256, membership,
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
  document.items[0].comparison.delta = '-1655.377097372744015183632563';
  const html = render(document);
  for (const value of ['SUPPORTED', 'VALID', 'ISOLATED', hurdle]) {
    assert.ok(html.includes(value), value);
  }
  assert.match(html, /title="≈ −1655\.377097372744 \(rounded\)">/);
  assert.doesNotMatch(html, /1655\.377097372744015183632563/);
  document.items[0].comparison.delta = '-1.23987654321';
  assert.match(render(document), /title="-1\.23987654321">−1\.24</);
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

test('Stage B browser reads use the non-projection config and send the exact assessment filter', async () => {
  const document = golden('assessments-supported');
  const revision = document.items[0].idea_revision_id;
  const config = session(document.projection_revision);
  const urls = [];
  const fetcher = async url => {
    urls.push(url);
    return Response.json(url === '/api/v5/auth' ? config : document);
  };
  assert.equal((await projection.readProjectionResult('assessments', { idea_revision_id: revision }, undefined, fetcher)).ok, true);
  assert.deepEqual(urls, ['/api/v5/auth', `/api/v5/learning/assessments?scope_id=v5-okx-spot-dca&idea_revision_id=${encodeURIComponent(revision)}`]);
  config.learning_scope_membership = { ...membership, program_id: 'foreign-program' };
  const wrongMembership = await projection.readProjectionResult('assessments', { idea_revision_id: revision }, undefined, fetcher);
  assert.equal(wrongMembership.error.code, 'INVALID_OWNER_PROJECTION');
  config.learning_scope_membership = undefined;
  urls.length = 0;
  const missingMembership = await projection.readProjectionResult('assessments', { idea_revision_id: revision }, undefined, fetcher);
  assert.equal(missingMembership.error.code, 'INVALID_OWNER_PROJECTION');
  assert.deepEqual(urls, ['/api/v5/auth']);
  config.learning_scope_membership = membership;
  config.learning_scope_sha256 = 'f'.repeat(64);
  const wrongScope = await projection.readProjectionResult('assessments', { idea_revision_id: revision }, undefined, fetcher);
  assert.equal(wrongScope.error.code, 'INVALID_OWNER_PROJECTION');
  config.learning_projection_revision = undefined;
  const mixedStage = await projection.readProjectionResult('assessments', { idea_revision_id: revision }, undefined, fetcher);
  assert.equal(mixedStage.error.code, 'INVALID_OWNER_PROJECTION');
});

test('Stage B browser status-only manifests and typed errors keep owner facts', async () => {
  const document = golden('manifest-unavailable');
  const config = session(document.projection_revision);
  const responses = [Response.json(document), Response.json(load('examples/errors/PUBLICATION_UNAVAILABLE.json'), { status: 503 })];
  const fetcher = async url => url === '/api/v5/auth' ? Response.json(config) : responses.shift();
  const manifest = await projection.readProjectionResult('manifest', {}, undefined, fetcher);
  assert.equal(manifest.ok, true);
  assert.match(render(manifest.envelope), /UNAVAILABLE.*NOT_PUBLISHED/);
  const result = await projection.readProjectionResult('campaigns', {}, undefined, fetcher);
  assert.equal(result.error.code, 'PUBLICATION_UNAVAILABLE');
});

test('Stage B one-shot reads share generation retirement and never return stale rows', async () => {
  const { readProjectionResult } = frontendModules().load('v5/learning-projection.ts');
  const candidate = golden('candidates-real-scope');
  const campaign = golden('campaigns-real-scope');
  const reseal = async (document, overrides) => {
    const result = { ...document, ...overrides };
    delete result.envelope_sha256;
    const { schema, projection_revision, publication_sha256, database_sha256, source_revision, source_snapshot, event_signature } = result;
    result.snapshot_id = await validator.sha256Hex(validator.canonicalJson({
      schema, projection_revision, scope_sha256: result.scope.scope_sha256,
      publication_sha256, database_sha256, source_revision, source_snapshot, event_signature,
    }));
    result.envelope_sha256 = await validator.sha256Hex(validator.canonicalJson(result));
    return result;
  };
  const read = (document, response = Response.json(document)) => readProjectionResult(document.dataset, {}, undefined,
    async url => url === '/api/v5/auth' ? Response.json(session(document.projection_revision)) : response);
  assert.equal((await read(candidate)).ok, true);
  const verified = candidate.verified_at_ms;
  const nextPublication = { database_sha256: 'e'.repeat(64) };
  const tied = await reseal(campaign, { ...nextPublication, verified_at_ms: verified });
  const ignored = await read(tied);
  assert.deepEqual([ignored.ok, ignored.error?.status, ignored.error?.code, ignored.error?.freshness], [false, 503, 'STALE_OR_EXPIRED', 'ignored']);
  assert.equal('envelope' in ignored, false);
  const newer = await reseal(campaign, { ...nextPublication, verified_at_ms: verified + 1 });
  assert.equal((await read(newer)).ok, true);
  const retired = await read(candidate);
  assert.deepEqual([retired.ok, retired.error?.status, retired.error?.code, retired.error?.freshness], [false, 409, 'SNAPSHOT_CHANGED', 'retired']);
  assert.equal('envelope' in retired, false);
  const ownerConflict = await read(candidate, Response.json(load('examples/errors/SNAPSHOT_CHANGED.json'), { status: 409 }));
  assert.equal(ownerConflict.error.code, 'SNAPSHOT_CHANGED');
  assert.equal(ownerConflict.error.freshness, undefined);
  const expired = await read(await reseal(campaign, { ...nextPublication, verified_at_ms: verified + 2, served_at_ms: verified + 90_002 }));
  assert.deepEqual([expired.ok, expired.error?.status, expired.error?.code, expired.error?.freshness], [false, 503, 'STALE_OR_EXPIRED', 'expired']);
  assert.equal('envelope' in expired, false);
});

test('assessment labels require the complete unchanged cursor chain', () => {
  const full = golden('assessments-conflict');
  const revision = full.items[0].idea_revision_id;
  const first = { ...full, items: full.items.slice(0, 1), page: { ...full.page, has_more: true, next_cursor: 'opaque' } };
  const second = { ...full, items: full.items.slice(1) };
  const traversal = new AssessmentTraversal();
  assert.equal(traversal.observe(second, 1, 'opaque', revision), null);
  assert.equal(traversal.observe(first, 0, null, revision), null);
  assert.equal(traversal.observe(second, 1, 'unexpected', revision), null);
  assert.equal(traversal.observe(first, 0, null, revision), null);
  const labels = traversal.observe(second, 1, 'opaque', revision);
  assert.match(render(second, { assessmentRelationships: labels }), /Conflicting recorded assessments/);
  assert.doesNotMatch(render(first), /Conflicting recorded assessments/);
  const recordOnly = new AssessmentTraversal().observe(golden('assessments-evaluation-collision'), 0, null, revision);
  assert.deepEqual([...recordOnly.values()], ['Recorded evaluation identity collision', 'Recorded evaluation identity collision']);
  const supersession = new AssessmentTraversal().observe(golden('assessments-supersession'), 0, null, revision);
  assert.equal(supersession.get('assessment:fixture-old'), 'Superseded by an explicit owner link');
  assert.equal(new AssessmentTraversal().observe(golden('assessments-omitted-comparison'), 0, null, revision), null);
});

test('assessment relationship caps include 128 pages and 2,000 rows, but not either overflow', () => {
  const envelope = golden('assessments-supported');
  const [row] = envelope.items;
  const revision = row.idea_revision_id;
  for (const [pageCount, total, expected] of [[128, 2000, 2000], [129, 2000, null], [128, 2001, null]]) {
    const traversal = new AssessmentTraversal();
    for (let index = 0; index < pageCount; index += 1) {
      const start = Math.floor(index * total / pageCount);
      const end = Math.floor((index + 1) * total / pageCount);
      const last = index === pageCount - 1;
      const items = Array.from({ length: end - start }, (_unused, offset) => {
        const id = start + offset;
        return { ...row, record_id: `assessment:${id}`, evaluation_id: `evaluation:${id}`, row_sha256: id.toString(16).padStart(64, '0') };
      });
      const labels = traversal.observe({
        ...envelope, items, page: { ...envelope.page, next_cursor: last ? null : `cursor-${index + 1}`, has_more: !last },
        coverage: { ...envelope.coverage, total_items: total, returned_items: items.length },
      }, index, index === 0 ? null : `cursor-${index}`, revision);
      assert.equal(labels?.size ?? null, last ? expected : null, `${pageCount}/${total}, page ${index + 1}`);
    }
  }
});

test('Stage B clears the cursor stack on owner UNAVAILABLE, 409, 401 and expiry', async () => {
  const fixture = golden('candidates-real-scope');
  const unavailable = golden('candidates-unavailable');
  const cases = [
    { output: { ok: true, envelope: unavailable }, expected: 'unavailable' },
    { output: { ok: false, error: { status: 409, code: 'SNAPSHOT_CHANGED' } }, expected: 'unavailable' },
    { output: { ok: false, error: { status: 401, code: 'authentication_required', unauthenticated: true } }, expected: 'unauthenticated' },
  ];
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (const { output, expected } of cases) {
    const cursors = [];
    const store = new ProjectionStore({
      dataset: 'candidates', params: {}, maxAgeMs: 90_000, pollMs: 0,
      clock: { now: () => 0, setTimeout: () => 1, clearTimeout() {} },
      read: async (_dataset, params) => {
        cursors.push(params.cursor);
        return cursors.length === 1 ? { ok: true, envelope: fixture } : output;
      },
    });
    store.start(); await tick();
    store.next(); await tick();
    assert.deepEqual(cursors, [undefined, fixture.page.next_cursor]);
    assert.equal(store.getSnapshot().state, expected);
    assert.equal(store.getSnapshot().pageIndex, 0);
    assert.equal(store.getSnapshot().hasPrevious, false);
    assert.equal(store.getSnapshot().expiresAt, null);
  }
  let expire;
  const store = new ProjectionStore({
    dataset: 'candidates', params: {}, maxAgeMs: 90_000, pollMs: 0,
    clock: { now: () => 0, setTimeout: callback => { expire = callback; return 1; }, clearTimeout() {} },
    read: async () => ({ ok: true, envelope: fixture }),
  });
  store.start(); await tick();
  expire();
  assert.equal(store.getSnapshot().state, 'expired');
  assert.equal(store.getSnapshot().envelope, null);
});
