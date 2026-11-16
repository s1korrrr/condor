import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';
import { reportPresentation, selectReports } from '../src/v5/agent-decisions-model.mjs';

const now = 10000;
const report = (task, time, expiry, status = 'ACCEPTED') => ({ task_id: task, status: 'HISTORY', effect: 'NONE', record: { request_id: task, result: { task_id: task, effect: 'NONE', received_at_ms: time, expires_at_ms: expiry, status, advice: { assessment: 'CAUTION', summary: 'Published summary' } } } });
const records = [report('market_context', 5000, 12000), report('source_quality', 8000, 9000), report('decision_review', 11000, 12000)];

test('untimed reports are withheld instead of treated as historical', () => {
  const untimed = report('market_context', undefined, undefined);
  assert.equal(reportPresentation(untimed, now), 'withheld');
  assert.equal(selectReports([untimed], 'all', 'ACCEPTED', now).length, 0);
});

test('history requests one bounded owner record per agent', async () => {
  const original = globalThis.fetch;
  let requested;
  globalThis.fetch = async url => { requested = url; return { ok: true, json: async () => ({ effect: 'NONE', records: [] }) }; };
  try {
    await frontendModules().load('v5/api.ts').v5Api.advisorHistory('market_context');
    assert.equal(requested, '/api/v5/advisor/history?task_id=market_context&limit=1');
  } finally { globalThis.fetch = original; }
});

test('history is sorted and filters agent, status and assessment without future values', () => {
  assert.deepEqual(selectReports(records, 'all', 'all', now).map(row => row.task_id), ['source_quality', 'market_context', 'decision_review']);
  assert.equal(selectReports(records, 'market_context', 'CAUTION', now).length, 1);
  assert.equal(selectReports(records, 'all', 'ACCEPTED', now).length, 1);
  assert.equal(reportPresentation(records[1], now), 'expired');
  assert.equal(reportPresentation(records[2], now), 'future');
});

test('page renders honest limits, withheld rows, and responsive filter rules', () => {
  const untimed = report('market_context', undefined, undefined);
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({ data: { advisor: { calls_today: 1 }, source_error: null } }), useQueries: () => [{data: { effect: 'NONE', records: [...records, untimed] }}, {data: { effect: 'NONE', records: [] }}, {data: { effect: 'NONE', records: [] }}] },
    'react-router-dom': { Link: ({ children, ...props }) => React.createElement('a', props, children) },
    './usePaperClock': { usePaperClock: () => now },
  });
  const html = renderToStaticMarkup(React.createElement(load('v5/AgentDecisionsPage.tsx').AgentDecisionsPage));
  assert.match(html, /reports-only; they do not place or block orders/);
  assert.match(html, /link from a report to a bot action is not published yet/);
  assert.match(html, /Coin filter not published/);
  assert.match(html, /Only the latest history record per agent/);
  assert.match(html, /report time is missing or invalid/);
  assert.match(html, /Expired report · values withheld/);
  assert.match(html, /Future report withheld/);
  assert.equal((html.match(/Published summary/g) || []).length, 1);
  assert.match(html, /Stale or historical report/);
  const css = fs.readFileSync(new URL('../src/v5/agent-decisions.css', import.meta.url), 'utf8');
  assert.match(css, /flex-wrap:\s*wrap/);
  assert.match(css, /font-size:\s*max\(12px/);
  assert.match(css, /min-width:\s*0/);
});

test('agent decisions route and entry are included', () => {
  const app = fs.readFileSync(new URL('../src/v5/V5App.tsx', import.meta.url), 'utf8');
  const pages = fs.readFileSync(new URL('../src/v5/V5Pages.tsx', import.meta.url), 'utf8');
  assert.match(app, /path="\/agents\/decisions" element=\{<AgentDecisionsPage \/>\}/);
  assert.match(pages, /to="\/agents\/decisions"/);
});
