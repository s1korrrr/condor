import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';
import { liveMoneyRows } from './helpers/v5-live-money.mjs';

test('live-shaped Money comparison renders both values and styled owner tiles', () => {
  const closes = Object.fromEntries(['BTC','ETH','BNB','SOL','XRP'].map(coin => [coin, [[1794219300,100.123456789],[1794824100,86.144123456]]]));
  const {load} = frontendModules({
    '@tanstack/react-query': {useQuery: ({queryKey}) => ({data:queryKey[0] === 'v5-money' ? {rows:liveMoneyRows, daily:[], range:'7d', sampler:true} : queryKey[0] === 'v5-profile' ? {candle_store:{configured:true}} : {closes}, refetch() {}})},
    '@/features/quant-ops/kit/charts': {BarsChart:() => null, TimeSeriesChart:() => null},
    '@/features/quant-ops/kit/DataTable': {DataTable:() => null},
  });
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(load('v5/V5Money.tsx').V5Money));
  const tiles = [...window.document.querySelectorAll('.v5m-stat')];
  for (const label of ['Holding the five coins','V5 wallet equity']) assert.match(tiles.find(tile => tile.firstElementChild.textContent === label).querySelector('strong').textContent, /[−+]?\d[\d,.]*%/);
  for (const [label, tone] of [['Profit from closed trades','up'], ['Gain or loss on coins still held','down']]) {
    const tile = tiles.find(item => item.firstElementChild.textContent === label);
    assert.ok(tile.querySelector('strong').classList.contains(`is-${tone}`));
    assert.ok(tile.querySelector('strong > .owner-value'));
  }
  assert.ok(tiles.find(tile => tile.firstElementChild.textContent.startsWith('Fees paid')).querySelector('strong > em.v5-desktop-unit'));
  window.close();
});

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
  const note = tiles.find(tile => tile.textContent.includes('Wallet equity')).querySelector('small');
  assert.match(note.textContent, /−19\.92 vs the 200,000\.00 USDC start/);
  assert.equal(note.querySelector('[data-tone]').title, '199980.07714623162240 − 200000 = −19.92285376837760');
  assert.equal(note.querySelectorAll('span[title]')[2].title, '(199980.07714623162240 − 200000) × 100 / 200000 = −0.0099614268841888%');
  window.close();
});
