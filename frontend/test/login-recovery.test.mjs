import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

function renderLogin(reason, result = true) {
  const effects = [], buttons = [], calls = [], navigations = [];
  const capture = name => (type, props, ...rest) => {
    if (type === 'button') buttons.push(props);
    return jsxRuntime[name](type, props, ...rest);
  };
  const modules = frontendModules({
    react: { ...React, useEffect: effect => effects.push(effect) },
    'react/jsx-runtime': { ...jsxRuntime, jsx: capture('jsx'), jsxs: capture('jsxs') },
    '@/lib/auth': { useAuth: () => ({ isAuthenticated: false, recoveryReason: reason, loginWithToken: async () => false, loginWithTailscale: async () => { calls.push('sign-in'); return result; } }) },
    'react-router-dom': { useNavigate: () => (to, options) => navigations.push({ to, options }), useSearchParams: () => [new URLSearchParams({ redirect: '/trading-visuals?bot=ok_rsi#activity' })] },
  });
  const html = renderToStaticMarkup(React.createElement(modules.load('pages/Login.tsx').Login));
  effects.forEach(effect => effect());
  return { html, buttons, calls, navigations };
}

test('expired or invalid sessions show explicit retry without automatic sign-in', async () => {
  for (const reason of ['expired', 'invalid', 'signed_out', 'changed']) {
    const view = renderLogin(reason);
    await Promise.resolve();
    assert.equal(view.calls.length, 0);
    assert.ok(view.buttons.some(button => typeof button.onClick === 'function'));
  }
});

test('manual sign-in returns to the complete internal destination once', async () => {
  const view = renderLogin('expired');
  const retry = view.buttons.find(button => typeof button.onClick === 'function');
  assert.ok(retry);
  await retry.onClick();
  assert.equal(view.calls.length, 1);
  assert.deepEqual(view.navigations, [{ to: '/trading-visuals?bot=ok_rsi#activity', options: { replace: true } }]);
});

test('failed manual sign-in does not navigate or trigger an automatic retry loop', async () => {
  const view = renderLogin('expired', false);
  const retry = view.buttons.find(button => typeof button.onClick === 'function');
  assert.ok(retry);
  await retry.onClick();
  assert.equal(view.calls.length, 1);
  assert.deepEqual(view.navigations, []);
});
