import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';
import { renderResearch, envelope } from './helpers/research-render.mjs';

const native = { native: true, full: false, online: true, botRead: true, botStop: false };
function page(name, access, search = '') {
  const overrides = {
    '@/hooks/useServerCapabilities': { useServerCapabilities: () => ({ access, refetch() {}, dataUpdatedAt: 1 }) },
    '@/hooks/useServer': { useServer: () => ({ server: 'fixture-native' }) },
    'react-router-dom': { useSearchParams: () => [new URLSearchParams(search), () => {}], Link: ({ to, children }) => React.createElement('a', { href: to }, children), Navigate: ({ to }) => React.createElement('a', { 'data-redirect': to }) },
  };
  const { load } = frontendModules(overrides);
  return renderToStaticMarkup(React.createElement(load(`pages/${name}.tsx`)[name]));
}
test('native Bots removes unsupported tab controls but preserves explicit unsupported deep-link state', () => {
  const html = page('Bots', native, 'tab=editor');
  assert.match(html, /Only the Active bot status view is supported/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, /fixture-native/);
  assert.match(html, /settings\?tab=tools/);
});
test('full server retains all five bot tab controls', () => {
  assert.equal((page('Bots', { ...native, native: false, full: true }, 'tab=unknown').match(/<button/g) ?? []).length, 5);
});
test('legacy Tools route redirects to Settings capabilities', () => {
  assert.match(page('WorkspaceTools', native), /data-redirect="\/settings\?tab=tools"/);
});
test('Research landing prioritizes recorded assessment/attempt records and does not load the network', () => {
  const data = {
    'research-overview': { data: envelope({ revision: 'r1', counts: {}, freshness: { state: 'CURRENT' } }) },
    'research-recent-assessments': { data: envelope({ revision: 'r1', items: [{ id: 'a1', title: 'Recorded rejection', status: 'CONTRADICTED', data: { rationale: 'Fees exceeded edge' } }], total: 1 }) },
    'research-recent-runs': { data: envelope({ revision: 'r1', items: [{ id: 'r1', title: 'Owner attempt', status: 'FAILED', data: {} }], total: 1 }) },
  };
  const result = renderResearch(data, { search: "" });
  assert.ok(result.requests.find(item => item.queryKey[0] === 'research-network')?.enabled === false);
  assert.match(result.html, /Recorded rejection/);
  assert.match(result.html, /Fees exceeded edge/);
  assert.match(result.html, /FAILED/);
  assert.doesNotMatch(result.html, /The research landscape/);
});

test('Settings hosts full-server tools and existing settings destinations under one selected-server context', () => {
  const child = () => null;
  const { load } = frontendModules({
    '@/hooks/useServerCapabilities': { useServerCapabilities: () => ({ access: { online: true, full: true, manualTrading: true, executors: true, botRead: true, botStop: true }, refetch() {}, dataUpdatedAt: 1 }) },
    '@/hooks/useServer': { useServer: () => ({ server: 'full-fixture' }) },
    '@/hooks/useDeploymentPolicy': { useDeploymentPolicy: () => ({ settingsMutation: true }) },
    '@/lib/auth': { useAuth: () => ({ logout() {} }) },
    ...Object.fromEntries(['ApiKeysSettings', 'CustomProvidersSettings', 'GatewaySettings', 'ServersSettings', 'VoiceSettings'].map(name => [`@/components/settings/${name}`, { [name]: child }])),
    'react-router-dom': { useSearchParams: () => [new URLSearchParams('tab=tools'), () => {}], Link: ({ to, children }) => React.createElement('a', { href: to }, children) },
  });
  const html = renderToStaticMarkup(React.createElement(load('pages/Settings.tsx').Settings));
  for (const to of ['/executors', '/agents', '/routines', '/trade']) assert.ok(html.includes(`href="${to}"`), to);
  for (const label of ['Connections', 'Integrations', 'AI', 'full-fixture']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /href="\/portfolio"|href="\/research"|href="\/settings"/);
});

test('Research landing withholds stale or mismatched conclusions rather than retaining an old verdict', () => {
  for (const unavailable of [{ isError: true, error: new Error('Read failed') }, {}]) {
    const result = renderResearch({
      'research-overview': { data: envelope({ revision: 'current', freshness: {} }) },
      'research-recent-assessments': { data: envelope({ revision: 'old', items: [{ id: 'a', title: 'OLD_VERDICT', status: 'SUPPORTED' }] }), ...unavailable },
    }, { search: '' });
    assert.doesNotMatch(result.html, /OLD_VERDICT/);
    assert.ok(result.html.includes('Read failed') || result.html.includes('another index revision'));
  }
});
