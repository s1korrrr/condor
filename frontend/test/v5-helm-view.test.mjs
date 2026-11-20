import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';

function render({ state = 'FRESH', age_s = 0, signal = null, rejections = { count: 0, recent: [] }, extra = {} } = {}) {
  const status = {
    generated_at: 1793929900, age_s, reasons: [], gates: [{ gate: 'ready', note: '' }], ready: true, withheld: 0,
    recipe_version: 'helm_v5_dca_trailing_bag_v1', control_rejections: rejections,
    symbols: [{ pair: 'BNB-USDC', signal, bag: { held_amount: '0', breakeven_price: '0' } }], ...extra,
  };
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({ data: { state, status, bot: 'helm_v5_paper' }, dataUpdatedAt: Date.now(), refetch() {} }) },
  });
  return renderToStaticMarkup(React.createElement(load('v5/V5Helm').V5Helm));
}

test('Helm daily loss keeps its owner title off the phone helper and formats every width', () => {
  const exact = '13.71580913935440000000000000';
  const html = render({ extra: {
    risk: { daily_loss_use: exact, risk_reference_quote: '200000.123456789', unit: 'USDC' },
    mandate: { state: 'active', mandate_id: 'helm-test', revocation_id: 'shared-revocation' },
  } });
  for (const width of [1280,430,390]) {
    const window = new Window({width});
    try {
      window.document.body.innerHTML = html;
      const tiles = [...window.document.querySelectorAll('.v5m-stat')];
      const tile = tiles.find(item => item.firstElementChild.textContent === 'Daily loss used');
      assert.equal(tile.querySelector('strong').textContent, '13.72');
      assert.equal(tile.hasAttribute('title'), false, `${width}px: phone CSS must not publish an exact amount as helper text`);
      // 13 decimal places after trailing zeros: the title uses the shared owner-title rule (format.mjs ownerTitle).
      assert.equal(tile.querySelector('strong .owner-value').title, '≈ 13.715809139354 (rounded)');
      assert.equal(tile.querySelector('small').textContent, 'of the 200,000.12 USDC risk reference');
      assert.equal(tile.querySelector('small span').title, '200000.123456789');
      assert.equal(tiles.find(item => item.firstElementChild.textContent === 'Mandate').title, 'Revocation id shared-revocation (shared by the mandate and its authorization)');
    } finally { window.close(); }
  }
});

