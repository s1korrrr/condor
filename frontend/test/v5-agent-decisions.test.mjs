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

test('timeline discloses text excerpts and shown identifier counts', () => {
  const clipped = report('market_context', 5000, 12000);
  clipped.record.result.advice = {
    assessment: 'a'.repeat(1000), summary: 's'.repeat(1000), truncated_fields: ['assessment', 'summary'],
    reason_codes: Array.from({ length: 8 }, (_, index) => `REASON_${index}`), reason_codes_total: 9,
    evidence_refs: ['whole-ref'], evidence_refs_total: 2,
  };
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({}), useQueries: () => [{ data: { effect: 'NONE', records: [clipped] } }] },
    'react-router-dom': { Link: ({ children, ...props }) => React.createElement('a', props, children) },
    './usePaperClock': { usePaperClock: () => now },
  });
  const Page = load('v5/AgentDecisionsPage.tsx').AgentDecisionsPage;
  const html = renderToStaticMarkup(React.createElement(Page));
  assert.equal((html.match(/… \(excerpt; full text is longer\)/g) || []).length, 3);
  assert.match(html, /a{1000}… \(excerpt; full text is longer\)<\/option>/);
  assert.match(html, /8 of 9 shown/);
  assert.match(html, /1 of 2 shown/);
  clipped.record.result.advice.evidence_refs = [];
  assert.match(renderToStaticMarkup(React.createElement(Page)), /0 of 2 shown/);
});

test('identifier counts never claim a prefix the owner did not return', () => {
  const clipped = report('market_context', 5000, 12000);
  Object.assign(clipped.record.result.advice, { evidence_refs: ['whole-ref'], evidence_refs_total: 2 });
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({}), useQueries: () => [{ data: { effect: 'NONE', records: [clipped] } }] },
    'react-router-dom': { Link: ({ children, ...props }) => React.createElement('a', props, children) },
    './usePaperClock': { usePaperClock: () => now },
  });
  const html = renderToStaticMarkup(React.createElement(load('v5/AgentDecisionsPage.tsx').AgentDecisionsPage));
  assert.match(html, /whole-ref \(1 of 2 shown\)/);
  assert.doesNotMatch(html, /first \d+ of \d+/);
});

test('a shared filter value is marked as an excerpt only for the reports it really cut', () => {
  const prefix = 'b'.repeat(1000);
  const whole = report('market_context', 5000, 12000);
  whole.record.request_id = 'whole';
  whole.record.result.advice = { assessment: prefix, summary: 'Whole assessment' };
  const cut = report('source_quality', 6000, 12000);
  cut.record.request_id = 'cut';
  cut.record.result.advice = { assessment: prefix, summary: 'Cut assessment', truncated_fields: ['assessment'] };
  const statusOnly = report('decision_review', 7000, 12000, 'STATUS_SHARED');
  const cutStatus = report('market_context', 4000, 12000);
  cutStatus.record.request_id = 'cut-status';
  cutStatus.record.result.advice = { assessment: 'STATUS_SHARED', summary: 'Cut status-like assessment', truncated_fields: ['assessment'] };
  const allCut = report('source_quality', 3000, 12000);
  allCut.record.request_id = 'all-cut';
  allCut.record.result.advice = { assessment: 'c'.repeat(1000), summary: 'Only cut', truncated_fields: ['assessment'] };
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({}), useQueries: () => [{ data: { effect: 'NONE', records: [whole, cut, statusOnly, cutStatus, allCut] } }] },
    'react-router-dom': { Link: ({ children, ...props }) => React.createElement('a', props, children) },
    './usePaperClock': { usePaperClock: () => now },
  });
  const html = renderToStaticMarkup(React.createElement(load('v5/AgentDecisionsPage.tsx').AgentDecisionsPage));
  assert.match(html, new RegExp(`>${prefix} \\(excerpt in some matching reports\\)</option>`));
  assert.match(html, />STATUS_SHARED \(excerpt in some matching reports\)<\/option>/);
  assert.match(html, /c{1000}… \(excerpt; full text is longer\)<\/option>/);
  assert.doesNotMatch(html, new RegExp(`>${prefix}… \\(excerpt; full text is longer\\)</option>`));
});

test('timeline does not label whole text or complete lists as excerpts', () => {
  const complete = report('market_context', 5000, 12000);
  Object.assign(complete.record.result.advice, {
    reason_codes: ['WHOLE_REASON'], reason_codes_total: 1, evidence_refs: ['whole-ref'], evidence_refs_total: 1,
  });
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({}), useQueries: () => [{ data: { effect: 'NONE', records: [complete] } }] },
    'react-router-dom': { Link: ({ children, ...props }) => React.createElement('a', props, children) },
    './usePaperClock': { usePaperClock: () => now },
  });
  const html = renderToStaticMarkup(React.createElement(load('v5/AgentDecisionsPage.tsx').AgentDecisionsPage));
  assert.match(html, /Published summary/);
  assert.doesNotMatch(html, /excerpt|\d+ of \d+ shown|first \d+ of \d+/);
});

