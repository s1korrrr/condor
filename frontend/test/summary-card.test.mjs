import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules({
  'react-router-dom': { Link: ({ to, children, ...rest }) => React.createElement('a', { href: to, ...rest }, children) },
});
const card = load('features/bots/summary-card.ts');
const example = () => JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/fleet_summary/summary_full.example.json', import.meta.url), 'utf8'));

// The same cases as the app's TradingCapabilityTests.swift, so one summary reads the same on both.
const REPORT_AT = 1_792_672_000_000;
const ethRestricted = {
  buy: 'restricted', sell: 'can_trade', coverage: 'partial', restrictions_total: 1,
  restrictions: [{ subject: 'ETH-USDC buying', why: 'buy decision could not be stored', pair: 'ETH-USDC', side: 'buy', state: 'restricted',
    reason_code: 'entry_decision_unavailable', since_ms: 1792665443815, detail: 'database is locked', alert: true }],
};
const bot = (trading, extra = {}) => ({ bot: 'ok_rsi', report_at_ms: REPORT_AT, report_stale: false, trading, ...extra });

test('a running bot that cannot buy a pair is named with the app wording and needs attention', () => {
  const trading = card.parseBotTrading(ethRestricted);
  assert.equal(trading.buy, 'restricted');
  assert.equal(trading.sell, 'ok');
  assert.equal(card.tradingLevel(trading), 'restricted');
  assert.equal(card.tradingSummary(trading), 'ETH-USDC buying restricted');
  const view = card.botTradingView(bot(ethRestricted), REPORT_AT + 8_000, REPORT_AT + 5_000);
  assert.deepEqual({ text: view.text, attention: view.attention, level: view.level }, { text: 'ETH-USDC buying restricted', attention: true, level: 'restricted' });
});

test('a policy restriction is shown but does not flag the bot', () => {
  const raw = { buy: 'restricted', sell: 'can_trade', restrictions: [{ subject: 'Buying', why: 'sell-only mode', pair: null, side: 'buy', state: 'restricted', reason_code: 'trade_mode_sell_only', alert: false }] };
  const view = card.botTradingView(bot(raw), REPORT_AT + 1_000, REPORT_AT + 1_000);
  assert.equal(view.text, 'Buying restricted');
  assert.equal(view.attention, false);
});

test('the glance word never claims a side and unknown words are unverified', () => {
  assert.equal(card.tradingSummary(card.parseBotTrading('restricted')), 'Trading restricted');
  assert.equal(card.tradingSummary(card.parseBotTrading('ok')), null);
  const odd = card.parseBotTrading('fine');
  assert.equal(card.tradingLevel(odd), 'unverified');
  assert.equal(card.tradingSummary(odd), 'Trading status unknown');
});

test('malformed or absent trading is no claim at all, never healthy', () => {
  assert.equal(card.parseBotTrading({ buy: 'can_trade', sell: 'can_trade', restrictions: 'none' }), null);
  assert.equal(card.parseBotTrading(null), null);
  assert.equal(card.parseBotTrading(undefined), null);
  assert.equal(card.botTradingView(bot(undefined), REPORT_AT, REPORT_AT), null);
});

test('a cached capability expires with the bot report: can-trade turns unverified, an inability stays and says stale', () => {
  const ok = bot({ buy: 'can_trade', sell: 'can_trade', restrictions: [] });
  const fresh = card.botTradingView(ok, REPORT_AT + 10_000, REPORT_AT + 10_000);
  assert.equal(fresh.level, 'ok');
  assert.equal(fresh.text, null);
  const later = card.botTradingView(ok, REPORT_AT + 3_600_000, REPORT_AT + 10_000);
  assert.equal(later.level, 'unverified');
  assert.equal(later.text, 'Trading status unknown');
  const blocked = bot('blocked');
  const current = card.botTradingView(blocked, REPORT_AT + 5_000, REPORT_AT + 5_000);
  assert.deepEqual([current.text, current.attention], ['Trading blocked', true]);
  const aged = card.botTradingView(blocked, REPORT_AT + 301_000, REPORT_AT + 5_000);
  assert.deepEqual([aged.text, aged.attention], ['Trading blocked · stale', true], 'ageing alone is not recovery');
  const flagged = card.botTradingView({ ...ok, report_stale: true }, REPORT_AT + 1_000, REPORT_AT + 1_000);
  assert.equal(flagged.text, 'Trading status unknown', 'a report the server already flags stale is no current claim');
});

