import test, { after } from 'node:test';
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
after(() => browser.happyDOM.close());

async function checkDraftDuringReconnect(context, profileFailure, revokedAuth) {
  const AuthContext = React.createContext(null);
  const unrelatedViews = Object.fromEntries([
    './V5Pages', './AgentDecisionsPage',
    './V5MarketHome', '@/pages/tabs/ActiveBotsTab', './LearningPanel',
    './ResearchFactoryPanel', './DecisionLineagePanel', './V5Helm', './V5Overview',
    './V5NotFound', './usePaperObservation',
  ].map(name => [name, {}]));
  const { load } = frontendModules({
    ...unrelatedViews, '@tanstack/react-query': ReactQuery, 'react-router-dom': Router,
    '@/lib/auth': { AuthContext, useAuth: () => React.useContext(AuthContext) },
    '@/hooks/useTheme': { useTheme: () => ({ theme: 'dark', toggleTheme() {} }) },
    './usePaperClock': { usePaperClock: () => 0 },
    './V5System': { SystemPauseProvider: ({ children }) => children },
    './OwnerJournalCondition': { PaperJournalNotice: () => null },
  }, { 'v5/V5App.tsx': ['AuthGate', 'ProfileGate', 'client'] });
  const { AuthGate, ProfileGate, client } = load('v5/V5App.tsx');
  let resolveFirst;
  const firstResponse = new Promise(resolve => { resolveFirst = resolve; });
  const profile = {
    schema_version: 'v5-dashboard-profile.v1',
    server: { server_id: 'rsibot-v5', host: 'razer', mode: 'reports-only', execution_enabled: false },
    condor: { base_revision: 'ff8858df765cffe4d325fde384f7a2eecdf51641' },
    readiness: { paper_owner: { bot_name: 'fixture' } },
  };
  const unavailable = () => Response.json({ detail: { code: 'server_token_unavailable' } }, { status: 503 });
  let authPolls = 0;
  let profileUnavailable = true;
  context.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/v5/dashboard/profile') return profileUnavailable ? profileFailure() : Response.json(profile);
    assert.equal(url, '/api/v5/auth');
    authPolls += 1;
    if (authPolls === 1) return firstResponse;
    if (authPolls === 2) return unavailable();
    if (authPolls === 3) return Response.json({ authenticated: true });
    return revokedAuth();
  });
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const element = React.createElement;
  function DraftRoute() {
    const { isAuthenticated } = React.useContext(AuthContext);
    return element('textarea', { 'aria-label': 'Draft', 'data-authenticated': isAuthenticated });
  }
  const poll = key => React.act(async () => {
    await client.refetchQueries({ queryKey: [key] }, { cancelRefetch: false });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  const scope = () => container.querySelector('.v5-shell-mode')?.textContent;
  const status = () => container.querySelector('#v5-shell-status-slot[role="status"]')?.textContent ?? '';
  try {
    await React.act(async () => {
      root.render(element(ReactQuery.QueryClientProvider, { client }, element(Router.MemoryRouter, null,
        element(Router.Routes, null, element(Router.Route, { element: element(AuthGate) },
          element(Router.Route, { element: element(ProfileGate) },
            element(Router.Route, { path: '/', element: element(DraftRoute) })),
        )),
      )));
    });
    resolveFirst(Response.json({ authenticated: true }));
    await poll('v5-auth');
    await poll('v5-profile');
    assert.match(container.textContent, /V5 profile unavailable/);
    assert.equal(container.querySelector('#v5-shell-status-slot'), null);
    profileUnavailable = false;
    await poll('v5-profile');
    assert.equal(authPolls, 1);
    const draft = container.querySelector('[aria-label="Draft"]');
    assert.ok(draft);
    draft.value = 'unsaved notes';
    const shell = container.querySelector('#v5-shell-status-slot');
    assert.ok(shell);
    assert.equal(draft.dataset.authenticated, 'true');
    assert.equal(scope(), 'PAPER');

    await poll('v5-auth');
    const authDuring503 = draft.dataset.authenticated;
    const statusDuringAuth503 = status();
    profileUnavailable = true;
    await poll('v5-profile');
    assert.ok(container.querySelector('[aria-label="Draft"]') === draft, 'profile refetch failure must keep the editor mounted');
    assert.ok(container.querySelector('#v5-shell-status-slot') === shell, 'profile refetch failure must keep the shell mounted');
    assert.equal(draft.value, 'unsaved notes');
    assert.equal(authDuring503, 'false');
    assert.match(statusDuringAuth503, /session reconnecting/i);
    assert.equal(draft.dataset.authenticated, 'false');
    assert.match(status(), /session reconnecting/i);
    assert.equal(scope(), undefined);

    await poll('v5-auth');
    assert.equal(draft.dataset.authenticated, 'false', 'profile must also recover before confirming authority');
    assert.match(status(), /session reconnecting/i);
    profileUnavailable = false;
    await poll('v5-profile');
    assert.equal(container.querySelector('[aria-label="Draft"]'), draft, 'recovery must keep the editor mounted');
    assert.equal(draft.value, 'unsaved notes');
    assert.equal(draft.dataset.authenticated, 'true');
    assert.equal(scope(), 'PAPER');
    assert.equal(status(), '');
    await poll('v5-auth');
    assert.equal(container.querySelector('[aria-label="Draft"]'), null);
    assert.ok(container.querySelector('#v5-session-token'));
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
    container.remove();
  }
}

test('profile 503 retains the routed draft until auth returns authenticated:false', context => checkDraftDuringReconnect(
  context, () => new Response(null, { status: 503 }), () => Response.json({ authenticated: false }),
));

test('profile 502 retains the routed draft until auth returns 401', context => checkDraftDuringReconnect(
  context, () => new Response(null, { status: 502 }), () => new Response(null, { status: 401 }),
));

test('profile network failure retains the routed draft until auth returns authenticated:false', context => checkDraftDuringReconnect(
  context, () => { throw new TypeError('Failed to fetch'); }, () => Response.json({ authenticated: false }),
));
