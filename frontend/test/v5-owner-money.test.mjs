import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';
import { liveMoneyRows } from './helpers/v5-live-money.mjs';

test('wallet equity note keeps one inline text flow at desktop and phone widths', () => {
  const rows = [{bot:'v5', at_ms:1794000000000, equity:'199043.05', initial_funding:'200000', unit:'USDC'}];
  const {load} = frontendModules({
    '@tanstack/react-query': {useQuery: ({queryKey}) => ({data:queryKey[0] === 'v5-money' ? {rows, daily:[], range:'7d', sampler:true} : queryKey[0] === 'v5-profile' ? {} : undefined, refetch() {}})},
    '@/features/quant-ops/kit/charts': {BarsChart:() => null, TimeSeriesChart:() => null},
    '@/features/quant-ops/kit/DataTable': {DataTable:() => null},
  });
  const html = renderToStaticMarkup(React.createElement(load('v5/V5Money.tsx').V5Money));
  const css = ['market.css','phone.css'].map(name => fs.readFileSync(new URL(`../src/v5/${name}`,import.meta.url),'utf8')).join('\n');
  for (const width of [1280,430,390]) {
    const window = new Window({width});
    try {
      window.document.head.innerHTML = `<style>${css}</style>`;
      window.document.body.className = 'condor-native';
      window.document.body.innerHTML = html;
      const tile = [...window.document.querySelectorAll('.v5m-stat')].find(item => item.firstElementChild.textContent.startsWith('Wallet equity'));
      const note = tile.querySelector('small');
      assert.equal(note.textContent, '▼ −956.95 vs the 200,000.00 USDC start (−0.48%)');
      assert.equal(window.getComputedStyle(tile.firstElementChild).display, 'block');
      assert.equal(window.getComputedStyle(note).display, 'block');
      for (const span of note.querySelectorAll('span')) {
        assert.equal(window.getComputedStyle(span).display || 'inline', 'inline', `${width}px: ${span.textContent} must flow within the note`);
        assert.equal(window.getComputedStyle(span).fontSize, window.getComputedStyle(note).fontSize);
      }
      assert.equal(note.querySelector('.owner-value').title, '199043.05 − 200000 = −956.95');
      assert.equal(note.querySelector('.owner-value').dataset.tone, 'down');
      assert.equal(note.querySelectorAll('span[title]')[1].title, '200000');
      assert.equal(note.querySelectorAll('span[title]')[2].title, '(199043.05 − 200000) × 100 / 200000 = −0.478475%');
    } finally { window.close(); }
  }
});

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
  assert.equal(note.querySelector('[data-tone]').title, '≈ 199980.077146231622 (rounded) − 200000 = ≈ −19.922853768378 (rounded)');
  assert.equal(note.querySelectorAll('span[title]')[2].title, '(≈ 199980.077146231622 (rounded) − 200000) × 100 / 200000 = ≈ −0.009961426884 (rounded)%');
  window.close();
});
