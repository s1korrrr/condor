import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRequire} from 'node:module';
const {QueryClient, QueryClientProvider} = createRequire(import.meta.url)('@tanstack/react-query');
import {frontendModules} from './helpers/frontend-module.mjs';

const {load} = frontendModules({
  'react-markdown': {default: () => null},
  'remark-gfm': {default: () => null},
  '@/components/charts/ExecutorChart': {ExecutorChart: () => null},
  '@/components/agent/AgentPnlChart': {AgentPnlChart: () => null},
  '@/hooks/useRates': {useRates: () => ({})},
});
const {SessionKpis, SessionExecutors} = load('components/agent/AgentSessionContent.tsx');
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const current = {
  current_book_status: 'available', total_pnl: 0, realized_pnl: 0,
  unrealized_pnl: 0, open_count: 0, volume: 0, fees: 0, trade_count: 0,
  close_type_counts: {}, fees_known: true,
};

for (const status of ['partial', 'unavailable']) {
  test(`session ${status} inventory cannot display a flat current book`, () => {
    const output = text(render(SessionKpis, {perf: {...current, current_book_status: status,
      total_pnl: null, unrealized_pnl: null, open_count: null, realized_pnl: 7}}));
    assert.match(output, /Current inventory unavailable/);
    assert.match(output, /Total PnL —/);
    assert.match(output, /Unrealized —/);
    assert.match(output, /Open —/);
    assert.match(output, /Realized \+\$7\.00/);
  });
}
test('pending session read keeps every unsupplied economic value unknown', () => {
  const output = text(render(SessionKpis, {}));
  for (const label of ['Total PnL', 'Realized', 'Unrealized', 'Volume', 'Fees', 'Closes', 'Open']) {
    assert.ok(output.includes(`${label} —`), output);
  }
});
test('a supplied complete zero book retains zero current counts', () => {
  const output = text(render(SessionKpis, {perf: current}));
  assert.doesNotMatch(output, /Current inventory unavailable/);
  assert.match(output, /Open 0/);
  assert.match(output, /Closes 0/);
});
test('null executor read is unavailable rather than no open positions', () => {
  const client = new QueryClient();
  client.setQueryDefaults(['strategy-session-executors','fixture','inventory',1], {staleTime: Infinity});
  client.setQueryData(['strategy-session-executors','fixture','inventory',1], {
    executors: null, performance: {...current, current_book_status: 'unavailable'}, pnl_series: [],
  });
  const output = text(renderToStaticMarkup(React.createElement(QueryClientProvider, {client},
    React.createElement(SessionExecutors, {slug:'fixture', sslug:'inventory', sessionNum:1, serverName:'', botMode:true}))));
  assert.match(output, /Current executor and position inventory is unavailable/);
  assert.doesNotMatch(output, /No open positions/);
  client.clear();
});

for (const status of ['partial', 'unavailable']) {
  test(`known position subset retains an in-panel ${status} warning`, () => {
    // Start the real component on its Positions tab; all render and query logic remains real.
    const {load: loadPane} = frontendModules({
      react: {...React, useState: initial => React.useState(initial === 'executors' ? 'positions' : initial)},
      '@/hooks/useRates': {useRates: () => ({formatPnlValue: value => String(value), formatValue: value => String(value)})},
    });
    const {TradeBottomPane} = loadPane(process.env.INVENTORY_PANE_SOURCE ?? 'components/trade/TradeBottomPane.tsx');
    const client = new QueryClient();
    const output = text(renderToStaticMarkup(React.createElement(QueryClientProvider, {client},
      React.createElement(TradeBottomPane, {
        executors: [], positionsStatus: status, isLoadingPositions: false,
        connector: 'okx', pair: 'BNB-USDC', isSpot: true,
        positions: [{connector_name:'okx', trading_pair:'BNB-USDC', position_side:'buy', amount:0.5,
          entry_price:100, current_price:120, notional_value:60, unrealized_pnl:10,
          realized_pnl:0, cum_fees:0, leverage:1, source:'executor', source_name:'confirmed'}],
      }))));
    assert.match(output, /Known positions only/);
    assert.match(output, /0\.5000/);
    assert.doesNotMatch(output, /No positions for this pair/);
    client.clear();
  });
}
