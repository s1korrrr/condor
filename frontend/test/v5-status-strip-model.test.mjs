import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laneHealth, statusStrip, utcClock } from '../src/v5/status-strip-model.mjs';

const NOW = Date.parse('2026-11-14T12:00:30Z');
const status = (extra = {}) => ({ generated_at: NOW / 1000 - 5, reasons: [], ready: true, gates: [{ gate: 'ready', note: '' }], symbols: [{ pair: 'BTC-USDC', candidate_hold: 'no_rebound' }], ...extra });
const input = (over = {}) => ({
  nowMs: NOW,
  v5: { bound: true, pending: false, current: true, entryHold: null, lastOkMs: NOW - 4000 },
  helm: { read: { state: 'FRESH', status: status() }, failed: false, lastOkMs: NOW - 4000, receivedAtMs: NOW },
  data: { configured: true, pending: false, failed: false, lanes: { total: 14, live: 14, lagS: 62 }, lastOkMs: NOW - 4000, receivedAtMs: NOW },
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
  // A received hold is shown even when the snapshot is not current (it is never hidden behind an older snapshot).
  assert.deepEqual([stale.tone, stale.text], ['amber', 'Buying paused by an owner hold']);
  assert.equal(chip(statusStrip(input({ v5: { bound: true, pending: false, current: false, entryHold: null, lastOkMs: Date.parse('2026-11-14T11:30:05Z') } })), 'v5').text, 'No report since 11:30:05 UTC');
  assert.equal(chip(statusStrip(input({ v5: { ...input().v5, entryHold: true, emergency: true } })), 'v5').text, 'Emergency halt reported: buying stopped');
  assert.equal(chip(statusStrip(input({ v5: { bound: true, pending: false, current: false, entryHold: null, lastOkMs: null } })), 'v5').text, 'No report yet');
  assert.equal(chip(statusStrip(input({ v5: { bound: false, pending: false, current: false, entryHold: null, lastOkMs: null } })), 'v5').text, 'No paper bot bound');
});

test('Helm reuses helmHeadline: waiting is green, not buying is amber, stopped is red, unknown or failed is grey', () => {
  const waiting = status({ symbols: [{ pair: 'BTC-USDC', candidate_hold: 'no_rebound' }] });
  const green = chip(statusStrip(input({ helm: { read: { state: 'FRESH', status: waiting }, failed: false, lastOkMs: NOW } })), 'helm');
  assert.deepEqual([green.tone, green.text, green.short], ['green', 'Running, waiting for a signal', 'Helm waiting']);
  const paused = chip(statusStrip(input({ helm: { read: { state: 'FRESH', status: status({ operator_entry_paused: true }) }, failed: false, lastOkMs: NOW } })), 'helm');
  assert.deepEqual([paused.tone, paused.text], ['amber', 'Running, not buying: new entries paused by the operator']);
  // Neutral headline (ready gate, a planner code on a coin): plain grey dot, never green or amber, still 'running'.
  const neutral = chip(statusStrip(input({ helm: { read: { state: 'FRESH', status: status({ symbols: [{ pair: 'BTC-USDC', candidate_hold: 'bag_gap_not_met' }] }) }, failed: false, lastOkMs: NOW } })), 'helm');
  assert.deepEqual([neutral.tone, neutral.text, neutral.short], ['grey', 'Running, entry gate ready', 'Helm running']);
  assert.equal(chip(statusStrip(input({ helm: { read: { state: 'STALE', status: status({ reasons: ['runtime_stopped'] }) }, failed: false, lastOkMs: NOW } })), 'helm').tone, 'red');
  assert.equal(chip(statusStrip(input({ helm: { read: { state: 'STALE', status: status() }, failed: false, lastOkMs: NOW } })), 'helm').tone, 'grey');
  const failed = chip(statusStrip(input({ helm: { read: null, failed: true, lastOkMs: Date.parse('2026-11-14T11:59:00Z') } })), 'helm');
  assert.deepEqual([failed.tone, failed.text], ['grey', 'No report since 11:59:00 UTC']);
});

