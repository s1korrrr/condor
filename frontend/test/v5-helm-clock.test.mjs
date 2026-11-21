// Every Helm age is judged at the server's read time plus the time since that read arrived, on Helm and on Overview:
// a decision keeps ageing while the page stays mounted, and a read with no server time claims no age. Each coin row
// keeps its own last decision.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';

const browser = new Window({ url: 'https://fixture.invalid/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'localStorage']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? browser : browser[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');

const READ_S = Date.UTC(2026, 10, 6, 12) / 1000; // 6 Nov 2026 12:00 UTC, the server's time at the read
const coin = (pair, last_decision = null) => ({ pair, status: 'portfolio_grant_required', candidate_hold: 'no_rebound', signal: null, bag: null, last_decision });
const status = (extra = {}) => ({ generated_at: READ_S, age_s: 0, reasons: [], ready: true, withheld: 0, gates: [{ gate: 'ready', note: '' }], control_rejections: { count: 0, recent: [] }, actions: 350, steps: 1000, symbols: [coin('BNB-USDC')], ...extra });

/** Mounts the real page; `tick(ms)` moves the clock on and fires the page's one-second timer, as the browser would. */
async function mount(page, extra, { observedAt = READ_S } = {}) {
  const read = { state: 'FRESH', bot: 'helm_v5_paper', observed_at: observedAt, status: status(extra) };
  const updatedAt = READ_S * 1000;
  const originalNow = Date.now, timers = [];
  let nowMs = updatedAt;
  Date.now = () => nowMs;
  browser.setInterval = callback => timers.push(callback);
  browser.clearInterval = () => {};
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: ({ queryKey }) => queryKey[0] === 'v5-helm' ? { data: read, dataUpdatedAt: updatedAt, isPending: false, refetch() {} } : { data: undefined, isPending: true } },
    './V5Money': { V5Money: () => null, readMoney() {} },
    './V5Helm': { readHelm() {} },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const element = page === 'helm' ? React.createElement(frontendModules({ '@tanstack/react-query': { useQuery: () => ({ data: read, dataUpdatedAt: updatedAt, refetch() {} }) } }).load('v5/V5Helm').V5Helm)
    : React.createElement(MemoryRouter, null, React.createElement(load('v5/V5Overview.tsx').V5Overview));
  await React.act(async () => { root.render(element); });
  return {
    text: () => container.textContent,
    rows: () => [...container.querySelectorAll('.v5m-helm-coins tbody tr')].map(row => row.children[3].textContent),
    async tick(ms) { nowMs += ms; await React.act(async () => { timers.forEach(callback => callback()); }); },
    async done() { await React.act(async () => { root.unmount(); }); container.remove(); Date.now = originalNow; },
  };
}

for (const page of ['helm', 'overview']) {
  test(`${page}: a decision keeps ageing while the page stays mounted`, async () => {
    const view = await mount(page, { symbols: [coin('BNB-USDC', { at: READ_S - 20, reason: 'sell_placed' })] });
    try {
      assert.match(view.text(), /20 s ago · sell placed/);
      await view.tick(10_000);
      assert.match(view.text(), /30 s ago · sell placed/);
    } finally { await view.done(); }
  });

  test(`${page}: a decision stamped after the read says ahead of this read, not 0 s ago`, async () => {
    const view = await mount(page, { generated_at: READ_S + 4, symbols: [coin('BNB-USDC', { at: READ_S + 4, reason: 'sell_placed' })] });
    try {
      assert.match(view.text(), /ahead of this read · sell placed/);
      assert.doesNotMatch(view.text(), /UTC · 0 s ago/);
    } finally { await view.done(); }
  });

  test(`${page}: a read with no server time shows the decision without an age`, async () => {
    const view = await mount(page, { symbols: [coin('BNB-USDC', { at: READ_S - 20, reason: 'sell_placed' })] }, { observedAt: null });
    try {
      assert.match(view.text(), /11:59 UTC · sell placed/);
      assert.doesNotMatch(view.text(), /\d+ s ago · sell placed/);
      assert.doesNotMatch(view.text(), /NaN/);
    } finally { await view.done(); }
  });
}

test('two controllers on one pair each keep their own last decision', async () => {
  const view = await mount('helm', { symbols: [coin('BNB-USDC', { at: READ_S - 25 * 60, reason: 'store_executor_action' }), coin('BNB-USDC', { at: READ_S - 85 * 60, reason: 'sell_placed' })] });
  try {
    const [first, second] = view.rows();
    assert.match(first, /11:35 UTC · 25 min ago · store executor action/);
    assert.match(second, /10:35 UTC · 85 min ago · sell placed/);
  } finally { await view.done(); }
});
