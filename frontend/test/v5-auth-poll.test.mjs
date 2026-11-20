import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as ReactQuery from '@tanstack/react-query';
import * as Router from 'react-router-dom';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';

const browser = new Window({ url: 'https://fixture.invalid/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? browser : browser[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');

test('a failed second auth poll retains the routed draft until auth is revoked', async (context) => {
  const unrelatedViews = Object.fromEntries([
    '@/hooks/useServer', '@/lib/auth', './V5Pages', './AgentDecisionsPage', './V5System',
    './V5MarketHome', './V5AppShell', '@/pages/tabs/ActiveBotsTab', './LearningPanel',
    './ResearchFactoryPanel', './DecisionLineagePanel', './V5Helm', './V5Overview',
    './V5NotFound', './usePaperObservation', './OwnerJournalCondition',
  ].map(name => [name, {}]));
  const { load } = frontendModules({
    ...unrelatedViews, '@tanstack/react-query': ReactQuery, 'react-router-dom': Router,
  }, { 'v5/V5App.tsx': ['AuthGate', 'client'] });
  const { AuthGate, client } = load('v5/V5App.tsx');
  const queryKey = ['v5-auth'];
  let resolveFirst;
  const firstResponse = new Promise(resolve => { resolveFirst = resolve; });
  let polls = 0;
  context.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, '/api/v5/auth');
    polls += 1;
    if (polls === 1) return firstResponse;
    if (polls === 2) throw new Error('fixture network failure');
    return Response.json({ authenticated: polls === 3 });
  });
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const element = React.createElement;
  const poll = () => React.act(async () => {
    await client.refetchQueries({ queryKey }, { cancelRefetch: false });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  try {
    await React.act(async () => {
      root.render(element(ReactQuery.QueryClientProvider, { client }, element(Router.MemoryRouter, null,
        element(Router.Routes, null, element(Router.Route, { element: element(AuthGate) },
          element(Router.Route, { path: '/', element: element('input', { 'aria-label': 'Draft' }) }),
        )),
      )));
    });
    resolveFirst(Response.json({ authenticated: true }));
    await poll();
    assert.equal(polls, 1);
    const draft = container.querySelector('[aria-label="Draft"]');
    assert.ok(draft);
    draft.value = 'unsaved notes';

    await poll();
    assert.equal(polls, 2);
    assert.ok(container.querySelector('[aria-label="Draft"]') === draft, 'draft must remain mounted');
    assert.equal(draft.value, 'unsaved notes');
    assert.match(container.querySelector('[role="status"]').textContent, /reconnecting/i);
    assert.doesNotMatch(container.textContent, /Workspace connection failed/);

    await poll();
    assert.ok(container.querySelector('[aria-label="Draft"]') === draft, 'recovery must not remount the draft');
    assert.equal(container.querySelector('[role="status"]'), null);
    await poll();
    assert.equal(container.querySelector('[aria-label="Draft"]'), null);
    assert.ok(container.querySelector('#v5-session-token'));
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
    container.remove();
    await browser.happyDOM.close();
  }
});
