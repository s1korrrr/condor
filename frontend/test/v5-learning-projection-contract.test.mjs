import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';
import { generate } from '../tooling/gen-learning-schemas.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const contract = resolve(here, '../../condor/v5/schemas/learning_projection');
const read = relative => readFileSync(resolve(contract, relative), 'utf8');
const json = relative => JSON.parse(read(relative));
const modules = frontendModules();
const validate = modules.load('v5/learning-projection-validate.ts');
const projection = modules.load('v5/learning-projection.ts');
const { ProjectionStore, ProjectionFreshness } = modules.load('v5/learning-projection-store.ts');
const ui = modules.load('v5/projection-ui.tsx');
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

const INDEX = json('golden-index.json');
const HASHES = json('golden-hashes.json');
const FRESHNESS = json('freshness-vectors.json');
const WIRE = json('wire-contract.json');
const MAX_AGE = 90_000;

async function rehash(document) {
  for (const row of document.items) {
    if ('row_sha256' in row) {
      const { row_sha256: _omitted, ...body } = row;
      row.row_sha256 = await validate.sha256Hex(validate.canonicalJson(body));
    }
  }
  const { envelope_sha256: _omitted, ...body } = document;
  document.envelope_sha256 = await validate.sha256Hex(validate.canonicalJson(body));
  return document;
}
const { scope_id, program_id, family_lane_pairs } = json('examples/manifest.json').scope;
const membership = { program_id, family_lane_pairs };
const check = (dataset, document, recordType) => validate.validateEnvelope(dataset, document, { recordType, maxAgeMs: MAX_AGE, scopeId: scope_id, membership });
const recordType = path => path.includes('edges') ? 'edge' : path.includes('nodes') || path.includes('age') ? 'node' : undefined;
const datasetOf = path => path.split('/').pop().split('-')[0].replace('.json', '');
const aged = async seconds => {
  const document = json('examples/records-nodes.json');
  document.served_at_ms = document.verified_at_ms + seconds * 1000;
  return rehash(document);
};

// --- the generated schema module is the frozen appendix ----------------------------------------------------

test('the generated schema module is byte-current with the vendored frozen appendix', () => {
  assert.equal(readFileSync(resolve(here, '../src/v5/learning-projection-schemas.ts'), 'utf8'), generate());
});

test('published limits are the contract limits', () => {
  assert.equal(projection.MAX_VERIFICATION_AGE_MS, FRESHNESS.max_age_ms);
  assert.equal(projection.MAX_PROJECTION_RESPONSE_BYTES, WIRE.limits.condor_response_decoded_bytes);
  assert.equal(projection.MIN_POLL_MS, FRESHNESS.schedule_interval_ms);
  assert.deepEqual([...projection.MANIFEST_DATASET_ORDER], WIRE.ordering.manifest_items);
});

test('whole-row byte limit accepts 8192 and rejects 8193 before the scalar budget', async () => {
  const { checkRow } = frontendModules({}, { 'v5/learning-projection-validate.ts': ['checkRow'] }).load('v5/learning-projection-validate.ts');
  const document = json('examples/records-nodes.json');
  const row = document.items[0];
  const size = () => Buffer.byteLength(validate.canonicalJson(row));
  row.record_id += 'x'.repeat(8192 - size());
  await rehash(document);
  assert.equal(size(), 8192);
  await assert.rejects(checkRow(row, 'row'), /scalar region/);
  row.record_id += 'x';
  await rehash(document);
  assert.equal(size(), 8193);
  await assert.rejects(checkRow(row, 'row'), /row exceeds 8192 bytes/);
});

// --- goldens -----------------------------------------------------------------------------------------------

for (const entry of INDEX.examples.filter(item => item.status === 200)) {
  test(`golden ${entry.path} passes strict parse, schema, hashes and invariants`, async () => {
    const document = validate.parseStrictJson(read(entry.path));
    assert.equal(validate.schemaError(entry.schema.replace('.schema.json', ''), document), null);
    await check(datasetOf(entry.path), document, recordType(entry.path));
  });
}

for (const entry of INDEX.examples.filter(item => item.status !== 200)) {
  test(`error golden ${entry.path} maps to HTTP ${entry.status}`, () => {
    const document = validate.parseStrictJson(read(entry.path));
    if (entry.status === 401) return assert.equal(validate.schemaError('auth-error', document), null);
    assert.deepEqual(validate.validateErrorBody(entry.status, document), document);
    const other = Object.keys(validate.ERROR_STATUS_CODES).map(Number).find(status => status !== entry.status);
    assert.throws(() => validate.validateErrorBody(other, document), validate.ContractViolation);
  });
}

test('stage B disabled goldens are typed 404 DATASET_NOT_ENABLED', () => {
  for (const entry of INDEX.disabled_datasets) {
    const wrapper = json(entry.path);
    assert.equal(wrapper.http_status, 404);
    assert.equal(validate.validateErrorBody(404, wrapper.body).code, 'DATASET_NOT_ENABLED');
  }
});

test('the four hash vectors and the revision recompute from canonical preimages', async () => {
  for (const vector of HASHES.vectors) {
    const canonical = validate.canonicalJson(vector.preimage);
    assert.equal(canonical, vector.canonical_utf8);
    assert.equal(validate.utf8Length(canonical), vector.byte_length);
    assert.equal(await validate.sha256Hex(canonical), vector.sha256);
  }
  assert.equal(await validate.sha256Hex(validate.canonicalJson(HASHES.scope_sha256.preimage)), HASHES.scope_sha256.sha256);
  assert.equal(await validate.sha256Hex(validate.canonicalJson(HASHES.cursor.filter_preimage)), HASHES.cursor.filter_sha256);
  assert.equal(await validate.sha256Hex(validate.canonicalJson(WIRE.projection_revision_preimage)), WIRE.projection_revision);
});

// --- freshness ---------------------------------------------------------------------------------------------

