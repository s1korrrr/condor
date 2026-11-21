import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Window } from 'happy-dom';
import { frontendModules, paperWorkspaceModules } from './helpers/frontend-module.mjs';
import { liveMoneyRows } from './helpers/v5-live-money.mjs';

test('wallet equity note keeps one inline text flow at desktop and phone widths', () => {
  const rows = [{bot:'v5', at_ms:1794000000000, equity:'199043.05', initial_funding:'200000', external_flows:'0', unit:'USDC'}];
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
    './usePaperClock': {usePaperClock: () => liveMoneyRows.at(-1).at_ms},
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
  const rows = [{bot:'v5', at_ms:1794000000000, equity:'199980.07714623162240', initial_funding:'200000', external_flows:'-0.00', realized:'-0.004', unrealized:'0', fees:'0.004', unit:'USDC'}];
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

const sampleAt = Date.UTC(2026, 10, 15, 12, 0, 0);
const moneyRead = (rows, now) => ({ rows, now_ms: now, daily: [], range: '7d', sampler: true });

function renderMoneyFixture(window, row, now, view, newest) {
  const rows = newest ? [row, newest] : [row];
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: ({ queryKey }) => ({ data: queryKey[0] === 'v5-money' ? moneyRead(rows, now) : undefined }) },
    '@/features/quant-ops/kit/charts': { BarsChart: () => null, TimeSeriesChart: () => null },
    '@/features/quant-ops/kit/DataTable': { DataTable: () => null },
    './V5Helm': { readHelm() {} },
    './usePaperClock': { usePaperClock: () => now },
  });
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(load(`v5/${view}.tsx`)[view])));
  const scope = view === 'V5Overview' ? window.document.querySelector('.v5-overview article') : window.document;
  return label => [...scope.querySelectorAll('.v5m-stat')].find(tile => tile.firstElementChild.textContent.startsWith(label));
}

for (const view of ['V5Money', 'V5Overview']) {
  for (const [flows, reason] of [['10', /external cash flows are not exactly zero/i], ['-0.00000000000000000001', /external cash flows are not exactly zero/i], [undefined, /external cash flows not published/i]]) {
    test(`${view} withholds since-start change when external flows are ${flows}`, () => {
      const row = { bot: 'v5', at_ms: sampleAt, equity: '111', initial_funding: '100', external_flows: flows, unit: 'USDC' };
      const window = new Window();
      try {
        const tile = renderMoneyFixture(window, row, sampleAt, view);
        assert.match(tile('Wallet equity').querySelector('strong').textContent, /111\.00/);
        if (view === 'V5Overview') assert.equal(tile('Since start').querySelector('strong').textContent, '—');
        const note = tile(view === 'V5Money' ? 'Wallet equity' : 'Since start').querySelector('small');
        assert.match(note.textContent, reason);
        assert.doesNotMatch(note.textContent, /11\.00|%/);
      } finally { window.close(); }
    });
  }
}

test('Overview dates the held-coin mark to its actual sample and labels it stale after six minutes', () => {
  const row = { bot: 'v5', at_ms: sampleAt, unrealized: '12', external_flows: '0' };
  const gap = { bot: 'v5', at_ms: sampleAt + 300_000, gap: 'owner_unavailable' };
  const window = new Window();
  try {
    const note = now => renderMoneyFixture(window, row, now, 'V5Overview', gap)('Coins still held').querySelector('small').textContent;
    assert.equal(note(sampleAt + 360_000), 'gain or loss at the last recorded sample (as of 2026-11-15 12:00:00.000Z)');
    assert.match(note(sampleAt + 360_001), /withheld.*stale.*2026-11-15 12:00:00\.000Z/i);
  } finally { window.close(); }
});

test('Overview withholds the noon held-coin mark when both clocks read 11:59 UTC', () => {
  const row = { bot: 'v5', unit: 'USDC', at_ms: sampleAt, unrealized: '12' };
  const window = new Window();
  try {
    const held = renderMoneyFixture(window, row, sampleAt - 60_000, 'V5Overview')('Coins still held');
    assert.equal(held.querySelector('strong').textContent, '—');
    assert.match(held.querySelector('small').textContent, /future|ahead/i);
  } finally { window.close(); }
});

test('Money tile explains the held-coin mark at the page clock boundaries', () => {
  const row = { bot: 'v5', unit: 'USDC', unrealized: '12', at_ms: sampleAt };
  const window = new Window();
  try {
    for (const [age, value, reason] of [
      [-60_000, '—', /ahead|future/i],
      [360_000, '▲ +12.00', /2026-11-15 12:00:00\.000Z/],
      [360_001, '—', /withheld.*stale/i],
    ]) {
      const tile = renderMoneyFixture(window, row, sampleAt + age, 'V5Money')('Gain or loss on coins still held');
      assert.equal(tile.querySelector('strong').textContent, value, String(age));
      assert.match(tile.querySelector('small').textContent, reason);
    }
  } finally { window.close(); }
});

test('Money, Overview and Bots publish the same held-coin mark at the sample time boundaries', () => {
  const { paperMoneyTiles } = paperWorkspaceModules().load('pages/tabs/ActiveBotsTab.tsx');
  const window = new Window();
  try {
    for (const [atMs, expected] of [
      [sampleAt, '12'], [sampleAt - 360_000, '12'], [sampleAt - 360_001, null],
      [sampleAt + 1, null], [undefined, null], ['invalid', null],
    ]) {
      const row = { bot: 'v5', unit: 'USDC', unrealized: '12', at_ms: atMs };
      const bots = paperMoneyTiles({ complete: false, now: sampleAt, money: moneyRead([row], sampleAt) })
        .find(tile => tile.label === 'Coins still held');
      const overview = renderMoneyFixture(window, row, sampleAt, 'V5Overview')('Coins still held');
      const money = renderMoneyFixture(window, row, sampleAt, 'V5Money')('Gain or loss on coins still held');
      assert.equal(bots.exact ?? null, expected, String(atMs));
      assert.equal(overview?.querySelector('strong [title]')?.title ?? null, bots.exact ?? null, String(atMs));
      assert.equal(money.querySelector('strong [title]')?.title ?? null, bots.exact ?? null, String(atMs));
    }
  } finally { window.close(); }
});
