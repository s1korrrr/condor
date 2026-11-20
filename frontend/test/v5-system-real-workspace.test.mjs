import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after } from 'node:test';
import * as ReactQuery from '@tanstack/react-query';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Window } from 'happy-dom';
import report from '../../tests/fixtures/paper-api-final3/host-operations.json' with { type: 'json' };
import { frontendModules } from './helpers/frontend-module.mjs';

const browser = new Window({ url: 'https://fixture.invalid/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? browser : browser[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
after(() => browser.happyDOM.close());

let state;
const now = () => state.now ?? report.generated_at_ms;
const retries = [];
const overrides = {
  'lightweight-charts': await import('lightweight-charts'),
  '@tanstack/react-query': {
    ...ReactQuery,
    useQuery: () => ({
      data: { readiness: { paper_owner: state.unbound ? null : { bot_name: 'fixture' } } },
      refetch: () => retries.push('profile'),
    }),
    useQueryClient: () => ({}),
  },
  '@/hooks/useTheme': { useTheme: () => ({ theme: 'dark' }) },
  '@/lib/auth': { useAuth: () => ({}) },
  './usePaperClock': { usePaperClock: now },
  '../../../../condor/frontend/src/v5/usePaperClock': { usePaperClock: now },
  './usePaperObservation': {
    usePaperWorkspace: () => ({
      data: state.data ?? null, error: state.error ?? null, pending: state.pending ?? false,
      refresh: () => retries.push('operations'),
    }),
  },
};
const { load } = frontendModules(overrides);
const workspaceRoot = process.env.V5_WORKSPACE_ROOT ?? path.resolve(import.meta.dirname, '../../..');
overrides['@workspace-monitoring'] = load(path.join(workspaceRoot, 'dashboard/condor-workspace/src/index.ts'));
const { V5System } = load('v5/V5System.tsx');
const { V5AppShell } = load('v5/V5AppShell.tsx');

const cases = [
  ['unbound owner', { unbound: true, pending: true }, 'unavailable', 'Paper owner is not bound.', 'profile'],
  ['first read pending', { pending: true }, 'loading', 'Loading service and check reports…'],
  ['read failed', { error: 'The fixture read failed.' }, 'error', 'The fixture read failed.', 'operations'],
  ['refetch failed with earlier evidence', { data: report, error: 'The fixture refetch failed.', earlier: true }, 'error', 'The fixture refetch failed.', 'operations'],
  ['owner collecting', { data: { ...report, data: null, reason: 'The owner is still collecting.', state: 'collecting' } }, 'unavailable', 'The owner is still collecting.', 'operations'],
  ['old or future report', [
    [{ data: report, now: report.generated_at_ms + 90_001 }, 'The most recent report is too old.'],
    [{ data: report, now: report.generated_at_ms - 1 }, 'The report is dated in the future.'],
  ], 'unavailable', null, 'operations'],
  ['empty report', { data: { ...report, data: { ...report.data, services: [], checks: [] } } }, 'empty', 'The paper host returned a report without service or check results.', 'operations'],
  ['current report', { data: report }, null, '7 checks need attention:'],
];

for (const [name, input, kind, reason, retry] of cases) {
  test(`System with the real workspace · ${name}`, async () => {
    for (const [fixture, expected] of Array.isArray(input) ? input : [[input, reason]]) {
      state = fixture;
      for (const tab of ['checks', 'operations']) {
        retries.length = 0;
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        try {
          const pathname = `/system/${tab}`;
          await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: [pathname] },
            React.createElement(V5AppShell, null, React.createElement(Routes, null, React.createElement(Route, {
              path: '/system/:tab', element: React.createElement(V5System),
            }))))));
          const main = container.querySelector('main');
          const system = main.querySelector('.v5-system');
          const message = `${name} / ${tab}`;
          assert.equal(container.querySelector('[aria-label="System pages"]').nextElementSibling, main);
          assert.equal(system.querySelectorAll('[data-read-state]').length, kind ? 1 : 0, message);
          assert.equal(system.querySelector('[data-read-state]')?.dataset.readState ?? null, kind, message);
          assert.equal(system.querySelectorAll('[role="alert"]').length, ['error', 'unavailable'].includes(kind) ? 1 : 0, message);
          assert.equal(system.textContent.split(expected).length - 1, 1, message);
          if (state.unbound) {
            assert.match(system.textContent, /Not connected/);
            assert.doesNotMatch(system.textContent, /Owner read in progress/);
          }
          if (state.earlier) {
            assert.match(system.textContent, /earlier report/);
            assert.match(system.textContent, /Observed service history/);
          }
          if (!kind) {
            assert.match(system.querySelector('[role="status"]').textContent, /7 checks need attention:/);
            assert.equal(system.textContent.includes('Native checks and alert delivery'), tab === 'checks');
            assert.match(system.textContent, /Recorded incidents/);
          }
          const buttons = [...system.querySelectorAll('button')].filter(button => button.textContent === 'Retry');
          assert.equal(buttons.length, retry ? 1 : 0, message);
          for (const button of buttons) await React.act(async () => button.click());
          assert.deepEqual(retries, retry ? [retry] : [], message);
        } finally {
          await React.act(async () => root.unmount());
          container.remove();
        }
      }
    }
  });
}