test('89 s and the 90 s boundary are accepted; 91 s is rejected', async () => {
  await check('records', await aged(89), 'node');
  await check('records', await aged(90), 'node');
  await assert.rejects(async () => check('records', await aged(91), 'node'), /90 s/);
  for (const vector of FRESHNESS.vectors.filter(item => 'served_at_ms' in item)) {
    const seconds = (vector.served_at_ms - vector.verified_at_ms) / 1000;
    assert.equal(vector.expected_http === 200, seconds <= 90);
  }
});

// --- strict parsing ----------------------------------------------------------------------------------------

test('the strict parser rejects what the contract forbids', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1.0}', '{"a":1e0}', '{"a":-0}', '{"a":-1}', '{"a":9007199254740992}', '{"a":NaN}', '{"a":01}',
    '﻿{"a":1}', '{"a":"\\ud800"}', '{"a":1} trailing', '{"a":', '[' .repeat(100)]) {
    assert.throws(() => validate.parseStrictJson(text), validate.ContractViolation, text);
  }
  assert.deepEqual(validate.parseStrictJson('{"b":[1,2,{"c":null}],"a":"é"}'), { b: [1, 2, { c: null }], a: 'é' });
});

test('whole-envelope rejection: one bad field fails everything', async () => {
  const mutations = {
    'unknown key': d => { d.extra = 1; },
    'wrong dataset': d => { d.dataset = 'jobs'; },
    'pending events': d => { d.coverage.pending_events = 1; },
    'returned_items': d => { d.coverage.returned_items = 2; },
    'has_more': d => { d.page.has_more = true; },
    'row field': d => { d.items[0].kind = 'bogus'; },
    'bound hides a gap': d => { d.coverage.unresolved_membership_items = 3; },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const document = json('examples/records-nodes.json');
    mutate(document);
    await assert.rejects(async () => check('records', await rehash(document), 'node'), validate.ContractViolation, label);
  }
  const tampered = json('examples/records-nodes.json');
  tampered.items[0].title = 'edited after sealing';
  await assert.rejects(async () => check('records', tampered, 'node'), /hash/);
  const stale = json('examples/records-nodes.json');
  stale.status = 'STALE';
  await assert.rejects(async () => check('records', await rehash(stale), 'node'));
});

test('the row hash is checked even when only the envelope is resealed', async () => {
  const document = json('examples/records-nodes.json');
  document.items[0].title = 'edited; envelope resealed, row hash stale';
  const { envelope_sha256: _omitted, ...body } = document;
  document.envelope_sha256 = await validate.sha256Hex(validate.canonicalJson(body));
  await assert.rejects(async () => check('records', document, 'node'), /row hash/);
});

test('records pages never mix nodes and edges; out-of-scope refs are opaque; sources are safe', async () => {
  await assert.rejects(async () => check('records', json('examples/records-edges.json'), 'node'), /edge in a node page/);
  await assert.rejects(async () => check('records', json('examples/records-nodes.json'), 'edge'), /node in an edge page/);
  const edge = json('examples/records-edges.json');
  Object.assign(edge.items[0].to_ref, { resolution: 'OUT_OF_SCOPE', kind: 'experiment', revision: null, source_index: null });
  await assert.rejects(async () => check('records', await rehash(edge), 'edge'), /opaque/);
  edge.items[0].to_ref.kind = 'OPAQUE';
  await check('records', await rehash(edge), 'edge');
  const unsafe = json('examples/records-nodes.json');
  unsafe.items[0].sources[0].relative_path = '../escape.json';
  await assert.rejects(async () => check('records', await rehash(unsafe), 'node'), /unsafe source path/);
});

test('ordering is strictly ascending record_id bytes', async () => {
  const document = json('examples/records-nodes.json');
  const second = structuredClone(document.items[0]);
  second.record_id = 'experiment:fixture-0';
  document.items.push(second);
  document.coverage.returned_items = document.coverage.total_items = 2;
  await assert.rejects(async () => check('records', await rehash(document), 'node'), /ascending/);
});

// --- readProjectionResult: transport + typed errors -------------------------------------------------------

const response = (status, body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, ...init });
const fetcher = (handler, calls = [], scopeId = scope_id) => async (url, options) => {
  calls.push({ url, options });
  if (url === '/api/v5/auth') return response(200, { authenticated: true, learning_scope_id: scopeId, learning_scope_membership: membership });
  return handler(url, options);
};
const typed = code => json(`examples/errors/${code}.json`);

test('a success is the validated envelope; the request is a credentialed, query-only GET', async () => {
  const calls = [];
  const result = await projection.readProjectionResult('lessons', { limit: 10, cursor: HASHES.cursor.token }, undefined,
    fetcher(() => response(200, read('examples/lessons.json')), calls));
  assert.equal(result.ok, true);
  assert.equal(result.envelope.items[0].recall, 'NOT_EVALUATED');
  assert.equal(calls[0].url, '/api/v5/auth');
  assert.equal(calls[1].url, `/api/v5/learning/lessons?scope_id=fixture-v5-lfl&limit=10&cursor=${HASHES.cursor.token}`);
  assert.equal(calls[1].options.credentials, 'include');
  assert.equal(calls[1].options.method, undefined);
  assert.equal(calls[1].options.body, undefined);
});

test('records query carries record_type and root_id', async () => {
  const calls = [];
  await projection.readProjectionResult('records', { record_type: 'edge', root_id: 'a/b c', limit: 5 }, undefined,
    fetcher(() => response(200, read('examples/records-edges.json')), calls));
  assert.equal(calls.at(-1).url, '/api/v5/learning/records?scope_id=fixture-v5-lfl&record_type=edge&root_id=a%2Fb+c&limit=5');
});

for (const mutant of ['family', 'program', 'lesson-program', 'pairs', 'window', 'issue']) {
  test(`resealed ${mutant} violates scope or size invariants`, async () => {
    const dataset = mutant === 'lesson-program' ? 'lessons' : 'records';
    const document = json(`examples/${dataset === 'records' ? 'records-nodes' : dataset}.json`);
    const row = document.items[0];
    if (mutant === 'family') row.row_scope.family_id = 'outside-family';
    if (mutant === 'program') row.row_scope.program_id = 'outside-program';
    if (mutant === 'lesson-program') row.program_id = 'outside-program';
    if (mutant === 'pairs') document.scope.family_lane_pairs.push({ family_id: 'aaa', lane: 'SPOT' });
    if (mutant === 'window') row.row_scope.recorded_scope.window = { start: 20, end_exclusive: 10 };
    if (mutant === 'issue') {
      document.status = 'PARTIAL';
      document.issues = [{ code: 'OMITTED_CONTENT', record_id: 'r'.repeat(160), detail: 'd'.repeat(128) }];
    }
    await rehash(document);
    assert.equal(validate.schemaError(dataset, document), null);
    await assert.rejects(check(dataset, document, 'node'), validate.ContractViolation);
  });
}

