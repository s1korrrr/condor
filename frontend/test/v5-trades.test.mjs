import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { groupTrades, lotBreakeven, targetFromBreakeven, tradeWindow } from '../src/v5/trades-model.mjs';
import { frontendModules } from './helpers/frontend-module.mjs';
import { paperObservationPages } from '../src/v5/policy.ts';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));

test('groups retained fills by executor and deduplicates closed history', () => {
  const rows = groupTrades([{executor_id:'a',terminal:false},{executor_id:'b',terminal:true}], [{executor_id:'b'},{executor_id:'c'}], [{executor_id:'a',order_id:'oa',trade_id:'ta',side:'BUY'},{executor_id:'b',order_id:'ob',trade_id:'tb',side:'SELL'},{executor_id:'other',order_id:'oc',trade_id:'tc',side:'BUY'}]);
  assert.equal(rows.length,3);
  assert.deepEqual(rows.find(row => row.executor_id === 'a').fills.map(fill => fill.side),['BUY']);
  assert.equal(rows.find(row => row.executor_id === 'c').terminal,true);
});

test('window names retained limits and lifetime export', () => {
  assert.match(tradeWindow('500','320',true,true),/newest 500 retained fills and 320 closed trades/);
  assert.match(tradeWindow('500','320',true,true),/more retained records.*owner's lifetime export.*incomplete/);
});

test('lot calculations use exact integers and round without floating point', () => {
  assert.equal(lotBreakeven('100000000000000000000.000000000001','3'), '33333333333333333333.333333333334');
  assert.equal(lotBreakeven('1','0'),null);
  assert.equal(targetFromBreakeven('3','2','2'), '33.33');
  assert.equal(targetFromBreakeven('4','2','1'), '-50.00');
  assert.equal(targetFromBreakeven('0','2','1'), null);
});

test('five-page history walk retains the continuation cursor', async () => {
  const base = fixture('history');
  let calls = 0;
  const read = await paperObservationPages('/history', async () => {
    calls += 1;
    return {...base, state:'degraded', completeness:'partial', next_cursor:String(calls), data:{...base.data,segments:[],terminal_executors:{completeness:'partial',capabilities:['read'],data:{delivery:'publication_pages',publication_record_count:6,records:[{executor_id:`id-${calls}`}]}}}};
  }, 5);
  assert.equal(calls,5);
  assert.equal(read.data.terminal_executors.data.records.length,5);
  assert.equal(read.next_cursor,'5');
});

function reads() {
  const sections = Object.fromEntries(['status','executors','fills','positions','wallet','history','accounting'].map(section => [section,fixture(section)]));
  const executor = sections.executors.data[0];
  sections.fills.data = [{...sections.fills.data[0],executor_id:executor.executor_id,trading_pair:executor.trading_pair}];
  sections.fills.data.push({...sections.fills.data[0],executor_id:'other-executor',trade_id:'other-trade'});
  sections.positions.data = [{...sections.positions.data[0],executor_id:executor.executor_id,trading_pair:executor.trading_pair,quantity:'3',remaining_basis_quote:'100.000000000001',target_price:'40'}];
  sections.history.data.terminal_executors = {completeness:'partial',capabilities:['read'],data:{delivery:'publication_pages',records:[],publication_record_count:0}};
  sections.orders = {...sections.executors,section:'orders',data:[{order_id:'fixture-order',executor_id:executor.executor_id,side:'SELL',trading_pair:executor.trading_pair,quantity:'3',price:'40',created_at_ms:sections.status.generated_at_ms - 1000}]};
  return sections;
}

for (const key of ['fees_paid_quote', 'volume_traded_quote']) {
  test(`accounting totals render signed ${key}`, () => {
    const sections = reads();
    sections.accounting.data.controllers = { signed: { realized_pnl_quote: '0', fees_paid_quote: '0', volume_traded_quote: '0', entry_count: 0, exit_count: 0, [key]: '-0.01' } };
    const { TradesContent } = frontendModules().load('v5/V5Trades.tsx');
    const window = new Window();
    try {
      window.document.body.innerHTML = renderToStaticMarkup(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms}));
      const accounting = [...window.document.querySelectorAll('section')].find(section => section.querySelector('h2')?.textContent === 'Totals by coin');
      const cell = accounting.querySelectorAll('tbody td')[key === 'fees_paid_quote' ? 2 : 3];
      assert.equal(cell.textContent, '−0.01 USDC');
      assert.equal(cell.querySelector('[title]').title, '-0.01');
    } finally {
      window.close();
    }
  });
}

