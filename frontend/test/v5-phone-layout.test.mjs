import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';

const css = fs.readFileSync(new URL('../src/v5/phone.css', import.meta.url), 'utf8');
const now = Date.UTC(2026, 10, 15, 12, 34, 56);

function shell(pathname, paper = true) {
  const { load } = frontendModules({
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries() {} }), useQuery: () => ({ data: paper ? { readiness: { paper_owner: { bot_name: 'fixture', mode: 'PAPER' } } } : {} }) },
    '@/hooks/useTheme': { useTheme: () => ({ theme: 'dark', toggleTheme() {} }) },
    '@/lib/auth': { useAuth: () => ({ logout() {} }) },
    './usePaperClock': { usePaperClock: () => now },
  });
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [pathname] }, React.createElement(load('v5/V5AppShell.tsx').V5AppShell, null, React.createElement('h1', null, 'Page content'))));
  return window.document;
}

for (const [path, active] of [['/', 'Overview'], ['/capital', 'Overview'], ['/bots', 'Bots'], ['/helm', 'Bots'], ['/market/stocks', 'Market'], ['/market/BTC', 'Market'], ['/operations', 'System'], ['/settings', 'System'], ['/v5/readiness', 'System'], ['/agents/fixture', 'Research'], ['/research-factory', 'Research']]) {
  test(`phone tab bar has five groups and one active group on ${path}`, () => {
    const document = shell(path);
    const tabs = document.querySelector('[aria-label="Main navigation"]');
    assert.deepEqual([...tabs.querySelectorAll('a')].map(link => link.textContent), ['Overview', 'Bots', 'Market', 'System', 'Research']);
    assert.equal(tabs.querySelectorAll('[aria-current="page"]').length, 1);
    assert.equal(tabs.querySelector('[aria-current="page"]').textContent, active);
    assert.ok([...tabs.querySelectorAll('a')].every(link => link.classList.contains('v5-shell-link')));
    assert.match(css, /\.v5-shell-link\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*56px/s);
  });
}

test('phone chrome keeps a UTC clock, truthful scope, System tools and a vacant W4 slot', () => {
  const document = shell('/operations');
  assert.equal(document.querySelector('.v5-shell-clock').textContent, '12:34:56 UTC');
  assert.equal(document.querySelector('time').getAttribute('datetime'), new Date(now).toISOString());
  assert.equal(document.querySelector('.v5-shell-scope-short').textContent, 'PAPER');
  assert.equal(shell('/', false).querySelector('.v5-shell-scope-short').textContent, 'ADVISOR');
  const header = document.querySelector('header');
  assert.equal(header.nextElementSibling.id, 'v5-shell-status-slot');
  assert.equal(header.nextElementSibling.childNodes.length, 0);
  assert.equal(document.querySelector('[aria-label="System tools"] a').getAttribute('href'), '/settings');
  assert.match(document.querySelector('[aria-label="System tools"]').textContent, /Theme: dark/);
  assert.equal(shell('/bots').querySelector('[aria-label="System tools"]'), null);
  assert.equal(document.querySelector('.v5-phone-safety'), null);
  assert.equal(document.querySelector('main a[href="/v5/readiness"]'), null);
  assert.ok(document.querySelector('[aria-label="System pages"] a[href="/v5/readiness"]'));
  assert.match(document.querySelector('.v5-shell-safety').textContent, /live disabled/);
  assert.ok(document.querySelector('main h1'));
});