for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
  test(`schema rejects inherited property name ${key} as an unknown key`, async () => {
    const document = validate.parseStrictJson(read('examples/manifest.json').replace('{', `{${JSON.stringify(key)}:null,`));
    await rehash(document);
    assert.match(validate.schemaError('manifest', document), /unknown key/);
  });
}

async function newGeneration(document, publication = '9', offset = 0) {
  document.publication_sha256 = publication.repeat(64);
  document.verified_at_ms += offset;
  document.served_at_ms += offset;
  const { schema, projection_revision, scope: { scope_sha256 }, publication_sha256, database_sha256, source_revision, source_snapshot, event_signature } = document;
  document.snapshot_id = await validate.sha256Hex(validate.canonicalJson({ schema, projection_revision, scope_sha256, publication_sha256, database_sha256, source_revision, source_snapshot, event_signature }));
  return rehash(document);
}

test('retired generation cannot rebind through a dataset that never saw it', async () => {
  const session = frontendModules().load('v5/learning-projection.ts');
  const first = await newGeneration(json('examples/manifest.json'), '1');
  const current = await newGeneration(json('examples/manifest.json'), '2', 39_000);
  const retired = await newGeneration(json('examples/jobs.json'), '1', 40_000);
  const fetchProjection = (dataset, body) => session.readProjectionResult(dataset, {}, undefined, fetcher(() => response(200, body)));
  assert.equal((await fetchProjection('manifest', first)).ok, true);
  assert.equal((await fetchProjection('manifest', current)).ok, true);
  let clears = 0;
  const unregister = session.registerProjectionStore({ clearForAuth() {}, clearForScopeChange() { clears += 1; } });
  try {
    const replay = await fetchProjection('jobs', retired);
    assert.equal(replay.ok, false);
    assert.equal(replay.error.code, 'SNAPSHOT_CHANGED');
    assert.equal(clears, 0);
  } finally { unregister(); }
});

test('a newer identity-bearing UNAVAILABLE retires the previous snapshot', async () => {
  const session = frontendModules().load('v5/learning-projection.ts');
  const first = await newGeneration(json('examples/lessons.json'), '1');
  const unavailable = await newGeneration(json('examples/jobs.json'), '2', 10_000);
  Object.assign(unavailable, { status: 'UNAVAILABLE', items: [], reason_codes: ['VERIFICATION_EXPIRED'],
    coverage: { ...unavailable.coverage, state: 'UNAVAILABLE', returned_items: 0 } });
  await rehash(unavailable);
  const late = await newGeneration(json('examples/lessons.json'), '1', 20_000);
  const request = (dataset, body) => session.readProjectionResult(dataset, {}, undefined, fetcher(() => response(200, body)));
  assert.equal((await request('lessons', first)).ok, true);
  const cleared = [];
  const unregister = ['lessons', 'records'].map(dataset => session.registerProjectionStore({ clearForAuth() {}, clearForScopeChange: () => cleared.push(dataset) }));
  try {
    const result = await request('jobs', unavailable);
    assert.equal(result.ok, true);
    assert.equal(result.expiresAt, null);
    assert.deepEqual(result.envelope.items, []);
    const replay = await request('lessons', late);
    assert.equal(replay.ok, false);
    assert.equal(replay.error.code, 'SNAPSHOT_CHANGED');
    assert.equal(replay.error.freshness, 'retired');
    assert.deepEqual(cleared, ['lessons', 'records']);
  } finally { unregister.forEach(remove => remove()); }
});

test('older verification of another snapshot cannot replace the current generation', async () => {
  const session = frontendModules().load('v5/learning-projection.ts');
  const fetchProjection = async (dataset, file, publication, offset) => {
    const body = await newGeneration(json(`examples/${file}.json`), publication, offset);
    return session.readProjectionResult(dataset, dataset === 'records' ? { record_type: 'node' } : {}, undefined, fetcher(() => response(200, body)));
  };
  assert.equal((await fetchProjection('records', 'records-nodes', '1', 1000)).ok, true);
  assert.equal((await fetchProjection('lessons', 'lessons', '1', 1000)).ok, true);
  assert.equal((await fetchProjection('records', 'records-nodes', '2', 40_000)).ok, true);
  assert.equal((await fetchProjection('lessons', 'lessons', '2', 40_000)).ok, true);
  let clears = 0;
  const unregister = session.registerProjectionStore({ clearForAuth() {}, clearForScopeChange() { clears += 1; } });
  try {
    const late = await fetchProjection('records', 'records-nodes', '1', 20_000);
    assert.equal(late.ok, false);
    assert.equal(late.error.code, 'SNAPSHOT_CHANGED');
    assert.equal(clears, 0);
  } finally { unregister(); }
});

test('retired UNAVAILABLE metadata does not authorize clearing a live page', async () => {
  const session = frontendModules().load('v5/learning-projection.ts');
  const first = await newGeneration(json('examples/records-nodes.json'), '1');
  const current = await newGeneration(json('examples/records-nodes.json'), '2', 1);
  const retired = await rehash({ ...first, status: 'UNAVAILABLE', items: [], reason_codes: ['VERIFICATION_EXPIRED'],
    coverage: { ...first.coverage, state: 'UNAVAILABLE', returned_items: 0 } });
  assert.equal(validate.schemaError('records', retired), null);
  const request = body => session.readProjectionResult('records', { record_type: 'node' }, undefined, fetcher(() => response(200, body)));
  assert.equal((await request(first)).ok, true);
  assert.equal((await request(current)).ok, true);
  const replay = await request(retired);
  assert.equal(replay.ok, false);
  assert.equal(replay.error.freshness, 'retired');
});