test('a held capability is last known, never current, and its own observation age bounds it', () => {
  // Same case as the app's "A held capability is last known" test (TradingCapabilityTests.swift).
  const held = { ...ethRestricted, buy: 'restricted', sell: 'can_trade', held: true, reason: 'SOURCE_UNAVAILABLE', observed_ms: REPORT_AT };
  const view = card.botTradingView(bot(held), REPORT_AT + 8_000, REPORT_AT + 5_000);
  assert.deepEqual({ text: view.text, attention: view.attention, level: view.level },
    { text: 'ETH-USDC buying restricted · last known', attention: true, level: 'unverified' });
  const healthyHeld = card.botTradingView(bot({ buy: 'can_trade', sell: 'can_trade', held: true, observed_ms: REPORT_AT }), REPORT_AT + 8_000, REPORT_AT + 5_000);
  assert.deepEqual({ text: healthyHeld.text, level: healthyHeld.level }, { text: 'Trading status unknown', level: 'unverified' });
  // A current report with an old observation is not a current claim either.
  const old = card.botTradingView(bot({ buy: 'can_trade', sell: 'can_trade', observed_ms: REPORT_AT - 301_000 }), REPORT_AT + 1_000, REPORT_AT + 1_000);
  assert.equal(old.level, 'unverified');
});

test('a bounded restriction list says how many more there are', () => {
  const raw = { buy: 'blocked', sell: 'blocked', restrictions_total: 3, restrictions: [{ subject: 'Trading', why: 'kill switch on', pair: null, side: 'both', state: 'blocked', reason_code: 'manual_kill_switch', alert: true }] };
  const trading = card.parseBotTrading(raw);
  assert.equal(card.tradingLevel(trading), 'blocked');
  assert.equal(card.tradingSummary(trading), 'Trading blocked · +2 more');
});

test('a bot card day change is the summary pnl_day with the app notes, never a client recomputation', () => {
  const summary = example();
  const v1 = summary.bots.find(row => row.bot === 'ok_rsi');
  const day = card.botDayView(v1);
  assert.equal(day.change, '3');
  assert.equal(day.unit, 'USDC');
  assert.equal(day.note, '23h unrecorded', 'uncovered time is named like the app (AgeText.compact)');
  assert.equal(card.botDayView({ ...v1, pnl_day: { ...v1.pnl_day, partial: true, uncovered_ms: 0 } }).note, 'partial');
  assert.equal(card.botDayView({ ...v1, pnl_day: { ...v1.pnl_day, partial: true, stale: true, uncovered_ms: 120_000 } }).note, 'stale · 2m unrecorded');
  assert.equal(card.botDayView({ ...v1, pnl_day: { ...v1.pnl_day, uncovered_ms: undefined } }).note, null, 'an older server without uncovered_ms adds no claim');
  const missing = card.botDayView({ ...v1, pnl_day: null, missing: [{ field: 'pnl_day', reason: 'NEEDS_TWO_SAMPLES' }] });
  assert.deepEqual([missing.change, missing.reason], [null, 'Needs two samples in the window.']);
  const paper = card.botDayView({ ...v1, paper: true, pnl_day: { change: '-1', unit: 'USDC', partial: false, stale: false, uncovered_ms: 0, simulated: true } });
  assert.equal(paper.note, 'paper');
});

test('fleet card shows the trading capability pill from the summary', () => {
  const { FleetStrip } = load('components/bots/FleetStrip.tsx');
  const summary = example();
  const v1 = summary.bots.find(row => row.bot === 'ok_rsi');
  const cards = { ok_rsi: { ...v1, report_at_ms: summary.generated_at_ms - 5_000, trading: ethRestricted } };
  const html = renderToStaticMarkup(React.createElement(FleetStrip, {
    sources: [{ bot: 'ok_rsi', server: 'native' }], readsByBot: {}, now: summary.generated_at_ms,
    summary: { cards, generatedAtMs: summary.generated_at_ms },
  }));
  assert.match(html, /ETH-USDC buying restricted/);
  assert.match(html, /data-trading="restricted"/);
  assert.match(html, /buy decision could not be stored/, 'the reason is available on the pill');
});
