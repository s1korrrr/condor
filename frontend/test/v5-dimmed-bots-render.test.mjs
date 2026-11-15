import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as ReactQuery from '@tanstack/react-query';
import {Window} from 'happy-dom';
import {frontendModules} from './helpers/frontend-module.mjs';

const sections = ['status', 'wallet', 'positions', 'fills', 'executors', 'risk', 'decisions', 'history', 'accounting'];
const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser', '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline', '@/hooks/useWebSocket', '@/hooks/useRates'].map(name => [name, {}]));
const metrics = html => [...html.matchAll(/class="paper-metric"><dt>([^]*?)<\/dt><dd(?: [^>]*)?>([^]*?)<\/dd>/g)];
const metric = (html, label) => metrics(html).find(match => match[1] === label)?.[2];

function harness({cached = true} = {}) {
  const reads = sections.map(fixture);
  const fills = reads.find(read => read.section === 'fills');
  const nextFills = fixture('fills-offset-200');
  fills.data.push(...nextFills.data);
  fills.next_cursor = nextFills.next_cursor;
  const risk = reads.find(read => read.section === 'risk');
  Object.assign(risk.data, {holds: [], control_hold: null, native_entry_holds: []});
  for (const controller of Object.values(risk.data.controllers)) {
    Object.assign(controller.operator, {paused: false, emergency: false});
    Object.assign(controller.native, {complete: true, latched: false, entry_hold: false});
  }
  const at = reads[0].generated_at_ms;
  const owner = reads[0].bot_id;
  const client = new ReactQuery.QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  if (cached) client.setQueryData(['v5-paper-bots', owner], reads);
  let now = at + 60_000, cursor = 0, options, failed = false, symbolOptions;
  const slots = [];
  const state = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
  };
  const {load} = frontendModules({...stubs,
    react: {...React, useState: state, useRef: initial => state(() => ({current: initial}))[0], useEffect() {}},
    '@/v5/usePaperClock': {usePaperClock: () => now},
    '@tanstack/react-query': {...ReactQuery, useQueryClient: () => client, useQueries: ({queries}) => queries.map(() => ({data: undefined, isPending: true, isError: false})), useQuery: incoming => {
      if (incoming.queryKey[0] === 'v5-paper-bots') options = incoming;
      if (incoming.queryKey[0] === 'v5-bots-candle-symbols') symbolOptions = incoming;
      return {data: client.getQueryData(incoming.queryKey), isPending: !cached, isFetching: false, isError: failed, error: failed ? new Error('Refresh failed') : null, refetch() {}};
    }},
  });
  const {V5PaperBots} = load('pages/tabs/ActiveBotsTab.tsx');
  return {at, owner, reads, load, symbols: () => symbolOptions,
    render({bot = owner, heartbeatAt = at} = {}) {
      cursor = 0;
      return renderToStaticMarkup(React.createElement(V5PaperBots, {bot, generatedAt: heartbeatAt / 1000, ownerState: 'AVAILABLE'}));
    },
    setNow(value) {now = value;},
    async failRefresh({emergency = false} = {}) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async url => {
        const path = new URL(url, 'https://fixture.invalid').searchParams.get('path');
        const section = path.includes('native/status') ? 'status' : path.includes('fleet/summary') ? 'wallet' : path.includes('holdings') ? 'positions' : path.includes('performance/history') ? 'history' : path.split('?')[0].split('/').at(-1);
        if (section === 'history') return {ok: false, status: 500, json: async () => ({})};
        const read = structuredClone(reads.find(read => read.section === section));
        read.snapshot_id += '-newer';
        read.generated_at_ms = at + 45_000;
        read.source_at_ms = read.generated_at_ms;
        read.observed_at_ms = read.generated_at_ms;
        read.read_at_ms = read.generated_at_ms;
        if (read.source) read.source.sequence += 1;
        read.next_cursor = null;
        if (section === 'risk' && emergency) Object.values(read.data.controllers)[0].operator.emergency = true;
        return {ok: true, status: 200, text: async () => JSON.stringify(read)};
      };
      try {
        await assert.rejects(options.queryFn({signal: new AbortController().signal}), /unavailable|failed/i);
        failed = true;
      } finally {globalThis.fetch = originalFetch;}
    },
    close() {client.clear();},
  };
}

test('Bots enables one symbols query only after a complete owner snapshot', () => {
  const pending = harness({cached:false}), complete = harness();
  try {
    pending.render();
    assert.equal(pending.symbols().enabled({state:{status:'pending'}}), false);
    complete.render();
    assert.equal(complete.symbols().enabled({state:{status:'pending'}}), true);
    assert.equal(complete.symbols().enabled({state:{status:'success'}}), false);
    assert.deepEqual(complete.symbols().queryKey, ['v5-bots-candle-symbols']);
  } finally {pending.close();complete.close();}
});