for (const status of [401, 409]) {
  test(`direct reads after ${status} serve only until the original deadline`, async context => {
    const session = frontendModules().load('v5/learning-projection.ts');
    let now = 0;
    context.mock.method(performance, 'now', () => now);
    const body = json('examples/manifest.json');
    body.served_at_ms = body.verified_at_ms + 89_000;
    await rehash(body);
    const request = (statusCode, payload) => session.readProjectionResult('manifest', {}, undefined, fetcher(() => response(statusCode, payload)));
    assert.equal((await request(200, body)).ok, true);
    assert.equal((await request(status, typed(status === 401 ? 'AUTHENTICATION_REQUIRED' : 'SNAPSHOT_CHANGED'))).error.status, status);
    now = 500;
    assert.equal((await request(200, body)).ok, true);
    if (status === 401) assert.equal((await request(401, {})).error.status, 401);
    now = 1001;
    const replay = await request(200, body);
    assert.equal(replay.ok, false);
    assert.equal(replay.error.code, 'STALE_OR_EXPIRED');
    const replayFetch = fetcher(() => response(200, body));
    context.mock.method(globalThis, 'fetch', replayFetch);
    await assert.rejects(session.readProjection('manifest'), error => error.error?.code === 'STALE_OR_EXPIRED');
  });
}

test('trusted session membership rejects a resealed foreign program and its matching rows', async () => {
  const session = frontendModules().load('v5/learning-projection.ts');
  const body = json('examples/lessons.json');
  body.scope.program_id = 'foreign-program';
  for (const row of body.items) row.program_id = row.row_scope.program_id = 'foreign-program';
  await rehash(body);
  assert.equal(validate.schemaError('lessons', body), null);
  const result = await session.readProjectionResult('lessons', {}, undefined, fetcher(() => response(200, body)));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_OWNER_PROJECTION');
});

test('an active generation change clears every registered dataset store', async () => {
  const projection = frontendModules().load('v5/learning-projection.ts');
  const old = json('examples/manifest.json');
  const next = await newGeneration(json('examples/jobs.json'), '9', 1);
  const cleared = [];
  const unregister = ['manifest', 'jobs', 'records'].map(name => projection.registerProjectionStore({ clearForAuth() {}, clearForScopeChange: () => cleared.push(name) }));
  try {
    assert.equal((await projection.readProjectionResult('manifest', {}, undefined, fetcher(() => response(200, old)))).ok, true);
    assert.equal((await projection.readProjectionResult('jobs', {}, undefined, fetcher(() => response(200, next)))).ok, true);
    assert.deepEqual(cleared, ['manifest', 'jobs', 'records']);
  } finally { unregister.forEach(remove => remove()); }
});

test('a cancelled, valid response changes neither the scope nor the generation', async () => {
  const projection = frontendModules().load('v5/learning-projection.ts');
  const current = json('examples/manifest.json');
  const cancelled = await newGeneration(json('examples/manifest.json'), '9', 1);
  cancelled.scope.scope_id = 'alternate-scope';
  await rehash(cancelled);
  const cleared = [];
  const unregister = projection.registerProjectionStore({ clearForAuth() {}, clearForScopeChange: () => cleared.push(true) });
  const controller = new AbortController();
  try {
    const active = () => projection.readProjectionResult('manifest', {}, undefined, fetcher(() => response(200, current)));
    assert.equal((await active()).ok, true);
    const pending = projection.readProjectionResult('manifest', {}, controller.signal, fetcher(() => {
      controller.abort();
      return response(200, cancelled);
    }, [], cancelled.scope.scope_id));
    await pending;
    assert.equal((await active()).ok, true);
    assert.deepEqual(cleared, []);
  } finally { unregister(); }
});

test('an unreadable 401 still clears all caches before reading the body', async () => {
  let cleared = 0;
  const unregister = projection.registerProjectionStore({ clearForAuth: () => { cleared += 1; }, clearForScopeChange() {} });
  const denied = new Response(new ReadableStream({ start: stream => stream.error(new Error('unreadable')) }), { status: 401 });
  try {
    const result = await projection.readProjectionResult('manifest', {}, undefined, fetcher(() => denied));
    assert.equal(result.error.status, 401);
    assert.equal(cleared, 1);
  } finally { unregister(); }
});

test('a cancelled 401 does not clear another request’s state', async () => {
  let cleared = 0;
  const unregister = projection.registerProjectionStore({ clearForAuth: () => { cleared += 1; }, clearForScopeChange() {} });
  const controller = new AbortController();
  try {
    await projection.readProjectionResult('manifest', {}, controller.signal, fetcher(() => {
      controller.abort();
      return response(401, typed('AUTHENTICATION_REQUIRED'));
    }));
    assert.equal(cleared, 0);
  } finally { unregister(); }
});

test('a streamed response stops at the running byte cap', async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls <= 3) controller.enqueue(new Uint8Array(130_000));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const result = await projection.readProjectionResult('manifest', {}, undefined, fetcher(() => new Response(stream)));
  assert.equal(result.error.code, 'INVALID_OWNER_PROJECTION');
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
});

test('a leading UTF-8 BOM is not stripped before strict parsing', async () => {
  const result = await projection.readProjectionResult('manifest', {}, undefined,
    fetcher(() => response(200, `\uFEFF${read('examples/manifest.json')}`)));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_OWNER_PROJECTION');
});

test('malformed UTF-8 cannot become a valid replacement character', async () => {
  const document = json('examples/lessons.json');
  document.items[0].title = '\uFFFD';
  await rehash(document);
  const encoded = new TextEncoder().encode(JSON.stringify(document));
  const index = encoded.indexOf(0xef);
  assert.notEqual(index, -1);
  const mutant = Uint8Array.from([...encoded.slice(0, index), 0xff, ...encoded.slice(index + 3)]);
  const result = await projection.readProjectionResult('lessons', {}, undefined, fetcher(() => new Response(mutant)));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_OWNER_PROJECTION');
});