test('every accounting column sums mixed signs exactly', () => {
  const { sum } = frontendModules({}, {'v5/V5Trades.tsx':['sum']}).load('v5/V5Trades.tsx');
  for (const key of ['realized_pnl_quote', 'fees_paid_quote', 'volume_traded_quote']) {
    assert.equal(sum([{[key]:'0.02'}, {[key]:'-0.03'}], key), '-0.01');
    assert.equal(sum([{[key]:'-0.01'}, {[key]:'0.03'}], key), '0.02');
    assert.equal(sum([{[key]:'100000000000000000000.01'}, {[key]:'-100000000000000000000.02'}], key), '-0.01');
    assert.equal(sum([{[key]:'0.01'}, {[key]:'-0.01'}], key), '0.00');
    assert.equal(sum([{[key]:'0.01'}, {[key]:'invalid'}], key), null);
    assert.equal(sum([{[key]:'0.01'}, {}], key), null);
  }
});

test('fixed-pair trade detail omits coin selector from the DOM', async () => {
  const sections = reads();
  const { TradesContent } = frontendModules({ './paper-candles':{PAIRS:['BNB-USDC','BTC-USDC','ETH-USDC','SOL-USDC','XRP-USDC'], latestFinalCandle:() => null, usePaperCandleSymbols:() => ({}), hasPaperCandlePair:() => false, paperCandleQuery:() => ({})}, '@tanstack/react-query':{useQuery:() => ({})} }).load('v5/V5Trades.tsx');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer;
  try {
    await act(async () => { renderer = create(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms})); });
    await act(async () => { renderer.root.findAllByType('button').find(button => button.children[0] === 'View trade').props.onClick(); });
    const chart = renderer.root.findAllByType('section').find(section => section.props.className === 'paper-section paper-price-chart');
    assert.ok(chart);
    for (const width of [390,430]) {
      const window = new Window({width,height:844});
      try {
        window.document.body.innerHTML = renderToStaticMarkup(chart.props.children);
        assert.equal(window.document.querySelectorAll('[aria-label="Chart coin"]').length, 0);
        assert.equal(window.document.querySelectorAll('.paper-chart-coins').length, 0);
        assert.deepEqual([...window.document.querySelectorAll('[aria-label="Chart range"] button')].map(button => button.textContent), ['1D','7D']);
      } finally {
        window.close();
      }
    }
  } finally {
    await act(async () => renderer?.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('trade detail renders fills, lots, orders and honest unpublished metrics', async () => {
  const sections = reads();
  let chartFills;
  const { TradesContent } = frontendModules({'./PaperPriceChart':{PaperPriceChart:props => {chartFills = props.fills; return null;}}, './paper-candles':{usePaperCandleSymbols:() => ({}), hasPaperCandlePair:() => false, paperCandleQuery:() => ({})}, '@tanstack/react-query':{useQuery:() => ({})}}).load('v5/V5Trades.tsx');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer;
  try {
    await act(async () => { renderer = create(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms})); });
    await act(async () => { renderer.root.findAllByType('button').find(button => button.children[0] === 'View trade').props.onClick(); });
    const text = JSON.stringify(renderer.toJSON());
    assert.match(text,/Average entry price: —/);
    assert.match(text,/partial fills cannot establish exact averages or margin/);
    assert.match(text,/fixture-order/);
    assert.match(text,/Breakeven/);
    assert.match(text,/100\.000000000001 \/ 3/);
    assert.match(text,/Distance to target/);
    assert.match(text,/Owner mark/);
    assert.deepEqual(chartFills.data.map(fill => fill.executor_id),[sections.executors.data[0].executor_id]);
    const pair = sections.executors.data[0].trading_pair;
    const mark = sections.wallet.data.assets.find(item => item.asset === pair.split('-')[0]);
    assert.ok(mark);
    assert.ok(renderer.root.findAllByProps({title:mark.mark_quote}).length > 0);
    await act(async () => { renderer.update(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms + 31000})); });
    assert.equal(renderer.root.findAllByProps({title:mark.mark_quote}).length,0);
  } finally {
    await act(async () => renderer?.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('expired and future snapshots withhold records', () => {
  const sections = reads();
  const { TradesContent } = frontendModules().load('v5/V5Trades.tsx');
  for (const now of [sections.status.generated_at_ms - 1, sections.status.generated_at_ms + 120001]) {
    const html = renderToStaticMarkup(React.createElement(TradesContent,{reads:Object.values(sections),now}));
    assert.match(html,/unavailable or expired/);
    assert.doesNotMatch(html,/fixture-order/);
  }
});

test('future-dated orders are withheld and controller totals are not labeled lifetime coin totals', () => {
  const sections = reads();
  sections.orders.data[0].created_at_ms = sections.status.generated_at_ms + 1;
  const { TradesContent } = frontendModules().load('v5/V5Trades.tsx');
  const html = renderToStaticMarkup(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms}));
  assert.match(html,/Future-dated records are withheld/);
  assert.doesNotMatch(html,/fixture-order/);
  assert.match(html,/do not establish lifetime coin attribution/);
});

