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
const { ProjectionStore } = modules.load('v5/learning-projection-store.ts');
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
const check = (dataset, document, recordType) => validate.validateEnvelope(dataset, document, { recordType, maxAgeMs: MAX_AGE });
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
const fetcher = (handler, calls = []) => async (url, options) => { calls.push({ url, options }); return handler(url, options); };
const typed = code => json(`examples/errors/${code}.json`);

test('a success is the validated envelope; the request is a credentialed, query-only GET', async () => {
  const calls = [];
  const result = await projection.readProjectionResult('lessons', { limit: 10, cursor: HASHES.cursor.token }, undefined,
    fetcher(() => response(200, read('examples/lessons.json')), calls));
  assert.equal(result.ok, true);
  assert.equal(result.envelope.items[0].recall, 'NOT_EVALUATED');
  assert.equal(calls[0].url, `/api/v5/learning/lessons?limit=10&cursor=${HASHES.cursor.token}`); // cursor unchanged, no scope_id
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].options.body, undefined);
});

test('records query carries record_type and root_id', async () => {
  const calls = [];
  await projection.readProjectionResult('records', { record_type: 'edge', root_id: 'a/b c', limit: 5 }, undefined,
    fetcher(() => response(200, read('examples/records-edges.json')), calls));
  assert.equal(calls[0].url, '/api/v5/learning/records?record_type=edge&root_id=a%2Fb+c&limit=5');
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

function makeStore({ dataset = 'records', params = { record_type: 'node' }, pollMs = 30_000, answers = [] } = {}) {
  const clock = new FakeClock();
  const calls = [];
  const read = async (name, requested, signal) => {
    calls.push({ name, params: { ...requested }, signal });
    const answer = answers.shift();
    return typeof answer === 'function' ? answer(signal) : answer;
  };
  const store = new ProjectionStore({ dataset, params, read, clock, maxAgeMs: MAX_AGE, pollMs });
  return { store, clock, calls, answers };
}
const ok = envelope => ({ ok: true, envelope });
const fail = (status, code, extra = {}) => ({ ok: false, error: { status, code, retryable: status === 503, snapshot_id: null, unauthenticated: false, ...extra } });

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
  const { store, calls, clock } = makeStore({ answers: [ok(page1), fail(409, 'SNAPSHOT_CHANGED'), ok(await aged(5))] });
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

test('learningRead(manifest) delegates to the validated projection and never falls back', async () => {
  const { learningRead } = frontendModules().load('v5/api.ts');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = fetcher(() => response(200, read('examples/manifest.json')));
    const manifest = await learningRead('manifest');
    assert.equal(manifest.dataset, 'manifest');
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
