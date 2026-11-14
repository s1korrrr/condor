import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slowestLaneAge, statusStrip, utcClock } from '../src/v5/status-strip-model.mjs';

const NOW = Date.parse('2026-11-14T12:00:30Z');
const status = (extra = {}) => ({ generated_at: NOW / 1000 - 5, reasons: [], ready: true, symbols: [], ...extra });
const input = (over = {}) => ({
  nowMs: NOW,
  v5: { bound: true, pending: false, current: true, entryHold: null, lastOkMs: NOW - 4000 },
  helm: { read: { state: 'FRESH', status: status() }, failed: false, lastOkMs: NOW - 4000 },
  data: { configured: true, pending: false, failed: false, slowestLagS: 62, lastOkMs: NOW - 4000 },
  wallet: { current: true, equity: '1012.35', funding: '1000', flows: '0', unit: 'USDC' },
  updatedMs: NOW - 4000,
  ...over,
});
const chip = (strip, id) => strip.chips.find(item => item.id === id);

test('everything current is green, counts nothing to check and stamps the update with a ticking age', () => {
  const strip = statusStrip(input());
  assert.deepEqual(strip.chips.map(item => [item.id, item.tone]), [['v5', 'green'], ['helm', 'green'], ['data', 'green'], ['equity', 'green']]);
  assert.equal(chip(strip, 'v5').text, 'Running');
  assert.equal(chip(strip, 'data').text, 'Live · slowest lane 62 s');
  assert.equal(strip.checkText, 'Nothing to check');
  assert.equal(strip.updated, 'Updated 12:00:26 UTC · 4 s ago');
  assert.equal(statusStrip(input({ nowMs: NOW + 1000 })).updated, 'Updated 12:00:26 UTC · 5 s ago');
});

test('an owner entry hold is amber "buying paused"; a failed or stale V5 read is grey and names the last good report', () => {
  assert.deepEqual([chip(statusStrip(input({ v5: { ...input().v5, entryHold: true } })), 'v5').tone, chip(statusStrip(input({ v5: { ...input().v5, entryHold: true } })), 'v5').text], ['amber', 'Buying paused by an owner hold']);
  const stale = chip(statusStrip(input({ v5: { bound: true, pending: false, current: false, entryHold: true, lastOkMs: Date.parse('2026-11-14T11:30:05Z') } })), 'v5');
  assert.deepEqual([stale.tone, stale.text], ['grey', 'No report since 11:30:05 UTC']);
  assert.equal(chip(statusStrip(input({ v5: { bound: true, pending: false, current: false, entryHold: null, lastOkMs: null } })), 'v5').text, 'No report yet');
  assert.equal(chip(statusStrip(input({ v5: { bound: false, pending: false, current: false, entryHold: null, lastOkMs: null } })), 'v5').text, 'No paper bot bound');
});

test('Helm reuses helmHeadline: waiting is green, not buying is amber, stopped is red, unknown or failed is grey', () => {
  const waiting = status({ symbols: [{ pair: 'BTC-USDC', candidate_hold: 'no_rebound' }] });
  const green = chip(statusStrip(input({ helm: { read: { state: 'FRESH', status: waiting }, failed: false, lastOkMs: NOW } })), 'helm');
  assert.deepEqual([green.tone, green.text, green.short], ['green', 'Running, waiting for a signal', 'Helm waiting']);
  const paused = chip(statusStrip(input({ helm: { read: { state: 'FRESH', status: status({ operator_entry_paused: true }) }, failed: false, lastOkMs: NOW } })), 'helm');
  assert.deepEqual([paused.tone, paused.text], ['amber', 'Running, not buying: new entries paused by the operator']);
  assert.equal(chip(statusStrip(input({ helm: { read: { state: 'STALE', status: status({ reasons: ['runtime_stopped'] }) }, failed: false, lastOkMs: NOW } })), 'helm').tone, 'red');
  assert.equal(chip(statusStrip(input({ helm: { read: { state: 'STALE', status: status() }, failed: false, lastOkMs: NOW } })), 'helm').tone, 'grey');
  const failed = chip(statusStrip(input({ helm: { read: null, failed: true, lastOkMs: Date.parse('2026-11-14T11:59:00Z') } })), 'helm');
  assert.deepEqual([failed.tone, failed.text], ['grey', 'No report since 11:59:00 UTC']);
});