test('every projection error maps to {status, code, retryable, snapshot_id}', async () => {
  for (const entry of INDEX.examples.filter(item => item.status !== 200 && item.status !== 401)) {
    const body = read(entry.path);
    const result = await projection.readProjectionResult('lessons', {}, undefined, fetcher(() => response(entry.status, body)));
    const expected = JSON.parse(body);
    assert.equal(result.ok, false, entry.path);
    assert.deepEqual(result.error, { status: entry.status, code: expected.code, retryable: expected.retryable, snapshot_id: expected.snapshot_id, unauthenticated: false }, entry.path);
  }
});

test('401 is distinguished and clears every cache', async () => {
  const cleared = [];
  const store = { clearForAuth: () => cleared.push('auth'), clearForScopeChange: () => {} };
  const unregister = projection.registerProjectionStore(store);
  const result = await projection.readProjectionResult('lessons', {}, undefined, fetcher(() => response(401, '{"detail":{"code":"authentication_required"}}')));
  assert.deepEqual(result, { ok: false, error: { status: 401, code: 'authentication_required', retryable: false, snapshot_id: null, unauthenticated: true } });
  assert.deepEqual(cleared, ['auth']);
  unregister();
});

test('transport, shape and integrity failures are typed and never produce data', async () => {
  const cases = {
    'network down': [() => { throw new TypeError('network'); }, 0, 'UPSTREAM_UNAVAILABLE'],
    'invalid json': [() => response(200, '{nope'), 502, 'INVALID_OWNER_PROJECTION'],
    'duplicate keys': [() => response(200, read('examples/lessons.json').replace('"owner"', '"owner": "research_os", "owner"')), 502, 'INVALID_OWNER_PROJECTION'],
    'oversize': [() => response(200, ' '.repeat(256_001)), 502, 'INVALID_OWNER_PROJECTION'],
    'html from a gateway': [() => response(502, '<html>Bad Gateway</html>'), 502, 'INVALID_OWNER_PROJECTION'],
    'code under wrong status': [() => response(409, typed('INVALID_QUERY')), 502, 'INVALID_OWNER_PROJECTION'],
    'fastapi detail wrapper': [() => response(422, { detail: [{ msg: 'x' }] }), 502, 'INVALID_OWNER_PROJECTION'],
    'wrong dataset': [() => response(200, read('examples/jobs.json')), 502, 'INVALID_OWNER_PROJECTION'],
    'stage B success has no schema': [() => response(200, read('examples/lessons.json')), 502, 'INVALID_OWNER_PROJECTION'],
  };
  for (const [label, [handler, status, code]] of Object.entries(cases)) {
    const dataset = label === 'stage B success has no schema' ? 'candidates' : 'lessons';
    const result = await projection.readProjectionResult(dataset, {}, undefined, fetcher(handler));
    assert.equal(result.ok, false, label);
    assert.equal(result.error.status, status, label);
    assert.equal(result.error.code, code, label);
  }
});

test('readProjection resolves the envelope or throws a ProjectionReadError', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = fetcher(() => response(409, typed('SNAPSHOT_CHANGED')));
    await assert.rejects(projection.readProjection('records', { record_type: 'node' }), error => projection.isProjectionReadError(error) && error.error.code === 'SNAPSHOT_CHANGED' && error.error.status === 409);
    globalThis.fetch = fetcher(() => response(200, read('examples/manifest.json')));
    const manifest = await projection.readProjection('manifest');
    assert.equal(manifest.items.length, 6);
  } finally { globalThis.fetch = original; }
});

// --- the store: cursors, expiry, clearing ------------------------------------------------------------------

class FakeClock {
  constructor() { this.time = 0; this.timers = []; this.id = 0; }
  now = () => this.time;
  setTimeout = (callback, ms) => { const id = ++this.id; this.timers.push({ id, at: this.time + ms, callback }); return id; };
  clearTimeout = id => { this.timers = this.timers.filter(timer => timer.id !== id); };
  async advance(ms) {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter(timer => timer !== due);
      this.time = due.at;
      due.callback();
      await settle();
    }
    this.time = target;
  }
}
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

function makeStore({ dataset = 'records', params = { record_type: 'node' }, pollMs = 30_000, answers = [], clock = new FakeClock(), freshness } = {}) {
  const calls = [];
  const read = async (name, requested, signal) => {
    calls.push({ name, params: { ...requested }, signal });
    const answer = answers.shift();
    return typeof answer === 'function' ? answer(signal) : answer;
  };
  const store = new ProjectionStore({ dataset, params, read, clock, maxAgeMs: MAX_AGE, pollMs, freshness });
  return { store, clock, calls, answers };
}
const ok = envelope => ({ ok: true, envelope });
const fail = (status, code, extra = {}) => ({ ok: false, error: { status, code, retryable: status === 503, snapshot_id: null, unauthenticated: false, ...extra } });

test('an older filter response keeps both filters’ independently expiring live pages', async () => {
  const freshness = new ProjectionFreshness();
  const clock = new FakeClock();
  const old = await aged(10);
  const newer = await newGeneration(structuredClone(old), '1', 10_000);
  const first = await newGeneration(structuredClone(old), '1');
  const older = await newGeneration(structuredClone(old), '3');
  const other = makeStore({ clock, freshness, answers: [ok(newer)], params: { record_type: 'node', root_id: 'other' } });
  const main = makeStore({ clock, freshness, answers: [ok(first), ok(first), ok(older)] });
  main.store.start(); await settle();
  await clock.advance(1000);
  other.store.start(); await settle();
  const displays = [main.store.getSnapshot(), other.store.getSnapshot()];
  assert.deepEqual(displays.map(view => view.state), ['ready', 'ready']);
  main.store.refresh(); await settle();
  assert.deepEqual([main.store.getSnapshot(), other.store.getSnapshot()], displays);
  main.store.refresh(); await settle();
  assert.deepEqual([main.store.getSnapshot(), other.store.getSnapshot()], displays);
  main.store.dispose(); other.store.dispose();
});

