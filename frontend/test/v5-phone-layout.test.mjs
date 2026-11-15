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

for (const [path, active] of [['/', 'Overview'], ['/capital', 'Overview'], ['/bots', 'Bots'], ['/helm', 'Bots'], ['/market/stocks', 'Market'], ['/market/BTC', 'Market'], ['/operations', 'System'], ['/settings', 'System'], ['/v5/readiness', 'System'], ...['checks', 'data-feeds', 'engine-inputs', 'readiness', 'settings'].map(tab => [`/system/${tab}`, 'System']), ['/agents/fixture', 'Research'], ['/research-factory', 'Research']]) {
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
  assert.equal(document.querySelector('.v5-shell-mode').textContent, 'PAPER');
  assert.equal(shell('/', false).querySelector('.v5-shell-mode').textContent, 'ADVISOR');
  const header = document.querySelector('header');
  assert.equal(header.nextElementSibling.id, 'v5-shell-status-slot');
  assert.equal(header.nextElementSibling.childNodes.length, 0);
  assert.equal(document.querySelector('[aria-label="System tools"] a').getAttribute('href'), '/system/settings');
  assert.match(document.querySelector('[aria-label="System tools"]').textContent, /Theme: dark/);
  assert.equal(shell('/bots').querySelector('[aria-label="System tools"]'), null);
  assert.match(document.querySelector('.v5-phone-safety summary').textContent, /execution disabled/);
  assert.equal(document.querySelector('main a[href="/v5/readiness"]'), null);
  assert.ok(header.querySelector('a[href="/system/readiness"]'));
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

test('Helm native phone cards retain every desktop coin field and withhold stale signal and bag values', context => {
  context.mock.method(Date, 'now', () => now);
  const status = { generated_at: now / 1000, age_s: 0, ready: false, reasons: [], actions: 0, steps: 1, withheld: 0,
    symbols: [{ pair: 'BNB-USDC', status: 'held', candidate_hold: 'operator_entry_pause', bag: { held_amount: '123.456789', breakeven_price: '432.10' },
      signal: { at: now / 1000 - 10, rsi: '40.5', oversold: '31', rsi_length: 21, atr_fraction: null, decision: { enter: false, reason: 'owner_journal_held' } } }] };
  let state = 'FRESH';
  const { load } = frontendModules({ '@tanstack/react-query': { useQuery: () => ({ data: { state, reason: state === 'STALE' ? 'HELM_STATUS_STALE' : null, bot: 'helm_v5_paper', status }, dataUpdatedAt: now, refetch() {} }) } });
  const window = new Window();
  const Helm = load('v5/V5Helm.tsx').V5Helm;
  const render = () => {
    window.document.body.innerHTML = renderToStaticMarkup(React.createElement(Helm));
    const phone = window.document.querySelector('.v5m-helm-mobile');
    const cells = window.document.querySelectorAll('.v5m-helm-table tbody td');
    assert.equal(cells.length, 5);
    for (const cell of cells) assert.ok(phone.textContent.includes(cell.textContent), cell.textContent);
    return phone;
  };
  const phone = render();
  for (const text of [/operator entry pause/, /owner journal held/, /RSI 40\.5/, /123\.457 BNB/, /432\.1/, /15 Nov 12:34 UTC · 10 s ago/]) assert.match(phone.textContent, text);
  state = 'STALE';
  const stale = render();
  assert.match(stale.textContent, /Helm status is stale/);
  assert.match(stale.textContent, /15 Nov 12:34 UTC · 10 s ago · stale/);
  assert.doesNotMatch(stale.textContent, /operator entry pause|owner journal held|RSI 40\.5|123\.457|432\.1/);
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
  const ordered = kind === 'fills' ? [...read.data].sort((left, right) => right.event_at_ms - left.event_at_ms) : read.data;
  assert.ok(phone.textContent.includes(String(ordered[0][kind === 'fills' ? 'trade_id' : 'position_id'])));
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperRecords, { read, kind, now: read.generated_at_ms + 60_000 }));
  assert.equal(window.document.querySelector('.v5-phone-rows'), null);
  assert.match(window.document.body.textContent, /Incomplete or stale owner read/);
});