test('market data is amber above 180 s, grey when the read failed or no lane published an age', () => {
  assert.equal(chip(statusStrip(input({ data: { ...input().data, slowestLagS: 180 } })), 'data').tone, 'green');
  const late = chip(statusStrip(input({ data: { ...input().data, slowestLagS: 181 } })), 'data');
  assert.deepEqual([late.tone, late.text], ['amber', 'Late · slowest lane 181 s']);
  const failed = chip(statusStrip(input({ data: { configured: true, pending: false, failed: true, slowestLagS: 5, lastOkMs: Date.parse('2026-11-14T11:58:10Z') } })), 'data');
  assert.deepEqual([failed.tone, failed.text], ['grey', 'No report since 11:58:10 UTC']);
  assert.equal(chip(statusStrip(input({ data: { ...input().data, slowestLagS: null } })), 'data').tone, 'grey');
  assert.equal(chip(statusStrip(input({ data: { configured: false, pending: false, failed: false, slowestLagS: null, lastOkMs: null } })), 'data').text, 'No candle store on this deployment');
});

test('equity and its change come only from a current wallet with published numbers; otherwise a dash', () => {
  assert.equal(chip(statusStrip(input()), 'equity').text, '1,012.35 USDC · +12.35 since start');
  assert.equal(chip(statusStrip(input({ wallet: { current: true, equity: '990', funding: '1000', flows: '0', unit: 'USDC' } })), 'equity').text, '990.00 USDC · -10.00 since start');
  assert.equal(chip(statusStrip(input({ wallet: { current: false, equity: '1012', funding: '1000', flows: '0', unit: 'USDC' } })), 'equity').text, '—');
  assert.equal(chip(statusStrip(input({ wallet: { current: true, equity: 1012, funding: '1000', flows: '0', unit: 'USDC' } })), 'equity').text, '—');
  assert.equal(chip(statusStrip(input({ wallet: { current: true, equity: '1012', funding: null, flows: '0', unit: 'USDC' } })), 'equity').text, '1,012.00 USDC · change since start —');
  assert.equal(chip(statusStrip(input({ wallet: { current: true, equity: '1012', funding: '1000', flows: '50', unit: 'USDC' } })), 'equity').text, '1,012.00 USDC · change since start —');
});

test('the count covers every non-green state chip, not the equity figure', () => {
  const strip = statusStrip(input({ v5: { ...input().v5, entryHold: true }, data: { ...input().data, failed: true }, wallet: { current: false } }));
  assert.equal(strip.toCheck, 2);
  assert.equal(strip.checkText, '2 things to check');
  assert.equal(statusStrip(input({ v5: { ...input().v5, entryHold: true } })).checkText, '1 thing to check');
});

test('no successful read yet stamps "Not updated yet"; times that are not times are rejected', () => {
  assert.equal(statusStrip(input({ updatedMs: null })).updated, 'Not updated yet');
  assert.equal(utcClock(0), null);
  assert.equal(utcClock(NaN), null);
  assert.equal(utcClock(NOW), '12:00:30 UTC');
});

test('the slowest lane ignores unavailable lanes and missing ages', () => {
  assert.equal(slowestLaneAge([{ last_minute_age_s: 12 }, { last_minute_age_s: 95 }, { available: false, last_minute_age_s: 9999 }, { last_minute_age_s: null }]), 95);
  assert.equal(slowestLaneAge([{ last_minute_age_s: null }]), null);
  assert.equal(slowestLaneAge(undefined), null);
});