test('wire 409 and 503 clear live pages; only 409 offers First', async () => {
  const page = await aged(10);
  const cases = [
    [409, 'SNAPSHOT_CHANGED'],
    [503, 'VERIFICATION_UNAVAILABLE'],
  ];
  for (const [status, code] of cases) {
    const result = await projection.readProjectionResult('records', { record_type: 'node' }, undefined, fetcher(() => response(status,
      { ...typed(code), snapshot_id: page.snapshot_id }, status === 503 ? { headers: { 'Retry-After': '1' } } : {})));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.error.freshness, undefined);
    assert.equal(result.error.retryable, status === 503);
    const { store } = makeStore({ pollMs: 0, answers: [ok(page), result] });
    store.start(); await settle();
    assert.equal(store.getSnapshot().state, 'ready');
    store.refresh(); await settle();
    assert.equal(store.getSnapshot().state, 'unavailable');
    assert.equal(store.getSnapshot().envelope, null);
    assert.equal(store.getSnapshot().snapshotChanged, status === 409);
    store.dispose();
  }
});

test('rows are shown while fresh and cleared at verified_at + 90 s (not poll time)', async () => {
  const envelope = await aged(89);
  const { store, clock } = makeStore({ pollMs: 0, answers: [ok(envelope)] });
  store.start(); await settle();
  assert.equal(store.getSnapshot().state, 'ready');
  assert.equal(store.getSnapshot().expiresAt, 1000);
  await clock.advance(999);
  assert.equal(store.getSnapshot().state, 'ready');
  await clock.advance(1);
  const expired = store.getSnapshot();
  assert.equal(expired.state, 'expired');
  assert.equal(expired.envelope, null);
});

test('a poll with the same verification time cannot extend expiry', async () => {
  const first = await aged(30);
  const second = json('examples/records-nodes.json');
  second.served_at_ms = second.verified_at_ms + 10_000; // same verified_at, "younger" served clock
  await rehash(second);
  const { store, clock, calls } = makeStore({ answers: [ok(first), ok(second)] });
  store.start(); await settle();
  assert.equal(store.getSnapshot().expiresAt, 60_000);
  await clock.advance(30_000); // poll fires
  assert.equal(calls.length, 2);
  assert.equal(store.getSnapshot().state, 'ready');
  assert.equal(store.getSnapshot().expiresAt, 60_000); // not 120_000
});

test('replaying the 89s golden after expiry never makes the store ready again', async () => {
  const replay = json('examples/records-age-89s.json');
  const { store, clock } = makeStore({ pollMs: 0, answers: [ok(replay), ok(replay), ok(replay)] });
  store.start(); await settle();
  assert.equal(store.getSnapshot().state, 'ready');
  await clock.advance(2_000);
  assert.equal(store.getSnapshot().state, 'expired');
  store.refresh(); await settle();
  assert.equal(store.getSnapshot().state, 'expired');
  store.configure({ dataset: 'records', params: { record_type: 'node' }, pollMs: 0 });
  store.start(); await settle();
  assert.equal(store.getSnapshot().state, 'expired');
  assert.equal(store.getSnapshot().envelope, null);
});

test('a late older verification does not replace the displayed rows or their deadline', async () => {
  const newer = await aged(30);
  const older = json('examples/records-nodes.json');
  older.verified_at_ms -= 5_000;
  await rehash(older);
  const { store, clock } = makeStore({ answers: [ok(newer), ok(older)] });
  store.start(); await settle();
  const snapshot = store.getSnapshot();
  await clock.advance(30_000);
  assert.deepEqual(store.getSnapshot(), snapshot);
});

test('a tombstoned generation cannot replace the currently displayed generation', async () => {
  const old = await aged(10);
  const current = await newGeneration(await aged(10), '9', 1);
  const { store } = makeStore({ pollMs: 0, answers: [ok(old), ok(current), ok(old)] });
  store.start(); await settle();
  store.refresh(); await settle();
  assert.equal(store.getSnapshot().envelope, current);
  store.refresh(); await settle();
  assert.equal(store.getSnapshot().envelope, current);
});

test('an invalidated page can recover before its original deadline', async () => {
  const first = await aged(10);
  const newer = { ...first, verified_at_ms: first.verified_at_ms + 1 };
  await rehash(newer);
  const { store, clock } = makeStore({ pollMs: 0, answers: [ok(first), fail(503, 'WARMING'), ok(first), ok(newer)] });
  store.start(); await settle();
  store.refresh(); await settle();
  assert.equal(store.getSnapshot().error.code, 'WARMING');
  await clock.advance(1000);
  store.refresh(); await settle();
  assert.equal(store.getSnapshot().state, 'ready');
  assert.equal(store.getSnapshot().expiresAt, 80_000);
  store.refresh(); await settle();
  assert.equal(store.getSnapshot().envelope, newer);
});

test('a failed poll clears the rows: there is no last-good view', async () => {
  const { store, clock } = makeStore({ answers: [ok(await aged(10)), fail(503, 'WARMING')] });
  store.start(); await settle();
  assert.equal(store.getSnapshot().state, 'ready');
  await clock.advance(30_000);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.state, 'unavailable');
  assert.equal(snapshot.envelope, null);
  assert.equal(snapshot.error.code, 'WARMING');
});

test('opaque cursors: next echoes next_cursor unchanged; previous and first re-read the stack', async () => {
  const token = HASHES.cursor.token;
  const page1 = json('examples/records-nodes.json');
  page1.page = { limit: 25, next_cursor: token, has_more: true };
  const page2 = json('examples/records-nodes.json');
  await rehash(page1); await rehash(page2);
  const { store, calls } = makeStore({ pollMs: 0, answers: [ok(page1), ok(page2), ok(page1), ok(page1), ok(page1)] });
  store.start(); await settle();
  assert.equal(calls[0].params.cursor, undefined);
  assert.equal(store.getSnapshot().hasNext, true);
  store.next(); await settle();
  assert.equal(calls[1].params.cursor, token); // byte-for-byte
  assert.equal(store.getSnapshot().pageIndex, 1);
  assert.equal(store.getSnapshot().hasPrevious, true);
  store.previous(); await settle();
  assert.equal(calls[2].params.cursor, undefined);
  assert.equal(store.getSnapshot().pageIndex, 0);
  store.next(); await settle(); store.first(); await settle();
  assert.equal(calls.at(-1).params.cursor, undefined);
  assert.equal(store.getSnapshot().pageIndex, 0);
});

