import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parsePaperReadText, paperOpaqueClockNumber, PAPER_QUARANTINED_CLOCK_EVIDENCE} from '../src/v5/paper-json.ts';
import {paperSectionError} from '../src/v5/policy.ts';
import {ownerRisk} from './helpers/owner-risk.mjs';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/${section === 'accounting' ? 'native-replay/' : ''}${section}.json`, import.meta.url)));
const risk = () => ownerRisk('clock-anomaly-hold', fixture('risk'));
const anomaly = read => read.data.clock_recovery.anomalies[0];

test('only the pinned quarantine path and its two non-computational number fields are exempt', () => {
  assert.equal(PAPER_QUARANTINED_CLOCK_EVIDENCE.path, 'risk.data.clock_recovery.anomalies[*]');
  assert.deepEqual(PAPER_QUARANTINED_CLOCK_EVIDENCE.numericFields, ['timestamp', 'provider_upper_bound']);
  assert.match(PAPER_QUARANTINED_CLOCK_EVIDENCE.reason, /never arithmetic/);
  assert.ok(Object.isFrozen(PAPER_QUARANTINED_CLOCK_EVIDENCE));
  assert.ok(Object.isFrozen(PAPER_QUARANTINED_CLOCK_EVIDENCE.numericFields));
});

for (const token of ['1000000000000000001', '999999999999999999999999999999999999', '-1000000000000000001', '1.000000000000000001e+18', '1e999']) test(`quarantined number token ${token} survives JSON parsing exactly`, () => {
  const read = risk();
  const text = JSON.stringify(read).replace(/"timestamp":1000000000000000000/, `"timestamp":${token}`);
  const parsed = parsePaperReadText(text);
  assert.equal(anomaly(parsed).timestamp, token);
  assert.equal(anomaly(parsed).provider_upper_bound, String(anomaly(read).provider_upper_bound));
  assert.equal(parsed.generated_at_ms, read.generated_at_ms);
  assert.equal(paperSectionError(parsed), null);
});

test('escaped property names, strings, multiple anomalies and duplicate keys follow JSON semantics', () => {
  const read = risk();
  read.data.clock_recovery.anomalies.push({source:'a\\"b',timestamp:7,provider_upper_bound:null});
  const text = JSON.stringify(read).replace('"timestamp":1000000000000000000', '"timestamp":1,"time\\u0073tamp":1000000000000000001');
  const parsed = parsePaperReadText(text);
  assert.equal(anomaly(parsed).timestamp, '1000000000000000001');
  assert.deepEqual(parsed.data.clock_recovery.anomalies[1], {source:'a\\"b',timestamp:'7',provider_upper_bound:null});
  assert.equal(paperSectionError(parsed), null);
});

for (const field of ['fee_quote', 'equity_quote', 'quantity', 'position', 'positions', 'paused', 'emergency', 'complete', 'entry_hold', 'timestamp_ms', 'observed_at_ms', 'order_count', 'other']) test(`quarantine cannot exempt ${field}`, () => {
  const read = risk();
  anomaly(read)[field] = 1e18;
  assert.equal(paperOpaqueClockNumber(['risk','data','clock_recovery','anomalies',0,field]), false);
  const parsed = parsePaperReadText(JSON.stringify(read));
  assert.equal(typeof anomaly(parsed)[field], 'number');
  assert.notEqual(paperSectionError(parsed), null);
});

for (const section of ['status', 'wallet', 'positions', 'fills', 'executors', 'decisions', 'history', 'accounting']) test(`same quarantine-shaped value in ${section} remains strict`, () => {
  const read = fixture(section);
  if (Array.isArray(read.data)) read.data[0].clock_recovery = risk().data.clock_recovery;
  else read.data.clock_recovery = risk().data.clock_recovery;
  const parsed = parsePaperReadText(JSON.stringify(read));
  assert.notEqual(paperSectionError(parsed), null);
});

for (const location of ['root', 'controller', 'nested anomaly']) test(`numeric timestamp outside the exact quarantine leaf stays strict: ${location}`, () => {
  const read = risk();
  if (location === 'root') read.data.timestamp = 1e18;
  if (location === 'controller') Object.values(read.data.controllers)[0].timestamp = 1e18;
  if (location === 'nested anomaly') anomaly(read).nested = {timestamp:1e18};
  assert.notEqual(paperSectionError(parsePaperReadText(JSON.stringify(read))), null);
});

for (const field of ['timestamp', 'provider_upper_bound']) for (const value of [{amount:'1'}, [], 'not a number']) test(`opaque ${field} rejects non-number evidence ${JSON.stringify(value)}`, () => {
  const read = risk();
  anomaly(read)[field] = value;
  assert.notEqual(paperSectionError(parsePaperReadText(JSON.stringify(read))), null);
});

test('invalid JSON and deeply nested input fail closed', () => {
  assert.throws(() => parsePaperReadText('{"section":"risk","data":1e}'), SyntaxError);
  const read = risk();
  read.data.extra = Array.from({length:30}).reduce(value => ({value}), {});
  assert.throws(() => parsePaperReadText(JSON.stringify(read)), /depth bound/);
});