test('market data is amber above 180 s, grey when the read failed or no lane published an age', () => {
  assert.equal(chip(statusStrip(input({ data: { ...input().data, lanes: { total: 14, live: 14, lagS: 180 } } })), 'data').tone, 'green');
  const late = chip(statusStrip(input({ data: { ...input().data, lanes: { total: 14, live: 14, lagS: 181 } } })), 'data');
  assert.deepEqual([late.tone, late.text], ['amber', 'Late · slowest lane 181 s']);
  const failed = chip(statusStrip(input({ data: { configured: true, pending: false, failed: true, lanes: { total: 14, live: 14, lagS: 5 }, lastOkMs: Date.parse('2026-11-14T11:58:10Z'), receivedAtMs: NOW } })), 'data');
  assert.deepEqual([failed.tone, failed.text], ['grey', 'No report since 11:58:10 UTC']);
  assert.equal(chip(statusStrip(input({ data: { ...input().data, lanes: { total: 14, live: 0, lagS: null } } })), 'data').tone, 'grey');
  assert.equal(chip(statusStrip(input({ data: { configured: false, pending: false, failed: false, lanes: null, lastOkMs: null } })), 'data').text, 'No candle store on this deployment');
});

test('equity and its change come only from a current wallet with published numbers; otherwise a dash', () => {
  assert.equal(chip(statusStrip(input()), 'equity').text, '1,012.35 USDC · +12.35 since start');
  assert.equal(chip(statusStrip(input({ wallet: { current: true, equity: '990', funding: '1000', flows: '0', unit: 'USDC' } })), 'equity').text, '990.00 USDC · −10.00 since start');
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

test('lane health counts unavailable or unknown lanes instead of dropping them (Sol R1 B3)', () => {
  assert.deepEqual(laneHealth([{ available: true, last_minute_age_s: 12 }, { available: true, last_minute_age_s: 95 }, { available: false, last_minute_age_s: 9999 }, { available: true, last_minute_age_s: null }, { available: null, last_minute_age_s: 3 }]), { total: 5, live: 2, lagS: 95 });
  assert.equal(laneHealth(undefined), null);
  const partial = chip(statusStrip(input({ data: { ...input().data, lanes: laneHealth([{ available: true, last_minute_age_s: 5 }, { available: false, last_minute_age_s: null }]) } })), 'data');
  assert.deepEqual([partial.tone, partial.text], ['amber', '1 of 2 lanes not live · slowest live lane 5 s']);
});

test('Helm and market-data ages advance with the clock between polls (Sol R1 B2)', () => {
  const helm = { read: { state: 'FRESH', status: { ...status(), age_s: 29 } }, failed: false, lastOkMs: NOW, receivedAtMs: NOW };
  assert.equal(chip(statusStrip(input({ helm })), 'helm').tone, 'green');
  assert.equal(chip(statusStrip(input({ nowMs: NOW + 2_000, helm })), 'helm').tone, 'grey');
  const data = { ...input().data, lanes: { total: 14, live: 14, lagS: 179 }, receivedAtMs: NOW };
  assert.equal(chip(statusStrip(input({ data })), 'data').tone, 'green');
  assert.deepEqual([chip(statusStrip(input({ nowMs: NOW + 2_000, data })), 'data').tone, chip(statusStrip(input({ nowMs: NOW + 2_000, data })), 'data').text], ['amber', 'Late · slowest lane 181 s']);
});

test('equity change is exact decimal arithmetic (Sol R1 S5)', () => {
  assert.equal(chip(statusStrip(input({ wallet: { current: true, equity: '9007199254740993', funding: '9007199254740992', flows: '0', unit: 'USDC' } })), 'equity').text, '9,007,199,254,740,993.00 USDC · +1.00 since start');
  assert.equal(chip(statusStrip(input({ wallet: { current: true, equity: '1000.005', funding: '1000', flows: '0.000', unit: 'USDC' } })), 'equity').text, '1,000.01 USDC · +0.01 since start');
  assert.equal(chip(statusStrip(input({ wallet: { current: true, equity: '999.994', funding: '1000', flows: '0', unit: 'USDC' } })), 'equity').text, '999.99 USDC · −0.01 since start');
});