test('409 clears the pages and waits for an explicit First', async () => {
  const token = HASHES.cursor.token;
  const page1 = json('examples/records-nodes.json');
  page1.page = { limit: 25, next_cursor: token, has_more: true };
  await rehash(page1);
  const { store, calls, clock } = makeStore({ answers: [ok(page1), fail(409, 'SNAPSHOT_CHANGED'), ok(await newGeneration(await aged(5), '9', 1))] });
  store.start(); await settle();
  store.next(); await settle();
  const cleared = store.getSnapshot();
  assert.equal(cleared.state, 'unavailable');
  assert.equal(cleared.snapshotChanged, true);
  assert.equal(cleared.envelope, null);
  assert.equal(cleared.pageIndex, 0);
  await clock.advance(120_000); // no automatic restart, no poll
  assert.equal(calls.length, 2);
  store.first(); await settle();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].params.cursor, undefined);
  assert.equal(store.getSnapshot().state, 'ready');
  assert.equal(store.getSnapshot().snapshotChanged, false);
});

test('401 clears and the store stays unauthenticated', async () => {
  const unauth = { status: 401, code: 'authentication_required', retryable: false, snapshot_id: null, unauthenticated: true };
  const { store, clock, calls } = makeStore({ answers: [ok(await aged(10)), { ok: false, error: unauth }] });
  store.start(); await settle();
  await clock.advance(30_000);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.state, 'unauthenticated');
  assert.equal(snapshot.envelope, null);
  await clock.advance(300_000);
  assert.equal(calls.length, 2); // no polling after auth loss
  store.clearForAuth();
  assert.equal(store.getSnapshot().error.unauthenticated, true);
});

test('a superseded read is aborted and its late answer is ignored', async () => {
  let release;
  const slow = signal => new Promise(resolve => { release = () => resolve(ok(json('examples/records-nodes.json'))); signal.addEventListener('abort', () => {}); });
  const { store, calls } = makeStore({ pollMs: 0, answers: [slow, ok(await aged(5))] });
  store.start(); await settle();
  assert.equal(store.getSnapshot().state, 'loading');
  store.refresh(); await settle(); // supersedes
  assert.equal(calls[0].signal.aborted, true);
  const shown = store.getSnapshot().envelope;
  release(); await settle();
  assert.equal(store.getSnapshot().envelope, shown); // the late answer changed nothing
});

test('dispose aborts an in-flight read and stops timers', async () => {
  const { store, calls, clock } = makeStore({ answers: [() => new Promise(() => {})] });
  store.start(); await settle();
  store.dispose();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(clock.timers.length, 0);
});

test('an owner-reported UNAVAILABLE envelope carries no rows and the state is unavailable', async () => {
  const unavailable = json('examples/manifest.json');
  Object.assign(unavailable, { status: 'UNAVAILABLE', reason_codes: ['VERIFICATION_EXPIRED'], generated_at_ms: null, verified_at_ms: null, snapshot_id: null, publication_sha256: null, database_sha256: null, source_revision: null, source_snapshot: null, event_signature: null, scope: null });
  unavailable.coverage = { state: 'UNAVAILABLE', total_items: null, returned_items: 6, omitted_items: null, unresolved_membership_items: null, excluded_proposed_edges: null, pending_events: null };
  for (const item of unavailable.items) Object.assign(item, { availability: 'UNAVAILABLE', total_items: null });
  await rehash(unavailable);
  const parsed = await check('manifest', unavailable);
  const { store } = makeStore({ dataset: 'manifest', params: {}, pollMs: 0, answers: [ok(parsed)] });
  store.start(); await settle();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.state, 'unavailable');
  assert.equal(snapshot.expiresAt, null);
  assert.equal(snapshot.envelope.items.length, 6); // capability metadata only
});

test('scope or revision change clears every store and re-reads from the first page', async () => {
  const { store, calls } = makeStore({ pollMs: 0, answers: [ok(await aged(5)), ok(await aged(5))] });
  store.start(); await settle();
  store.clearForScopeChange(); await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.cursor, undefined);
  assert.equal(store.getSnapshot().state, 'ready');
});

test('configure drops everything shown and the cursor stack, then reads the new filter from page one', async () => {
  const token = HASHES.cursor.token;
  const page1 = json('examples/records-nodes.json');
  page1.page = { limit: 25, next_cursor: token, has_more: true };
  await rehash(page1);
  const { store, calls } = makeStore({ pollMs: 0, answers: [ok(page1), ok(page1), ok(await aged(5))] });
  store.start(); await settle();
  store.next(); await settle();
  assert.equal(store.getSnapshot().pageIndex, 1);
  store.configure({ dataset: 'records', params: { record_type: 'edge' }, pollMs: 0 });
  assert.equal(store.getSnapshot().state, 'loading');
  assert.equal(store.getSnapshot().envelope, null);
  store.start(); await settle();
  assert.equal(calls.at(-1).params.record_type, 'edge');
  assert.equal(calls.at(-1).params.cursor, undefined);
  assert.equal(store.getSnapshot().pageIndex, 0);
});

test('clampPollMs never polls faster than the owner verifies', () => {
  assert.equal(projection.clampPollMs(undefined), 30_000);
  assert.equal(projection.clampPollMs(1000), 30_000);
  assert.equal(projection.clampPollMs(45_000), 45_000);
  assert.equal(projection.clampPollMs(0), 0);
});

// --- hooks never read during render; no fixture anywhere ---------------------------------------------------

test('rendering a hook makes no request and shows loading', () => {
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => { called += 1; throw new Error('render must not fetch'); };
  try {
    const Probe = () => {
      const view = projection.useProjectionPages('lessons');
      const manifest = projection.useManifest();
      return React.createElement('p', null, `${view.state}|${view.rows.length}|${manifest.state}|${manifest.canRead('lessons')}|${manifest.scopeId}`);
    };
    assert.match(render(Probe, {}), /loading\|0\|loading\|false\|null/);
    assert.equal(called, 0);
  } finally { globalThis.fetch = original; }
});