test('dimmed Bots admits values but uses real stale states, safety qualification and one top stamp', () => {
  const current = harness();
  try {
    const html = current.render();
    assert.match(html, /class="paper-dimmed"/);
    assert.equal((html.match(/Last coherent owner snapshot/g) ?? []).length, 1);
    for (const label of ['Wallet equity', 'Since start', 'Profit from closed trades', 'Coins still held', 'Fees paid']) assert.match(metric(html, label), /USDC/);
    assert.equal(metric(html, 'Today'), '—');
    assert.match(metric(html, 'Available cash'), /USDC/);
    assert.notEqual(metric(html, 'Open executors'), 'Not published');
    for (const kind of ['positions', 'fills', 'executors']) assert.match(html, new RegExp(`aria-label="Paper ${kind}"`));
    assert.match(html, /<h2>Holdings<\/h2><span class="paper-badge" data-state="stale">Stale/);
    assert.match(html, /<h2>Risk rails &amp; entry latch<\/h2><span class="paper-badge" data-state="stale">Stale/);
    assert.match(html, /Stale owner report/);
    assert.match(html, /Current entry state unknown/);
    assert.match(html, /Stale valuation/);
    assert.doesNotMatch(html, />Available(?:<| owner report)|>Fresh|Native evidence complete|Fresh complete/);
    const staleSafety = [...html.matchAll(/<p>([^<]*Reported emergency halt: No[^<]*)<\/p>/g)];
    assert.ok(staleSafety.length > 0);
    for (const paragraph of staleSafety) assert.match(paragraph[1], /As of [^<]*UTC · 1m ago/);
  } finally {current.close();}
});

test('dimmed Bots keeps real ages advancing and accepts a newer heartbeat', () => {
  const current = harness();
  try {
    const html = current.render({heartbeatAt: current.at + 45_000});
    assert.match(metric(html, 'Last report'), /UTC · 15s ago/);
    assert.match(html, /UTC · 1m ago/);
    current.setNow(current.at + 75_000);
    assert.match(current.render({heartbeatAt: current.at + 45_000}), /UTC · 1m 15s ago/);
  } finally {current.close();}
});

test('flat position cards retain zero under the dimmed snapshot stamp without inferring entry state', () => {
  const current = harness();
  try {
    for (const read of current.reads.filter(read => ['positions', 'executors'].includes(read.section))) {
      read.data = [];
      read.completeness = 'complete';
      read.next_cursor = null;
    }
    current.setNow(current.at + 1_000);
    assert.match(current.render(), /<dt>Holding<\/dt><dd><span title="0">0 BNB<\/span><\/dd>/);
    current.setNow(current.at + 60_000);
    const html = current.render();
    assert.match(html, /snapshot values are from that time, dimmed until a new report/);
    assert.match(html, /<dt>Holding<\/dt><dd><span title="0">0 BNB<\/span><\/dd>/);
    assert.doesNotMatch(html, /waiting for entry signal/);
  } finally {current.close();}
});

test('dimmed fill records keep real UTC ages rather than the admission age', () => {
  const current = harness();
  try {
    current.reads.find(read => read.section === 'fills').data[0].event_at_ms = current.at;
    const timestamp = new Date(current.at).toISOString().slice(0, 19).replace('T', ' ');
    assert.ok(current.render().includes(`title="${timestamp} UTC · 1m ago"`));
    current.setNow(current.at + 75_000);
    assert.ok(current.render().includes(`title="${timestamp} UTC · 1m 15s ago"`));
  } finally {current.close();}
});

test('retained wallet mark timestamps are validated against real time, not the admission clock', () => {
  const current = harness();
  try {
    const wallet = current.reads.find(read => read.section === 'wallet');
    const marks = wallet.data.assets.filter(asset => asset.asset !== wallet.data.quote_asset);
    assert.ok(marks.length > 0);
    for (const asset of marks) asset.mark_at_ms = current.at + 45_000;
    assert.match(metric(current.render(), 'Holdings value'), /USDC/);
    for (const asset of marks) asset.mark_at_ms = current.at + 70_000;
    assert.equal(metric(current.render(), 'Holdings value'), 'Not published');
  } finally {current.close();}
});

test('a failed refresh retains a newer emergency without presenting the dimmed No as current', async () => {
  const current = harness();
  try {
    current.render();
    await current.failRefresh({emergency: true});
    const html = current.render();
    assert.match(html, /Refresh failed/);
    assert.match(html, /class="paper-dimmed"/);
    assert.match(html, /Emergency halt reported/);
    assert.match(html, /Reported emergency halt: Yes/);
    assert.match(html, /Reported emergency halt: No[^<]* · As of [^<]*UTC · 1m ago/);
    assert.doesNotMatch(html, /Native evidence complete/);
  } finally {current.close();}
});