test('phone records use published millisecond times, never manufacture missing chronology', () => {
  const { phoneRecordTime } = frontendModules().load('v5/phone-records.ts');
  assert.equal(phoneRecordTime({ event_at_ms: 30, close_at_ms: 20, created_at_ms: 10 }, now, now), 30);
  assert.equal(phoneRecordTime({ close_at_ms: 20, created_at_ms: 10 }, now, now), 20);
  assert.equal(phoneRecordTime({ close_at_ms: null, created_at_ms: 10 }, now, now), 10);
  assert.equal(phoneRecordTime({ created_at_ms: 0 }, now, now), 0);
  for (const value of [undefined, null, '', '30', NaN, Infinity, -1]) assert.equal(phoneRecordTime({ created_at_ms: value }, now, now), null);
  for (const snapshotAt of [undefined, null, '', '30', NaN, Infinity, -1, 1.5, now + 5001]) assert.equal(phoneRecordTime({ created_at_ms: 0 }, now, snapshotAt), null);
  assert.equal(phoneRecordTime({ created_at_ms: now }, now, now + 5000), now);
  assert.equal(phoneRecordTime({ created_at_ms: now + 1 }, now, now + 5000), null);
  assert.equal(phoneRecordTime({ created_at_ms: now }, now, now - 1), null);
  assert.equal(phoneRecordTime({ created_at_ms: now - 1 }, now, now - 1), now - 1);
});

test('phone newest-first ordering happens before pagination without changing desktop order or explicit sorts', () => {
  const { DataTable } = frontendModules().load('features/quant-ops/kit/DataTable.tsx');
  const rows = Array.from({ length: 12 }, (_, index) => ({ id: `id-${index}`, pair: `pair-${index}`, time: index === 0 ? null : index }));
  const columns = [{ id: 'id', header: 'Owner ID', value: row => row.id }, { id: 'pair', header: 'Pair', value: row => row.pair }];
  const window = new Window();
  const render = props => {
    window.document.body.innerHTML = renderToStaticMarkup(React.createElement(DataTable, { rows, columns, rowId: row => row.id, label: 'Phone ordering', pageSize: 2, phoneNewestAt: row => row.time, ...props }));
    return window.document;
  };
  let document = render();
  assert.deepEqual([...document.querySelectorAll('.v5-phone-rows summary strong')].map(cell => cell.textContent), ['pair-11', 'pair-10']);
  assert.match(document.querySelector('.v5-desktop-table tbody tr').textContent, /id-0/);
  assert.doesNotMatch(document.querySelector('.v5-phone-rows summary').textContent, /id-/);
  assert.match(document.querySelector('.v5-phone-order').textContent, /undated records follow in owner order/);
  assert.match(document.querySelector('.q-dt__more').textContent, /Show all 12/);
  document = render({ pageSize: 20 });
  assert.match([...document.querySelectorAll('.v5-phone-rows summary')].at(-1).textContent, /pair-0/);
  document = render({ initialSort: { id: 'pair' } });
  assert.equal(document.querySelector('.v5-phone-order'), null);
  assert.match(document.querySelector('.v5-phone-rows summary').textContent, /pair-0/);
});

