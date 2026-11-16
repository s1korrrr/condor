import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';

test('Money retains exact owner values behind rounded zero tiles', () => {
  const rows = [{bot:'v5', at_ms:1794000000000, equity:'199980.07714623162240', initial_funding:'200000', realized:'-0.004', unrealized:'0', fees:'0.004', unit:'USDC'}];
  const {load} = frontendModules({
    '@tanstack/react-query': {useQuery: ({queryKey}) => ({data:queryKey[0] === 'v5-money' ? {rows, daily:[], range:'7d', sampler:true} : queryKey[0] === 'v5-profile' ? {} : undefined, refetch() {}})},
    '@/features/quant-ops/kit/charts': {BarsChart:() => null, TimeSeriesChart:() => null},
    '@/features/quant-ops/kit/DataTable': {DataTable:() => null},
  });
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(load('v5/V5Money.tsx').V5Money));
  const tiles = [...window.document.querySelectorAll('.v5m-stat')];
  for (const [label, exact] of [['Profit from closed trades','-0.004'], ['Fees paid','0.004']]) {
    const value = tiles.find(tile => tile.textContent.includes(label)).querySelector('[data-tone]');
    assert.equal(value.textContent, '0.00');
    assert.equal(value.title, exact);
    assert.equal(value.dataset.tone, 'zero');
  }
  window.close();
});
