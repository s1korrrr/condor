import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';

const css = fs.readFileSync(new URL('../src/v5/phone.css', import.meta.url), 'utf8');
const fixtures = Object.fromEntries(['positions', 'executors', 'decisions', 'wallet', 'fills'].map(section => [section,
  JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/${section}.json`, import.meta.url)))]));
const now = fixtures.positions.generated_at_ms;
const minute = Math.floor(now / 60_000) * 60 - 60;
const view = { pair: 'BNB-USDC', venue: 'OKX', volume_unit: 'BNB', start: minute, end: minute,
  buckets: [[minute, 690, 710, 680, 700, 3, 1, 0, 0, 0, 0, 0]] };

function chartModules() {
  const modules = frontendModules({
    react: { ...React, lazy: () => props => React.createElement(modules.load('components/charts/RecordedCandleChart.tsx').RecordedCandleChart, props) },
    'lightweight-charts': {},
    '@/hooks/useTheme': { useTheme: () => ({ theme: 'dark' }) },
  });
  return modules;
}

test('phone chart exposes every coin and range with selected state and a real fixed-height chart', () => {
  const { PaperPriceChart } = chartModules().load('v5/PaperPriceChart.tsx');
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperPriceChart, { now, view, pair: 'BNB-USDC', setPair: () => {} }));
  const coins = [...window.document.querySelectorAll('[aria-label="Chart coin"] button')];
  assert.deepEqual(coins.map(button => button.textContent), ['BNB', 'BTC', 'ETH', 'SOL', 'XRP']);
  assert.deepEqual(coins.filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.textContent), ['BNB']);
  assert.deepEqual([...window.document.querySelectorAll('[aria-label="Chart range"] button')].map(button => button.textContent), ['1D', '7D']);
  assert.match(window.document.querySelector('.recorded-candle-chart figcaption').textContent, /OKX spot · BNB-USDC · 1m · UTC/);
  assert.ok(window.document.querySelector('.recorded-candle-canvas[role="img"]'));
  assert.match(window.document.querySelector('.recorded-candle-readout').textContent, /Touch and hold or hover/);
  window.close();
});

test('phone coin and range controls keep W6 callbacks without changing the owner query contract', async () => {
  const { PaperPriceChart } = frontendModules().load('v5/PaperPriceChart.tsx');
  const pairs = [], ranges = [];
  let renderer;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => { renderer = create(React.createElement(PaperPriceChart, { now, setPair: pair => pairs.push(pair), setRange: range => ranges.push(range) })); });
    const buttons = renderer.root.findAllByType('button');
    await act(async () => { buttons.find(button => button.children[0] === 'XRP').props.onClick(); });
    await act(async () => { buttons.find(button => button.children[0] === '7D').props.onClick(); });
    assert.deepEqual(pairs, ['XRP-USDC']);
    assert.deepEqual(ranges, ['7d']);
  } finally {
    await act(async () => renderer?.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('phone chart keeps partial-fill caveats and the not-current label outside dimmed markers', () => {
  const { PaperPriceChart } = chartModules().load('v5/PaperPriceChart.tsx');
  const fills = { ...fixtures.fills, completeness: 'partial', data: ['BUY', 'SELL'].map(side => ({ ...fixtures.fills.data[0], trading_pair: 'BNB-USDC', side, event_at_ms: minute * 1000 + 1 })) };
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperPriceChart, { now, view, fills, asOf: now }));
  const legend = window.document.querySelector('.paper-chart-legend');
  assert.match(legend.textContent, /▲ 1 entries ▼ 1 exits · retained fills \(partial\)/);
  assert.match(legend.textContent, /missing candle minutes or without a valid published price are counted but cannot be plotted/);
  assert.equal(legend.children.length, 3);
  assert.match(window.document.querySelector('.paper-price-chart').textContent, /Trade markers and breakeven are dimmed snapshot values, not current/);
  assert.doesNotMatch(legend.textContent, /not current/);
  window.close();
});

test('recorded chart keeps a 360px canvas, 12px axis labels and dimmed breakeven and trade markers', async () => {
  let options, line, markers;
  const series = { setData() {}, createPriceLine: value => { line = value; } };
  const { RecordedCandleChart } = frontendModules({
    'lightweight-charts': { CandlestickSeries: {}, ColorType: { Solid: 'solid' }, LineStyle: { Dashed: 2 },
      createChart: (_container, value) => { options = value; return { addSeries: () => series, subscribeCrosshairMove() {}, timeScale: () => ({ fitContent() {} }), remove() {} }; },
      createSeriesMarkers: (_series, value) => { markers = value; } },
    '@/hooks/useTheme': { useTheme: () => ({ theme: 'dark' }) },
    '@/lib/theme-colors': { getThemeColors: () => ({ bg: 'background', text: 'text', grid: 'grid', up: 'up', down: 'down' }) },
  }).load('components/charts/RecordedCandleChart.tsx');
  let renderer;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => { renderer = create(React.createElement(RecordedCandleChart, { buckets: view.buckets, label: 'BNB', volumeUnit: 'BNB', breakeven: '748.17', snapshotDimmed: true,
      markers: [{ time: minute, event_at_ms: minute * 1000 + 1, side: 'BUY', price: '700', quantity: '0.1234567890123456789' }] }), { createNodeMock: node => node.type === 'div' ? {} : null }); });
    assert.equal(options.height, 360);
    assert.equal(options.autoSize, true);
    assert.equal(options.layout.fontSize, 12);
    assert.equal(line.price, 748.17);
    assert.equal(line.title, 'Breakeven');
    assert.match(line.color, /0\.55/);
    assert.match(markers[0].color, /0\.55/);
    assert.ok(!markers[0].text);
    assert.equal(renderer.root.findByProps({ role: 'img' }).props.title, `BUY ≈ 0.123456789012 (rounded) @ 700 · ${new Date(minute * 1000 + 1).toISOString()}`);
  } finally {
    await act(async () => renderer?.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('recorded chart preserves exact fills in the hover readout and formats hovered candle values', async () => {
  let markers, crosshair;
  const { RecordedCandleChart } = frontendModules({
    'lightweight-charts': { CandlestickSeries:{}, ColorType:{Solid:'solid'}, LineStyle:{Dashed:2},
      createChart:() => ({addSeries:() => ({setData(){}}),subscribeCrosshairMove(callback){crosshair=callback;},timeScale:() => ({fitContent(){}}),remove(){}}),
      createSeriesMarkers:(_series, value) => { markers=value; } },
    '@/hooks/useTheme':{useTheme:() => ({theme:'dark'})},
    '@/lib/theme-colors':{getThemeColors:() => ({})},
  }).load('components/charts/RecordedCandleChart.tsx');
  let renderer;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const candle = [60,101.123456789,102.123456789,100.123456789,101.123456789,0.123456789,1,0,0,0,0,0];
    await act(async () => { renderer=create(React.createElement(RecordedCandleChart,{buckets:[candle],label:'BNB',volumeUnit:'BNB',markers:[{time:60,event_at_ms:61023,side:'BUY',quantity:'0.00000000',price:'101.123456789'}]}),{createNodeMock: node => node.type === 'div' ? {} : null}); });
    assert.ok(!markers[0].text);
    await act(async () => crosshair({time:60}));
    const readout=renderer.root.findByProps({'aria-live':'polite'});
    assert.equal(readout.findByProps({ className: 'block' }).children.join(''), 'BUY 0.00000000 @ 101.123456789 · 1970-01-01T00:01:01.023Z');
    const close = readout.findAllByType('span').find(span => span.props.title === '101.123456789');
    assert.ok(close);
    assert.match(close.children.join(''), /101\.12/);
    assert.doesNotMatch(close.children.join(''), /101\.123456789/);
  } finally { await act(async () => renderer?.unmount()); delete globalThis.IS_REACT_ACT_ENVIRONMENT; }
});

function positionProps() {
  const held = { ...fixtures.positions.data[0], trading_pair: 'BNB-USDC', position_id: 'phone-held', executor_id: 'phone-held', state: 'held_reconciliation', quantity: '1.234567890123456789', protected_exit: null, protected_exit_order: null };
  const dust = { ...held, position_id: 'phone-dust', executor_id: 'phone-dust', state: 'terminal_dust', quantity: '0.000000000000000001' };
  return { now, positions: { ...fixtures.positions, data: [held, dust] }, executors: { ...fixtures.executors, data: [] },
    decisions: { ...fixtures.decisions, data: { ...fixtures.decisions.data, conditions: [{ trading_pair: 'BNB-USDC', status: 'held', reason: 'candle_gap', event_at_ms: now }] } },
    wallet: fixtures.wallet, prices: { 'BNB-USDC': view },
    money: { rows: [{ bot: 'v5', at_ms: now, snapshot_at_ms: now, unit: 'USDC', coins: { BNB: { realized: '199133.37', unrealized: '-1' } } }] } };
}

for (const dimmed of [false, true]) test(`phone position cards retain all owner facts and unknown protection: dimmed=${dimmed}`, () => {
  const { PaperPositions } = frontendModules().load('v5/PaperPositions.tsx');
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperPositions, { ...positionProps(), asOf: dimmed ? now : null }));
  const cards = [...window.document.querySelectorAll('.paper-positions .paper-pair')];
  assert.deepEqual(cards.map(card => card.querySelector('h3').textContent), ['BNB', 'BTC', 'ETH', 'SOL', 'XRP']);
  const card = cards[0];
  for (const text of [/199,132\.37 USDC/, /profit or loss/, /sample as of .*UTC/, /Price: 700\.00 USDC · .*UTC/, /Needs \+6\.9% to break even/, /Breakeven: 748\.17 USDC/, /1\.23457 BNB/, /\+ 0 BNB dust/, /protection unknown for 1 lot/, /Buy decision: Held · Candle gap/]) assert.match(card.textContent, text);
  assert.ok(card.querySelector('[title="≈ 1.234567890123 (rounded)"]'));
  assert.ok(card.querySelector('[title="≈ 0 (rounded)"]'));
  const fields = [...card.querySelectorAll(':scope > div > dl > dt')].map(field => field.textContent);
  assert.deepEqual(fields, ['Holding', 'Worth now', 'Lots', 'Sell orders placed']);
  const details = card.querySelector('details');
  assert.equal(details.open, false);
  assert.equal(details.querySelector('summary').textContent, 'Details');
  assert.deepEqual([...details.querySelectorAll('dt')].map(field => field.textContent), ['Bag reason', 'Trailing armed', 'Trailing peak', 'Release']);
  assert.equal(card.querySelectorAll('details details').length, 0);
  assert.match(window.document.querySelector('.paper-positions > details').textContent, /Terminal dust is excluded/);
  if (dimmed) {
    assert.match(card.textContent, /Position and breakeven below are not current/);
    assert.doesNotMatch(card.querySelector('.paper-dimmed-position').textContent, /profit or loss|Price: 700/);
    assert.equal(card.querySelector('.paper-dimmed-position').style.opacity, '0.6');
  }
  window.close();
});

test('phone cards with stale owner reads keep unavailability instead of reviving holdings or buy decisions', () => {
  const { PaperPositions } = frontendModules().load('v5/PaperPositions.tsx');
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperPositions, { ...positionProps(), now: now + 31_000 }));
  const card = window.document.querySelector('.paper-positions .paper-pair');
  assert.match(card.textContent, /position read unavailable/);
  assert.match(card.textContent, /current price or breakeven unavailable/);
  assert.doesNotMatch(card.textContent, /1\.234567890123456789|Buy decision: Held|748\.17 USDC/);
  window.close();
});

test('W6 phone CSS keeps single-column cards, bounded charts, wrapped legends and 44px controls without clipping facts', () => {
  assert.ok(css.startsWith('@media (width < 640px)'));
  assert.match(css, /\.paper-positions \.paper-pairs\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) !important/);
  assert.match(css, /\.paper-chart-coins\s*\{[^}]*grid-template-columns:\s*repeat\(5, minmax\(44px, 1fr\)\)/);
  assert.match(css, /\.paper-price-chart \.v5-button\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px/);
  assert.match(css, /\.recorded-candle-chart\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%/);
  assert.match(css, /\.recorded-candle-canvas\s*\{[^}]*height:\s*360px/);
  assert.match(css, /\.paper-chart-legend\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.paper-positions :is\([^}]*font-size:\s*12px/);
  assert.match(css, /\.paper-positions summary\s*\{[^}]*min-height:\s*44px/);
  assert.doesNotMatch(css, /(?:^|[;{])\s*overflow(?:-x)?:\s*(?:hidden|clip)|line-clamp:\s*[1-9]|text-overflow:\s*ellipsis/);
});