for (const kind of ['positions', 'fills', 'executors']) test(`phone ${kind} sort newest first with IDs and all desktop facts one disclosure away`, () => {
  const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser', '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline', '@/hooks/useWebSocket', '@/hooks/useRates'].map(name => [name, {}]));
  const { load } = frontendModules(stubs, { 'pages/tabs/ActiveBotsTab.tsx': ['PaperRecords'] });
  const { PaperRecords } = load('pages/tabs/ActiveBotsTab.tsx');
  const fixture = JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${kind}.json`, import.meta.url)));
  const idKey = kind === 'fills' ? 'trade_id' : kind === 'positions' ? 'position_id' : 'executor_id';
  const rows = [1, 3, 2].map(order => ({ ...fixture.data[0], [idKey]: `private-${order}`, executor_id: `executor-${order}`, trading_pair: `COIN${order}-USDC`, event_at_ms: kind === 'fills' ? now - order * 1000 : undefined, created_at_ms: kind === 'positions' ? undefined : now - order * 1000, close_at_ms: null }));
  const read = { ...fixture, data: rows, state: kind === 'positions' ? 'available' : 'degraded', completeness: kind === 'positions' ? 'complete' : 'partial', reason: kind === 'positions' ? null : 'primary_byte_budget_recent_window', generated_at_ms: now };
  const executors = { ...read, section: 'executors', data: rows.map((row, index) => ({ ...row, created_at_ms: now - [1, 3, 2][index] * 1000 })) };
  const window = new Window();
  const render = executorRead => {
    window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperRecords, { read, positions: kind === 'positions' ? read : undefined, executors: executorRead, kind, now }));
    return window.document;
  };
  const document = render(executors);
  const phone = [...document.querySelectorAll('.v5-phone-rows > div')];
  assert.deepEqual(phone.map(row => row.querySelector('summary strong').textContent), ['COIN1-USDC', 'COIN2-USDC', 'COIN3-USDC']);
  assert.deepEqual([...document.querySelectorAll('.v5-desktop-table tbody tr')].map(row => row.children[1].textContent), ['COIN1-USDC', 'COIN3-USDC', 'COIN2-USDC']);
  for (const desktop of document.querySelectorAll('.v5-desktop-table tbody tr')) {
    const mobile = phone.find(row => row.textContent.includes(desktop.children[1].textContent));
    assert.equal(mobile.querySelector('details').open, false);
    assert.doesNotMatch(mobile.querySelector('summary').textContent, /private-|executor-/);
    assert.equal(mobile.querySelectorAll('details details').length, 0);
    const values = [...mobile.querySelector('details > dl').children].map((field, index) => {
      const value = field.querySelector('dd').cloneNode(true);
      const note = value.querySelector('.v5-phone-row-note');
      if (note) {
        assert.equal(note.textContent, `Raw value: ${desktop.children[index].title}`);
        note.remove();
      }
      return value.textContent;
    });
    [...desktop.children].forEach((cell, index) => assert.equal(values[index], cell.textContent.replace('Expand record', '')));
  }
  if (kind === 'positions') {
    const stale = render({ ...executors, generated_at_ms: now - 60_000 });
    assert.deepEqual([...stale.querySelectorAll('.v5-phone-rows summary strong:first-of-type')].map(cell => cell.textContent).filter(text => text.startsWith('COIN')), ['COIN1-USDC', 'COIN3-USDC', 'COIN2-USDC']);
  }
});

test('phone terminal history keeps owner IDs inside one-tap details and the stale history gate', () => {
  const { PaperTerminalHistory } = frontendModules().load('v5/PaperTerminalHistory.tsx');
  const fixture = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/paper-api-final3/native-replay/history.json', import.meta.url)));
  const records = [1, 3, 2].map(order => ({ executor_id: `executor-${order}`, trading_pair: `COIN${order}-USDC`, controller_id: `controller-${order}`, close_type: 'owner_hold', close_at_ms: now - order * 1000 }));
  const read = { ...fixture, generated_at_ms: now, completeness: 'partial', data: { ...fixture.data, terminal_executors: { data: { delivery: 'publication_pages', records, publication_record_count: 3 } } } };
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperTerminalHistory, { read, now }));
  const phone = window.document.querySelector('.v5-phone-rows');
  assert.deepEqual([...phone.querySelectorAll('summary strong:first-of-type')].map(cell => cell.textContent).filter(text => text.startsWith('COIN')), ['COIN1-USDC', 'COIN2-USDC', 'COIN3-USDC']);
  for (const row of phone.querySelectorAll('details')) {
    assert.doesNotMatch(row.querySelector('summary').textContent, /executor-|controller-/);
    assert.match(row.querySelector('dl').textContent, /executor-.*controller-.*owner_hold/);
    assert.equal(row.querySelectorAll('details').length, 0);
  }
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperTerminalHistory, { read, now: now + 60_000 }));
  assert.equal(window.document.querySelector('.v5-phone-rows'), null);
  assert.match(window.document.body.textContent, /Terminal records are unavailable or stale/);
});

test('phone typography floors cover Bots, System, Helm and Market without shrinking touch targets', () => {
  assert.doesNotMatch(css, /font-size:\s*(?:\d|1[01])(?:\.\d+)?px[;\s]/);
  for (const selector of ['paper-badge', 'fs-stats dt', 'v5m-asof', 'q-tooltip', 'q-kpi span', 'q-state', 'q-stat > span', 'op-hcell p', 'op-hrow__id em', 'v5-status', 'v5-profile-row', 'v5-feature-row > *', 'v5m-hour-strip th', 'v5m-hour']) {
    assert.ok(css.includes(selector));
  }
  assert.match(css, /:is\(a, button,[^}]*min-width:\s*44px; min-height:\s*44px/s);
  assert.match(css, /\.v5-phone-rows :is\(summary small, dt\)[^}]*font-size:\s*12px/);
  assert.match(css, /\.paper-copy\)[^}]*overflow:\s*visible[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.v5m-stat\[title\]::after[^}]*content:\s*attr\(title\)/);
  assert.match(css, /:is\(\.v5m-hour-strip th, \.v5m-hour\)[^}]*font-size:\s*12px !important/);
});

test('phone daily money rows retain exact values in titles without raw notes', () => {
  const { load } = frontendModules({}, { 'v5/V5Money.tsx': ['dailyColumns'] });
  const { DataTable } = load('features/quant-ops/kit/DataTable.tsx');
  const { Rows } = load('features/quant-ops/kit/Rows.tsx');
  const columns = load('v5/V5Money.tsx').dailyColumns;
  const row = { day: now, equity_start: '100', equity_end: '101.2345', equity_change: '1.2345', realized_change: '0', valid: 288, samples: 288, gaps: 0 };
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(DataTable, { rows: [row], columns, rowId: () => 'day', label: 'Money daily' }));
  assert.equal(window.document.querySelectorAll('.v5-desktop-table td')[2].title, '1.2345');
  const change = [...window.document.querySelectorAll('.v5-phone-rows dt')].find(field => field.textContent === 'Equity change').nextElementSibling;
  assert.match(change.textContent, /1\.23/);
  assert.doesNotMatch(change.textContent, /Raw value:/);
  assert.equal(change.querySelector('[title]').title, '1.2345');
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(Rows, { rows: [row], rowId: () => 'day', label: 'Explicit title', columns: [
    { id: 'amount', header: 'Amount', value: () => '1.2345', cell: () => React.createElement('strong', null, '1.23'), title: () => 'Exact owner amount 1.2345' },
    { id: 'zero', header: 'Zero', value: () => 0, cell: () => React.createElement('span', null, 'Zero') },
    { id: 'missing', header: 'Missing', value: () => null, cell: () => 'Unavailable' },
    { id: 'substring', header: 'Rounded up', value: () => '1.2', cell: () => '1.23' },
    { id: 'same', header: 'Unformatted', value: () => '1.23', cell: () => React.createElement('span', null, '1.23') },
  ] }));
  const notes = [...window.document.querySelectorAll('.v5-phone-row-note')].map(note => note.textContent);
  assert.deepEqual(notes, ['Exact owner amount 1.2345']);
  assert.equal(window.document.querySelector('dd[title="Exact owner amount 1.2345"]').title, 'Exact owner amount 1.2345');
  window.close();
});

test('review regression: future and invalid fill times are undated after qualified records in owner order', () => {
  const { phoneRecordTime } = frontendModules().load('v5/phone-records.ts');
  for (const value of [now + 86_400_000, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(phoneRecordTime({ event_at_ms: value, created_at_ms: now }, now, now), null);
  assert.equal(phoneRecordTime({ event_at_ms: now + 5000 }, now, now), null);
  assert.equal(phoneRecordTime({ event_at_ms: now + 5001 }, now, now), null);
  const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser', '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline', '@/hooks/useWebSocket', '@/hooks/useRates'].map(name => [name, {}]));
  const { PaperRecords } = frontendModules(stubs, { 'pages/tabs/ActiveBotsTab.tsx': ['PaperRecords'] }).load('pages/tabs/ActiveBotsTab.tsx');
  const fixture = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/paper-api-final3/native-replay/fills.json', import.meta.url)));
  const data = [['FUTURE', now + 86_400_000], ['VALID', now - 1000], ['UNDATED', null]].map(([pair, event_at_ms]) => ({ ...fixture.data[0], trading_pair: `${pair}-USDC`, trade_id: pair, event_at_ms, created_at_ms: undefined }));
  const read = { ...fixture, generated_at_ms: now, next_cursor: null, data };
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperRecords, { read, kind: 'fills', now }));
  assert.deepEqual([...window.document.querySelectorAll('.v5-phone-rows summary strong:first-of-type')].map(cell => cell.textContent).filter(text => text.endsWith('-USDC')), ['VALID-USDC', 'FUTURE-USDC', 'UNDATED-USDC']);
  assert.match(window.document.querySelector('.v5-phone-order').textContent, /undated records follow in owner order/);
  assert.match(window.document.querySelectorAll('.v5-phone-rows details')[1].textContent, /Not published/);
  window.close();
});

test('review regression: phone execution-disabled disclosure retains unbound and paper authority sentences', () => {
  for (const paper of [false, true]) {
    const document = shell('/', paper);
    const disclosure = document.querySelector('header details.v5-phone-safety');
    assert.ok(disclosure);
    assert.equal(disclosure.open, false);
    assert.match(disclosure.querySelector('summary').textContent, /execution disabled/);
    const body = disclosure.querySelector('.v5-phone-safety-body');
    assert.match(body.textContent, paper ? /PAPER.*live disabled/ : /execution disabled · baseline and account owners unbound/);
    assert.equal(body.querySelector('a').getAttribute('href'), '/system/readiness');
  }
  assert.match(shell('/market/stocks', false).querySelector('.v5-phone-safety-body').textContent, /public market observations · execution disabled/);
  assert.match(css, /\.v5-phone-safety summary\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.v5-phone-safety-body\s*\{[^}]*white-space:\s*normal/);
});

test('tooltip and exact title survive the phone money disclosure', () => {
  const { load } = frontendModules({}, { 'v5/V5Money.tsx': ['dailyColumns'] });
  const { Rows } = load('features/quant-ops/kit/Rows.tsx');
  const columns = load('v5/V5Money.tsx').dailyColumns;
  const row = { day: now, equity_start: '101.2345', equity_end: '102.469', equity_change: '1.2345', realized_change: '1.2345', first_at_ms: now - 1000, equity_first_at_ms: now - 1000, valid: 288, equity_valid: 288, samples: 288, gaps: 0 };
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(Rows, { rows: [row], columns, rowId: () => 'day', label: 'Money precision' }));
  for (const id of ['start', 'realized']) {
    const column = columns.find(item => item.id === id);
    const field = [...window.document.querySelectorAll('dt')].find(item => item.textContent === column.header).nextElementSibling;
    assert.ok(field.textContent.includes(column.cell(row).props.children));
    assert.ok(field.textContent.includes(column.title(row)));
    assert.doesNotMatch(field.textContent, /Raw value:/);
    assert.equal(field.querySelector('span').title, String(column.value(row)));
  }
  window.close();
});

test('agent catalog metadata reaches 12px on small phones without changing laptop rules', () => {
  const desktop = fs.readFileSync(new URL('../design-system/v5/app.css', import.meta.url), 'utf8');
  assert.match(desktop, /\.v5-catalog-meta\s*\{[^}]*font-size:\s*9px/);
  assert.match(css, /@media \(max-width: 430px\)\s*\{\s*\.condor-native \.v5-catalog-meta\s*\{\s*font-size:\s*12px/);
});

test('executor details format owner amounts and preserve exact titles', () => {
  const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser', '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline', '@/hooks/useWebSocket', '@/hooks/useRates'].map(name => [name, {}]));
  const { PaperRecords } = frontendModules(stubs, { 'pages/tabs/ActiveBotsTab.tsx': ['PaperRecords'] }).load('pages/tabs/ActiveBotsTab.tsx');
  const fixture = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/paper-api-final3/native-replay/executors.json', import.meta.url)));
  const row = { ...fixture.data[0], remaining_basis_quote: '44.19171445147200000000000000', realized_pnl_quote: '-0.00001351276800000000000000000000', remaining_close_quantity: '0.001277020' };
  const read = { ...fixture, data: [row], generated_at_ms: now };
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperRecords, { read, kind: 'executors', now }));
  for (const [exact, displayed] of [['44.19171445147200000000000000', '44.19 USDC'], ['-0.00001351276800000000000000000000', '−0.0000135 USDC'], ['0.001277020', '0.001277 BTC']]) {
    const values = [...window.document.querySelectorAll('span[title]')].filter(span => span.title === exact);
    assert.ok(values.length, exact);
    assert.ok(values.every(span => span.textContent === displayed));
  }
  window.close();
});

test('phone System keeps all five touch tabs, selected state and paused/readiness/settings routes', () => {
  const { V5System } = frontendModules({
    react: { ...React, lazy: () => () => React.createElement('p', null, 'Owner service history and checks') },
    '@tanstack/react-query': { useQuery: () => ({ data: { readiness: { paper_owner: { bot_name: 'paper' } } } }) },
    './usePaperObservation': { usePaperWorkspace: () => ({ data: null, pending: false, error: null }) },
    './V5Pages': { PaperReadinessPage: () => React.createElement('p', null, 'Readiness'), SettingsPage: () => React.createElement('p', null, 'Settings') },
    './V5Market': { V5SystemMarket: ({ tab }) => React.createElement('p', null, tab) },
  }).load('v5/V5System.tsx');
  const tabs = ['checks', 'data-feeds', 'engine-inputs', 'readiness', 'settings'];
  const window = new Window();
  for (const tab of tabs) {
    window.document.body.innerHTML = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(V5System, { initialTab: tab })));
    const system = window.document.querySelector('.v5-system');
    assert.ok(system);
    assert.equal(system.querySelector('h1').textContent, 'System');
    const nav = system.querySelector('[aria-label="System tabs"]');
    assert.deepEqual([...nav.querySelectorAll('a')].map(link => link.getAttribute('href')), tabs.map(item => `/system/${item}`));
    assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1);
    assert.equal(nav.querySelector('[aria-current="page"]').getAttribute('href'), `/system/${tab}`);
    assert.equal(system.querySelector('button').textContent, 'Pause');
    assert.match(system.textContent, /Updates every 15 s/);
  }
  assert.match(css, /\.v5-system\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.v5-system :is\([^}]*font-size:\s*12px !important/);
  assert.match(css, /body:has\(\.condor-native \.v5-system\) \.q-heat-tip :is\([^}]*font-size:\s*12px !important/);
  assert.match(css, /\.v5-shell-subnav\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto/);
  assert.match(css, /:is\(a, button,[^}]*min-width:\s*44px; min-height:\s*44px/s);
  window.close();
});

test('phone System data feeds retain lane health and precision without hover-only facts', () => {
  const summary = { now: now / 1000, status_age_s: 10, tiles: [{ lane: 'okx__spot', venue: 'okx', segment: 'spot', available: true, health: 'red', pairs_held: 1, pairs_listed: 2, coverage_24h: 0.9, coverage_7d: 0.8, gaps_7d: 5, last_minute_age_s: 30 }] };
  const { V5SystemMarket } = frontendModules({
    '@tanstack/react-query': { useQuery: ({ queryKey }) => queryKey[0] === 'v5-profile' ? { data: { candle_store: { configured: true } } } : queryKey[1] === 'market-summary' ? { isSuccess: true, data: summary, dataUpdatedAt: now } : { isSuccess: false } },
    '@/features/quant-ops/kit/charts': {}, '@/features/quant-ops/kit/grid': {},
    './usePaperClock': { usePaperClock: () => now }, './V5CandleStore': {}, './V5MarketDetail': {}, './V5MarketFeatures': {},
  }).load('v5/V5Market.tsx');
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(V5SystemMarket, { tab: 'data-feeds', paused: false }));
  const lane = window.document.querySelector('.v5m-lane[title]');
  assert.match(lane.title, /7-day coverage 80\.0% · missing minutes 5/);
  assert.match(lane.querySelector('[title]').title, /Owner health: red · available/);
  assert.match(window.document.body.textContent, /Feed data is not current or was not reported/);
  assert.match(css, /\.v5-system \.v5m-venues\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.v5-system :is\([^}]*\)\[title\]::after\s*\{[^}]*content:\s*attr\(title\)/);
  window.close();
});

for (const scenario of [
  { name: 'four seconds ahead of observation', snapshotAt: now, recordAt: now + 4000, validAt: now - 1000 },
  { name: 'after its snapshot but before observation', snapshotAt: now - 10_000, recordAt: now - 9000, validAt: now - 11_000 },
]) for (const kind of ['fills', 'positions', 'history']) test(`round two: ${kind} reject ordering time ${scenario.name}`, () => {
  const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser', '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline', '@/hooks/useWebSocket', '@/hooks/useRates'].map(name => [name, {}]));
  const { load } = frontendModules(stubs, { 'pages/tabs/ActiveBotsTab.tsx': ['PaperRecords'] });
  const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
  const records = section => [['UNQUALIFIED', scenario.recordAt], ['VALID', scenario.validAt], ['UNDATED', null]].map(([pair, time]) => ({
    ...fixture(section).data[0], trading_pair: `${pair}-USDC`, trade_id: pair, position_id: pair, executor_id: pair,
    event_at_ms: section === 'fills' ? time : undefined, close_at_ms: section === 'history' ? time : null, created_at_ms: section === 'executors' ? time : undefined,
  }));
  const window = new Window();
  if (kind === 'history') {
    const read = { ...fixture('history'), generated_at_ms: scenario.snapshotAt, completeness: 'partial', data: { terminal_executors: { data: { delivery: 'publication_pages', records: records('history'), publication_record_count: 3 } } } };
    window.document.body.innerHTML = renderToStaticMarkup(React.createElement(load('v5/PaperTerminalHistory.tsx').PaperTerminalHistory, { read, now }));
  } else {
    const read = { ...fixture(kind), generated_at_ms: kind === 'positions' ? now : scenario.snapshotAt, next_cursor: null, data: records(kind) };
    const executors = { ...fixture('executors'), snapshot_id: read.snapshot_id, generated_at_ms: scenario.snapshotAt, next_cursor: null, data: records('executors') };
    window.document.body.innerHTML = renderToStaticMarkup(React.createElement(load('pages/tabs/ActiveBotsTab.tsx').PaperRecords, { read, executors, kind, now }));
  }
  assert.deepEqual([...window.document.querySelectorAll('.v5-phone-rows summary strong:first-of-type')].map(cell => cell.textContent).filter(text => text.endsWith('-USDC')), ['VALID-USDC', 'UNQUALIFIED-USDC', 'UNDATED-USDC']);
  assert.match(window.document.querySelector('.v5-phone-order').textContent, /undated records follow in owner order/);
  window.close();
});