test('newer retained emergency stays outside the dimmed snapshot with its own received time', async () => {
  const current = harness();
  const browser = new Window();
  try {
    current.render();
    await current.failRefresh({emergency: true});
    browser.document.body.innerHTML = current.render();
    const dimmed = browser.document.querySelector('.paper-dimmed');
    const stamp = browser.document.querySelector('.paper-dimmed-stamp');
    const alert = [...browser.document.querySelectorAll('aside')].find(element => element.querySelector('h2')?.textContent === 'New acquisitions held');
    assert.ok(dimmed && stamp && alert);
    const cards = [...browser.document.querySelectorAll('.paper-section')].find(section => section.querySelector('h2')?.textContent === 'Positions');
    const chart = [...browser.document.querySelectorAll('.paper-section')].find(section => section.querySelector('h2')?.textContent === 'Price and trades');
    assert.ok(cards && chart);
    assert.equal(cards.closest('.paper-dimmed'), null);
    assert.equal(chart.closest('.paper-dimmed'), null);
    assert.ok(cards.querySelector('.paper-dimmed-position'));
    assert.equal(alert.closest('.paper-dimmed'), null);
    assert.equal(alert.parentElement, dimmed.parentElement);
    for (let ancestor = alert; ancestor; ancestor = ancestor.parentElement) {
      assert.ok(!ancestor.style.opacity || ancestor.style.opacity === '1');
    }
    const receivedAt = new Date(current.at + 45_000).toISOString().slice(0, 19).replace('T', ' ');
    assert.ok(alert.textContent.includes(`Safety evidence received ${receivedAt} UTC · 15s ago`));
    assert.match(alert.textContent, /Emergency halt reported/);
    assert.match(alert.textContent, /Reported emergency halt: Yes/);
    assert.doesNotMatch(dimmed.textContent, /Reported emergency halt: Yes/);
    const snapshotAt = new Date(current.at).toISOString().slice(0, 19).replace('T', ' ');
    assert.ok(stamp.textContent.includes(`As of ${snapshotAt} UTC · 1m ago`));
    assert.match(stamp.textContent, /snapshot values are from that time/);
    assert.equal(stamp.nextElementSibling, dimmed);
    assert.ok(alert.compareDocumentPosition(stamp) & browser.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(browser.document.querySelectorAll('.paper-dimmed-stamp').length, 1);
    assert.match(metric(dimmed.innerHTML, 'Wallet equity'), /USDC/);
    assert.match(metric(dimmed.innerHTML, 'Available cash'), /USDC/);
    assert.equal(browser.document.querySelector('[aria-label="Paper money summary"]').closest('.paper-dimmed'), dimmed);
  } finally {
    current.close();
    await browser.happyDOM.close();
  }
});

test('switching Bots does not carry the dimmed snapshot to an uncached bot', () => {
  const current = harness();
  try {
    assert.match(current.render(), /class="paper-dimmed"/);
    const html = current.render({bot: 'another-paper-bot'});
    assert.doesNotMatch(html, /class="paper-dimmed"|Last coherent owner snapshot/);
    assert.match(html, /Checking owner snapshot/);
    assert.deepEqual(metrics(html).map(match => match[2]), Array(6).fill('—'));
  } finally {current.close();}
});

test('an incomplete first snapshot is never dimmed or admitted as complete values', async () => {
  const current = harness({cached: false});
  try {
    current.render();
    await current.failRefresh();
    current.setNow(current.at + 105_000);
    const html = current.render();
    assert.doesNotMatch(html, /class="paper-dimmed"|Last coherent owner snapshot/);
    assert.match(html, /Owner snapshot unavailable/);
    assert.deepEqual(metrics(html).map(match => match[2]), Array(6).fill('—'));
  } finally {current.close();}
});

test('Bots admits values at the 120 s cap and withholds them beyond it', () => {
  const current = harness();
  try {
    current.setNow(current.at + 120_000);
    const retained = current.render();
    assert.match(metric(retained, 'Wallet equity'), /USDC/);
    assert.match(metric(retained, 'Available cash'), /USDC/);
    current.setNow(current.at + 120_001);
    const html = current.render();
    assert.doesNotMatch(html, /class="paper-dimmed"/);
    assert.ok(metrics(html).every(match => !match[2].includes('USDC')));
    assert.equal(metric(html, 'Open executors'), 'Not published');
  } finally {current.close();}
});