test('phone frame and Overview have legible type and units in labels without altering desktop amounts', () => {
  for (const selector of ['v5-shell-scope', 'v5-shell-clock', 'v5-shell-link']) {
    assert.match(css, new RegExp(`\\.${selector}\\s*\\{[^}]*font-size:\\s*12px`));
  }
  assert.match(css, /\.v5-overview :is\([^}]*svg text\)[^}]*font-size:\s*12px !important/);
  assert.match(css, /\.v5-phone-unit\s*\{\s*display:\s*inline/);
  assert.match(css, /\.v5-desktop-unit\s*\{\s*display:\s*none/);
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: ({ queryKey }) => ({ data: queryKey[0] === 'v5-money' ? { rows: [{ bot: 'v5', at_ms: now, equity: '199133.37', initial_funding: '200000.00' }] } : undefined }) },
    './V5Money': { V5Money: () => null, readMoney() {} },
    './V5Helm': { readHelm() {} },
  }, { 'v5/V5Money.tsx': ['Stat'] });
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(load('v5/V5Overview.tsx').V5Overview)));
  const wallet = window.document.querySelector('.v5m-stat');
  assert.match(wallet.querySelector('span').textContent, /Wallet equity \(USDC\)/);
  assert.equal(wallet.querySelector('strong').textContent, '199,133.37 USDC');
  assert.equal(wallet.querySelector('.v5-phone-unit').textContent, ' (USDC)');
  const { Stat } = load('v5/V5Money.tsx');
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(Stat, { label: 'Wallet equity', value: '199,133.37', unit: 'USDC' }));
  assert.equal(window.document.querySelector('strong').textContent, '199,133.37 USDC');
  assert.equal(window.document.querySelector('span').textContent, 'Wallet equity (USDC)');
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(Stat, { label: 'Wallet equity', value: '—', unit: 'USDC' }));
  assert.equal(window.document.querySelector('strong').textContent, '—');
});

test('phone CSS confines layout changes, keeps chips independently scrollable and reserves bottom safe area', () => {
  assert.match(css, /^@media \(width < 640px\) \{/);
  assert.match(css, /\.v5-shell-header\s*\{[^}]*height:\s*48px/s);
  assert.match(css, /\.v5-shell-subnav\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.v5-shell-nav\.is-open\s*\{[^}]*position:\s*fixed;[^}]*repeat\(5, minmax\(0, 1fr\)\)/s);
  assert.match(css, /\.v5-shell-main\s*\{[^}]*66px \+ env\(safe-area-inset-bottom/s);
  assert.doesNotMatch(css, /(?:^|[;{])\s*overflow(?:-x)?:\s*(?:hidden|clip)/);
  assert.match(css, /:is\(a, button,[^}]*min-width:\s*44px; min-height:\s*44px/s);
});

test('phone tiles never inherit desktop spans or ellipsize numbers, while legends wrap without overlapping targets', () => {
  assert.match(css, /\.q-tile-grid[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(css, /\.q-tile-cell\s*\{\s*grid-column:\s*auto !important/s);
  assert.match(css, /\.q-kpi > strong[^}]*white-space:\s*normal; overflow:\s*visible; text-overflow:\s*clip; overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.v5m-legend[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.v5m-legend button[^}]*margin:\s*0/s);
  assert.match(css, /\.operations-workspace\[data-scope="paper"\][^}]*small::after[^}]*display:\s*block/s);
  const charts = fs.readFileSync(new URL('../src/features/quant-ops/kit/charts.tsx', import.meta.url), 'utf8');
  assert.match(charts, /style=\{\{ height \}\}/);
  assert.match(charts, /height=\{height\}/);
});

test('compact rows keep every exact value, warning, tooltip and cell action within one disclosure', () => {
  const { load } = frontendModules();
  const { Rows } = load('features/quant-ops/kit/Rows.tsx');
  const window = new Window();
  const row = { pair: 'BNB-USDC', state: 'Held · stale since 12:00 UTC', quantity: '123456789.123456789', reason: 'Owner journal held; not current' };
  const columns = [
    { id: 'pair', header: 'Pair', value: row => row.pair },
    { id: 'state', header: 'State', value: row => row.state },
    { id: 'quantity', header: 'Held amount', value: row => row.quantity, title: () => 'As last published, not current' },
    { id: 'reason', header: 'Hold reason', value: row => row.reason, cell: row => React.createElement('details', null, React.createElement('summary', null, 'Expand record'), React.createElement('button', null, row.reason)) },
  ];
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(Rows, { rows: [row], columns, rowId: row => row.pair, label: 'Fixture holdings' }));
  const details = window.document.querySelector('details');
  assert.equal(details.open, false);
  assert.equal(details.querySelectorAll('summary > span').length, 2);
  assert.match(details.querySelector('summary').textContent, /Held · stale since/);
  assert.deepEqual([...details.querySelectorAll('dt')].map(node => node.textContent), columns.map(column => column.header));
  assert.match(details.querySelector('dl').textContent, /123456789\.123456789/);
  assert.match(details.querySelector('dl').textContent, /As last published, not current/);
  assert.equal(details.querySelectorAll('details').length, 0);
  assert.equal(details.querySelector('button').textContent, row.reason);
});

test('adaptive table phone rows share the desktop bounded sorted row set and empty-state semantics', () => {
  const { load } = frontendModules();
  const { DataTable } = load('features/quant-ops/kit/DataTable.tsx');
  const window = new Window();
  const columns = [{ id: 'pair', header: 'Pair', value: row => row.pair }, { id: 'amount', header: 'Amount', kind: 'number', value: row => row.amount }];
  const render = rows => {
    window.document.body.innerHTML = renderToStaticMarkup(React.createElement(DataTable, { rows, columns, rowId: row => row.pair, label: 'Holdings', pageSize: 1, initialSort: { id: 'amount', desc: true }, emptyText: 'Owner records unavailable, not zero' }));
    return window.document;
  };
  const document = render([{ pair: 'BTC-USDC', amount: 1 }, { pair: 'BNB-USDC', amount: 2 }]);
  assert.equal(document.querySelectorAll('.v5-phone-rows > [role="listitem"]').length, 1);
  assert.match(document.querySelector('.v5-phone-rows summary').textContent, /BNB-USDC/);
  assert.match(document.querySelector('.v5-desktop-table tbody').textContent, /BNB-USDC/);
  assert.doesNotMatch(document.querySelector('.v5-phone-rows').textContent, /BTC-USDC/);
  assert.match(document.querySelector('.v5-phone-table-tools').textContent, /Sort and column filters/);
  assert.match(document.querySelector('.q-dt__more').textContent, /Show all 2 rows/);
  assert.match(render([]).querySelector('.v5-phone-empty').textContent, /Owner records unavailable, not zero/);
});

test('Helm phone disclosures retain desktop coin fields, decision time and the stale-value warning', () => {
  const status = { generated_at: now / 1000 - 60, age_s: 60, ready: false, reasons: [], actions: 0, steps: 1, withheld: 0,
    symbols: [{ pair: 'BNB-USDC', status: 'held', candidate_hold: 'operator_entry_pause', bag: { held_amount: '123.456789', breakeven_price: '432.10' }, last_decision: { at: now / 1000 - 120, reason: 'owner_journal_held' } }] };
  const { load } = frontendModules({ '@tanstack/react-query': { useQuery: () => ({ data: { state: 'STALE', reason: 'HELM_STATUS_STALE', bot: 'helm_v5_paper', status }, dataUpdatedAt: now, refetch() {} }) } });
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(load('v5/V5Helm.tsx').V5Helm));
  const phone = window.document.querySelector('.v5-phone-rows');
  const desktop = window.document.querySelector('.v5-desktop-table');
  const fields = [...phone.querySelectorAll('dd')];
  assert.equal(fields.length, 6);
  [...desktop.querySelectorAll('tbody td')].forEach((cell, index) => assert.ok(fields[index].textContent.includes(cell.textContent)));
  assert.ok(fields.at(-1).textContent.includes(desktop.querySelector('td[title]').title));
  assert.match(phone.textContent, /operator entry pause/);
  assert.match(phone.textContent, /owner journal held/);
  assert.match(window.document.body.textContent, /Values below are as last published[^]*not the current state/);
});