test('controller loss remains an exact signed profit', () => {
  const sections = reads();
  Object.values(sections.accounting.data.controllers)[0].realized_pnl_quote = '-0.01';
  const { TradesContent } = frontendModules().load('v5/V5Trades.tsx');
  const html = renderToStaticMarkup(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms}));
  assert.match(html,/title="-0\.01"[^>]*>▼ −0\.01/);
});

test('unlinked fills remain discoverable without an invented executor', () => {
  const sections = reads();
  sections.fills.data.push({...sections.fills.data[0],executor_id:null,trade_id:'unlinked-fill'});
  const { TradesContent } = frontendModules().load('v5/V5Trades.tsx');
  const html = renderToStaticMarkup(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms}));
  assert.match(html,/Fills not linked to a shown trade/);
  assert.match(html,/unlinked-fill/);
  assert.match(html,/No executor published/);
  assert.match(html,/outside the retained history/);
});

test('duplicate owner identities count once but distinct partial fills remain', () => {
  const fill = {executor_id:'a',order_id:'order',trade_id:'one',side:'BUY'};
  const rows = groupTrades([{executor_id:'a',terminal:false}], [], [fill,{...fill},{...fill,trade_id:'two'}]);
  assert.equal(rows[0].fills.length,2);
  assert.deepEqual(rows[0].fills.map(row => row.trade_id),['one','two']);
});

test('conflicting fill identities withhold every implicated trade', () => {
  const sections = reads();
  sections.executors.data = [sections.executors.data[0]];
  sections.fills.data.push({...sections.fills.data[0],quantity:'999'});
  const { TradesContent } = frontendModules().load('v5/V5Trades.tsx');
  const html = renderToStaticMarkup(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms}));
  assert.match(html,/conflicting.*fill/i);
  assert.doesNotMatch(html,/View trade/);
});

test('a future-dated conflicting duplicate cannot revive its trade', () => {
  const sections = reads();
  sections.executors.data = [sections.executors.data[0]];
  sections.fills.data.push({...sections.fills.data[0],event_at_ms:sections.status.generated_at_ms + 1});
  const { TradesContent } = frontendModules().load('v5/V5Trades.tsx');
  const html = renderToStaticMarkup(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms}));
  assert.match(html,/conflicting.*fill/i);
  assert.doesNotMatch(html,/View trade/);
});

test('a conflicting identity with different executors withholds both', () => {
  const fill = {executor_id:'a',order_id:'order',trade_id:'one',side:'BUY'};
  const trades = groupTrades([{executor_id:'a'},{executor_id:'b'},{executor_id:'c'}], [], [fill,{...fill,executor_id:'b'}]);
  assert.deepEqual(trades.map(row => row.executor_id),['c']);
});