test('future advisor input times withhold the entire report and its filter values', () => {
  for (const field of ['input_cutoff_ms', 'input_available_at_ms']) {
    const futureInput = report('market_context', 5000, 12000);
    futureInput.record.result[field] = 11000;
    assert.equal(reportPresentation(futureInput, now), 'future');
    assert.equal(selectReports([futureInput], 'all', 'ACCEPTED', now).length, 0);
    const { load } = frontendModules({
      '@tanstack/react-query': { useQuery: () => ({ data: { advisor: {}, source_error: null } }), useQueries: () => [{data: { effect: 'NONE', records: [futureInput] }}] },
      'react-router-dom': { Link: ({ children, ...props }) => React.createElement('a', props, children) },
      './usePaperClock': { usePaperClock: () => now },
    });
    const html = renderToStaticMarkup(React.createElement(load('v5/AgentDecisionsPage.tsx').AgentDecisionsPage));
    assert.match(html, /Future report withheld/);
    assert.doesNotMatch(html, /Published summary|ACCEPTED|CAUTION/);
  }
});

test('out-of-range advisor input times withhold report values', () => {
  for (const field of ['input_cutoff_ms', 'input_available_at_ms']) {
    const invalid = report('market_context', 5000, 12000);
    invalid.record.result[field] = 4102444800001;
    assert.equal(reportPresentation(invalid, now), 'withheld');
    assert.equal(selectReports([invalid], 'all', 'ACCEPTED', now).length, 0);
  }
});

test('timeline discloses its bounded projected history and older-owner failure', () => {
  const page = fs.readFileSync(new URL('../src/v5/AgentDecisionsPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /Up to 5 reports per agent/);
  assert.doesNotMatch(page, /Only the latest report|Older reports are not shown yet|slimmer history/);
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({}), useQueries: () => [{isError:true,error:{code:'ADVISOR_PROJECTED_HISTORY_UNAVAILABLE'}}] },
    'react-router-dom': { Link: ({ children, ...props }) => React.createElement('a', props, children) },
    './usePaperClock': { usePaperClock: () => now },
  });
  const html = renderToStaticMarkup(React.createElement(load('v5/AgentDecisionsPage.tsx').AgentDecisionsPage));
  assert.match(html, /owner does not publish projected history/);
  assert.match(html, /No full-record fallback/);
});

test('untimed reports are withheld instead of treated as historical', () => {
  const untimed = report('market_context', undefined, undefined);
  assert.equal(reportPresentation(untimed, now), 'withheld');
  assert.equal(selectReports([untimed], 'all', 'ACCEPTED', now).length, 0);
});

test('history requests five bounded owner projections per agent', async () => {
  const original = globalThis.fetch;
  let requested;
  globalThis.fetch = async url => { requested = url; return { ok: true, json: async () => ({ effect: 'NONE', records: [] }) }; };
  try {
    await frontendModules().load('v5/api.ts').v5Api.advisorHistory('market_context');
    assert.equal(requested, '/api/v5/advisor/history?task_id=market_context&limit=5');
  } finally { globalThis.fetch = original; }
});

test('timeline renders multiple reports for the same agent newest first and preserves withheld values', () => {
  const older = report('market_context', 4000, 12000);
  older.record.result.advice.summary = 'Older timeline report';
  const newer = report('market_context', 7000, 12000);
  newer.record.result.advice.summary = 'Newer timeline report';
  const future = report('market_context', 11000, 12000);
  future.record.result.advice.summary = 'PRIVATE_FUTURE_SUMMARY';
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({}), useQueries: () => [{data:{effect:'NONE',records:[older,future,newer]}}] },
    'react-router-dom': { Link: ({ children, ...props }) => React.createElement('a', props, children) },
    './usePaperClock': { usePaperClock: () => now },
  });
  const html = renderToStaticMarkup(React.createElement(load('v5/AgentDecisionsPage.tsx').AgentDecisionsPage));
  assert.match(html, /Up to 5 reports per agent/);
  assert.ok(html.indexOf('Newer timeline report') < html.indexOf('Older timeline report'));
  assert.match(html, /data-freshness="historical"/);
  assert.match(html, /Future report withheld/);
  assert.doesNotMatch(html, /PRIVATE_FUTURE_SUMMARY/);
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
  assert.match(html, /Up to 5 reports per agent, newest first/);
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

test('owner values use shared rounding and retain exact amounts and times', () => {
  const priced = report('market_context', 5000, 12000);
  priced.record.result.actual_usd = '1.235';
  const zero = report('source_quality', 6000, 12000);
  zero.record.result.actual_usd = '-0.004';
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({ data: { advisor: { calls_today: 1000 }, source_error: null } }), useQueries: () => [{data: { effect: 'NONE', records: [priced, zero] }}] },
    'react-router-dom': { Link: ({ children, ...props }) => React.createElement('a', props, children) },
    './usePaperClock': { usePaperClock: () => now },
  });
  const html = renderToStaticMarkup(React.createElement(load('v5/AgentDecisionsPage.tsx').AgentDecisionsPage));
  assert.match(html, /class="owner-value" title="1\.235" data-tone="up">1\.24 USD/);
  assert.match(html, /class="owner-value" title="-0\.004" data-tone="zero">0<\/span> USD/);
  assert.match(html, /class="owner-value" title="1000">1,000/);
  assert.match(html, /<time class="owner-value" title="5000">/);
});

test('agent decisions route and entry are included', () => {
  const app = fs.readFileSync(new URL('../src/v5/V5App.tsx', import.meta.url), 'utf8');
  const pages = fs.readFileSync(new URL('../src/v5/V5Pages.tsx', import.meta.url), 'utf8');
  assert.match(app, /path="\/agents\/decisions" element=\{<AgentDecisionsPage \/>\}/);
  assert.match(pages, /to="\/agents\/decisions"/);
});