test('unpublished signals have no default recipe numbers and render table and narrow-screen cards', () => {
  const html = render();
  assert.equal(html.match(/not published by Helm|Signal time not published/g), null, 'no per-row repeats of "not published"');
  assert.equal(html.match(/Helm does not publish its buy rule or signal values; the state and hold reason below are Helm&#x27;s own\./g)?.length, 1);
  assert.doesNotMatch(html, /RSI\(17\)|through 29|by default|Current RSI values are not published/);
  assert.match(html, /class="v5m-card v5m-helm-table"/);
  assert.match(html, /class="v5m-helm-mobile"/);
  assert.match(html, /<article class="v5m-card v5m-helm-coin"><h3>BNB-USDC<\/h3>/);
  assert.match(html, /<th class="is-number">Held/);
  assert.match(html, /<th class="is-number">Breakeven/);
});

test('zero refused commands hides the section, unknown and nonzero counts do not', () => {
  assert.doesNotMatch(render(), /Refused control commands|None recorded/);
  assert.doesNotMatch(render({ rejections: { count: '0.000', recent: [] } }), /Refused control commands/);
  assert.match(render({ rejections: null }), /Refused control commands/);
  assert.match(render({ rejections: { count: null, recent: [] } }), /count not published/);
  assert.match(render({ rejections: { count: 1, recent: [{ action: 'pause_entries', at_ms: 1793929900000, reason: 'already_paused' }] } }), /Refused control commands/);
});

test('fresh and stale read rendering uses the same row model without presenting stale signal numbers', () => {
  const signal = { at: 1793929890, rsi: '40.5', oversold: '31', rsi_length: 21, atr_fraction: null, decision: { enter: false, reason: 'atr_unavailable' } };
  assert.match(render({ signal }), /Buys when RSI\(21\) crosses up through 31/);
  assert.match(render({ signal }), /RSI 40.5, 9.5 points above the line/);
  assert.match(render({ signal }), /Helm: atr unavailable/);
  const html = render({ state: 'STALE', signal });
  assert.match(html, /Helm status is stale/);
  assert.match(html, /6 Nov 01:51 UTC · 10 s ago · stale/);
  assert.doesNotMatch(html, /RSI 40.5|RSI\(21\)|Helm: atr unavailable/);
  assert.doesNotMatch(render({ age_s: 31, signal }), /RSI 40.5|RSI\(21\)/);
});

test('page statistics, counts, holdings and UTC times retain shared formatter output', context => {
  context.mock.method(Date, 'now', () => 1793929900000);
  const html = render({ age_s: 180, rejections: { count: '1234', recent: [{ action: 'pause_entries', at_ms: 1793929900000, reason: 'already_paused' }] }, extra: {
    actions: '1234', steps: '5678', withheld: 1234,
    mandate: { state: 'valid', revision: 1234, valid_until_ms: 1793929900000 },
    risk: { daily_loss_use: '1234.567', risk_reference_quote: '199330.7', unit: 'USDC' },
  } });
  for (const text of ['Last status 3 min ago', '1,234 in total', '1,234 published value(s)', 'revision 1,234', '1,234.57', '199,330.70 USDC', '5,678 engine steps', '6 Nov 01:51 UTC']) assert.ok(html.includes(text), text);
  const held = render({ extra: { symbols: [{ pair: 'BNB-USDC', signal: null, bag: { held_amount: '0.12345678901234567890', breakeven_price: '640.000001' } }] } });
  assert.equal(held.match(/0\.123457 BNB/g)?.length, 2);
  assert.equal(held.match(/640\.00/g)?.length, 2);
  assert.doesNotMatch(held, /0\.12345678901234567890|640\.000001/);
});

test('rounded Helm figures retain exact owner inputs and RSI distance', context => {
  context.mock.method(Date, 'now', () => 1793929900000);
  const html = render({ signal: { at: 1793929890, rsi: '28.9999999', oversold: '29', rsi_length: 17 }, extra: {
    risk: { daily_loss_use: '-0.004', risk_reference_quote: '200.00001', unit: 'USDC' },
  } });
  assert.match(html, /<span>Daily loss used<\/span><strong><span class="owner-value" title="-0\.004" data-tone="zero">0\.00<\/span><\/strong>/);
  assert.match(html, /title="RSI 28\.9999999 − line 29 = −0\.0000001"[^>]*>RSI 29, 0 points below the line/);
  assert.match(html, /title="200\.00001"/);
});

test('the single note explains dashes in rule and signal columns only, not Held or Breakeven', context => {
  context.mock.method(Date, 'now', () => 1793929900000);
  const html = render({ extra: { symbols: [
    { pair: 'BNB-USDC', signal: { at: 1793929890, rsi: '40.5', oversold: '31', rsi_length: 21, atr_fraction: null, decision: null }, bag: null },
    { pair: 'ETH-USDC', signal: null, bag: null },
    { pair: 'SOL-USDC', signal: null, bag: null },
  ] } });
  assert.match(html, /Buys when RSI\(21\) crosses up through 31/);
  assert.match(html, /RSI 40.5, 9.5 points above the line/);
  assert.equal(html.match(/A dash in place of a buy rule or signal means Helm has not published it for that coin\./g)?.length, 1);
  assert.match(html, /<dt>Held<\/dt><dd>—<\/dd><dt>Breakeven<\/dt><dd>—<\/dd>/);
  assert.equal(html.match(/Rule not published by Helm|Signal not published by Helm/g), null);
});
