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
  const rows = groupTrades([{executor_id:'a',terminal:false},{executor_id:'b',terminal:true}], [{executor_id:'b'},{executor_id:'c'}], [{executor_id:'a',side:'BUY'},{executor_id:'b',side:'SELL'},{executor_id:'other',side:'BUY'}]);
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