test('owner bag breakeven is shown separately from a derived lot breakeven', async () => {
  const sections = reads();
  sections.decisions = fixture('decisions');
  const pair = sections.executors.data[0].trading_pair;
  const bag = sections.decisions.data.controllers.find(row => row.pair === pair).custom_info.bag;
  const { TradesContent } = frontendModules({'./PaperPriceChart':{PaperPriceChart:() => null}, './paper-candles':{usePaperCandleSymbols:() => ({}), hasPaperCandlePair:() => false, paperCandleQuery:() => ({})}, '@tanstack/react-query':{useQuery:() => ({})}}).load('v5/V5Trades.tsx');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer;
  try {
    await act(async () => { renderer = create(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms})); });
    await act(async () => { renderer.root.findAllByType('button').find(button => button.children[0] === 'View trade').props.onClick(); });
    const text = JSON.stringify(renderer.toJSON());
    assert.match(text,/Owner bag breakeven/);
    assert.ok(renderer.root.findAllByProps({title:bag.breakeven_price}).length > 0);
    assert.match(text,/100\.000000000001 \/ 3/);
    sections.positions.data[0].breakeven_price = '24.1234567';
    await act(async () => { renderer.update(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms})); });
    assert.ok(renderer.root.findAllByProps({title:'24.1234567'}).length > 0);
    assert.equal(renderer.root.findAllByProps({title:'100.000000000001 / 3'}).length,0);
  } finally {
    await act(async () => renderer?.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('failed refresh and held heartbeat dim all retained trade panels', () => {
  const sections = reads();
  const { TradesContent } = frontendModules().load('v5/V5Trades.tsx');
  for (const extra of [{readFailed:true,heartbeat:'Fresh'},{readFailed:false,heartbeat:'Stale'}]) {
    const html = renderToStaticMarkup(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms,...extra}));
    assert.match(html,/not current/i);
    assert.match(html,/opacity:\s*0\.6/);
    assert.match(html,/title="40"/);
  }
});

test('a held owner dims a fresh retained snapshot', () => {
  const sections = reads();
  const { TradesContent } = frontendModules().load('v5/V5Trades.tsx');
  const html = renderToStaticMarkup(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms,heartbeat:'Stale'}));
  assert.match(html,/not current/i);
  assert.match(html,/opacity:\s*0\.6/);
  assert.match(html,/Owner heartbeat is not current/);
});

test('trade-owned refresh error dims retained snapshot', () => {
  const sections = reads();
  const { V5Trades } = frontendModules({'./usePaperSnapshot':{usePaperSnapshot:() => ({data:Object.values(sections),isError:true,error:new Error('fixture failure')})}}).load('v5/V5Trades.tsx');
  const html = renderToStaticMarkup(React.createElement(V5Trades,{bot:'bot',now:sections.status.generated_at_ms,read:() => {},heartbeat:'Fresh'}));
  assert.match(html,/fixture failure/);
  assert.match(html,/not current/i);
  assert.match(html,/opacity:\s*0\.6/);
});

test('trade owner values retain exact titles and rounded-zero tone', () => {
  const sections = reads();
  sections.executors.data[0].realized_pnl_quote = '-0.001';
  sections.executors.data[0].cum_fees_quote = '12.34567';
  const { TradesContent } = frontendModules().load('v5/V5Trades.tsx');
  const html = renderToStaticMarkup(React.createElement(TradesContent,{reads:Object.values(sections),now:sections.status.generated_at_ms}));
  assert.match(html,/title="-0\.001" data-tone="zero">0<\/span>/);
  assert.match(html,/title="12\.34567"[^>]*>12\.35 USDC/);
});

test('phone layout keeps a text floor and scrolls wide tables', () => {
  const css = fs.readFileSync(new URL('../src/v5/v5-trades.css',import.meta.url),'utf8');
  assert.match(css,/font-size:\s*14px/);
  assert.match(css,/overflow-x:\s*auto/);
  assert.match(css,/max-width:\s*100%/);
  for (const width of [390,430]) {
    const window = new Window({width,height:844});
    window.document.head.innerHTML = `<style>${css}</style>`;
    window.document.body.innerHTML = '<div class="v5-trades"><div class="v5-trades-scroll"><table><tr><td>Trade</td></tr></table></div></div>';
    assert.equal(window.innerWidth,width);
    assert.equal(window.getComputedStyle(window.document.querySelector('table')).fontSize,'14px');
    assert.equal(window.getComputedStyle(window.document.querySelector('.v5-trades-scroll')).overflowX,'auto');
    window.close();
  }
});

test('Trades subview requests five bounded history pages and owner orders', () => {
  const source = fs.readFileSync(new URL('../src/v5/V5Trades.tsx',import.meta.url),'utf8');
  const bots = fs.readFileSync(new URL('../src/pages/tabs/ActiveBotsTab.tsx',import.meta.url),'utf8');
  assert.match(source,/section: 'history'.*maxPages: 5/);
  assert.match(source,/section: 'orders'.*botPath.*orders/);
  assert.match(bots,/showTrades && <V5Trades/);
});