for (const kind of ['fills', 'positions']) test(`phone ${kind} preserve the owner's freshness gate and exact record IDs`, () => {
  const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser', '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline', '@/hooks/useWebSocket', '@/hooks/useRates'].map(name => [name, {}]));
  const { load } = frontendModules(stubs, { 'pages/tabs/ActiveBotsTab.tsx': ['PaperRecords'] });
  const { PaperRecords } = load('pages/tabs/ActiveBotsTab.tsx');
  const fixture = JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${kind}.json`, import.meta.url)));
  const read = kind === 'fills' ? { ...fixture, state: 'degraded', completeness: 'partial', reason: 'primary_byte_budget_recent_window' } : fixture;
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperRecords, { read, kind, now: read.generated_at_ms }));
  const phone = window.document.querySelector('.v5-phone-rows');
  assert.ok(phone);
  assert.equal(phone.querySelectorAll('details details').length, 0);
  if (kind === 'fills') assert.match(window.document.body.textContent, /Partial retained window/);
  assert.ok(phone.textContent.includes(String(read.data[0][kind === 'fills' ? 'trade_id' : 'position_id'])));
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperRecords, { read, kind, now: read.generated_at_ms + 60_000 }));
  assert.equal(window.document.querySelector('.v5-phone-rows'), null);
  assert.match(window.document.body.textContent, /Incomplete or stale owner read/);
});