test('no fixture fallback exists in the projection modules', () => {
  for (const file of ['learning-projection.ts', 'learning-projection-store.ts', 'learning-projection-validate.ts', 'projection-ui.tsx']) {
    const source = readFileSync(resolve(here, '../src/v5', file), 'utf8');
    assert.doesNotMatch(source, /FIXTURE_ONLY|FixtureLearning|fixture-only|Synthetic fixture/i, file);
  }
});

// --- api.ts learningRead -----------------------------------------------------------------------------------

test('learningRead(manifest) delegates to the validated projection and never falls back', async context => {
  const { learningRead } = frontendModules().load('v5/api.ts');
  let now = 0;
  context.mock.method(performance, 'now', () => now);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = fetcher(() => response(200, read('examples/manifest.json')));
    const manifest = await learningRead('manifest');
    assert.equal(manifest.dataset, 'manifest');
    now = 90_000;
    await assert.rejects(learningRead('manifest'), error => error.status === 503 && error.code === 'STALE_OR_EXPIRED');
    globalThis.fetch = fetcher(() => response(503, typed('WARMING')));
    await assert.rejects(learningRead('manifest'), error => error.name === 'V5ApiError' && error.status === 503 && error.code === 'WARMING');
    globalThis.fetch = fetcher(() => response(200, '{"effect":"NONE","status":"FIXTURE_ONLY"}'));
    await assert.rejects(learningRead('manifest'), error => error.status === 502 && error.code === 'INVALID_OWNER_PROJECTION');
  } finally { globalThis.fetch = original; }
});

// --- projection-ui -----------------------------------------------------------------------------------------

test('UtcTime shows Unknown for null, never 1970', () => {
  assert.equal(render(ui.UtcTime, {}), '<span>Unknown</span>');
  assert.equal(render(ui.UtcTime, { value: null }), '<span>Unknown</span>');
  assert.match(render(ui.UtcTime, { value: 1794916800000 }), /UTC<\/time>/);
  assert.doesNotMatch(render(ui.UtcTime, { value: 0 }), /Unknown/);
});

test('CopyableHash wraps the full hash and offers a copy control', () => {
  const hash = 'a'.repeat(64);
  const markup = render(ui.CopyableHash, { value: hash, label: 'snapshot' });
  assert.match(markup, new RegExp(hash));
  assert.match(markup, /break-all/);
  assert.match(markup, /Copy/);
  assert.equal(render(ui.CopyableHash, { value: null }), '<span>Unknown</span>');
});

test('RefList shows an out-of-scope ref as an opaque token only: no owner, no kind, no decoded identity', () => {
  const refs = [
    { owner: 'hummingbot_api', kind: 'OPAQUE', record_id: 'opaque:abc123:secret-looking', revision: null, source_index: null, resolution: 'OUT_OF_SCOPE' },
    { owner: 'research_os', kind: 'outcome', record_id: 'decision:outcome:fixture-1', revision: null, source_index: 0, resolution: 'RESOLVED' },
  ];
  const markup = render(ui.RefList, { refs });
  const [outOfScope, resolved] = markup.split('<li').slice(1);
  assert.match(outOfScope, /opaque:abc123:secret-looking/); // the token itself, copyable
  assert.match(outOfScope, /Unresolved/i);
  assert.match(outOfScope, /out of scope/i);
  assert.doesNotMatch(outOfScope, /hummingbot_api|OPAQUE|research_os|\bkind\b/);
  assert.match(resolved, /research_os/); // in-scope refs still show provenance
  assert.match(resolved, /outcome/);
});

test('RefList counts omitted refs from the owner total and says so when empty', () => {
  const ref = { owner: 'research_os', kind: 'outcome', record_id: 'x', revision: null, source_index: 0, resolution: 'RESOLVED' };
  assert.match(render(ui.RefList, { refs: [ref], total: 5 }), /4 more not shown/);
  assert.match(render(ui.RefList, { refs: [] }), /None recorded/);
});

test('SourceRefList shows every receipt with its full hash', () => {
  const source = { root: 'STORE', relative_path: 'graph_events/x.json', pointer: '/nodes/0', sha256: 'b'.repeat(64), bytes: 20 };
  const markup = render(ui.SourceRefList, { sources: [source] });
  assert.match(markup, /graph_events\/x\.json/);
  assert.match(markup, new RegExp('b'.repeat(64)));
  assert.match(render(ui.SourceRefList, { sources: [] }), /No source receipt/);
});

test('ProjectionStatusBanner is truthful in every state and never shows rows', async () => {
  const envelope = await aged(5);
  const bound = render(ui.ProjectionStatusBanner, { state: 'ready', envelope });
  assert.match(bound, /BOUND/);
  assert.match(bound, /Owner verified/);
  assert.match(bound, /1 on this page of 1/);
  const partial = render(ui.ProjectionStatusBanner, { state: 'ready', envelope: { ...envelope, status: 'PARTIAL', reason_codes: ['OMITTED_CONTENT'] } });
  assert.match(partial, /PARTIAL/);
  assert.match(partial, /OMITTED_CONTENT/);
  assert.match(render(ui.ProjectionStatusBanner, { state: 'expired' }), /Expired/);
  assert.match(render(ui.ProjectionStatusBanner, { state: 'expired' }), /role="alert"/);
  assert.match(render(ui.ProjectionStatusBanner, { state: 'unauthenticated' }), /Signed out/);
  assert.match(render(ui.ProjectionStatusBanner, { state: 'loading' }), /Loading/);
  const failed = render(ui.ProjectionStatusBanner, { state: 'unavailable', error: { status: 503, code: 'WARMING', retryable: true, snapshot_id: null, unauthenticated: false } });
  assert.match(failed, /UNAVAILABLE · WARMING/);
  const changed = render(ui.ProjectionStatusBanner, { state: 'unavailable', error: { status: 409, code: 'SNAPSHOT_CHANGED', retryable: false, snapshot_id: null, unauthenticated: false }, onFirst: () => {} });
  assert.match(changed, /First page/);
  assert.doesNotMatch(failed, /First page/);
});
