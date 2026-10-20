import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

function loadingAccount() {
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({ data: undefined, error: null, dataUpdatedAt: 0, isLoading: true, isFetching: false, refetch: async () => ({}) }) },
    '@/hooks/useServer': { useServer: () => ({ server: 'local' }) },
    '@/lib/api': { api: {} },
    'react-router-dom': { Link: ({ to, children, ...props }) => React.createElement('a', { href: to, ...props }, children) },
  });
  const { AccountPortfolio } = load('components/AccountPortfolio.tsx');
  return renderToStaticMarkup(React.createElement(AccountPortfolio));
}

test('portfolio shows unavailable owner currency while no account observation exists', () => {
  const html = loadingAccount();
  assert.match(html, /Reporting currency: Unavailable/);
  assert.doesNotMatch(html, /Reporting currency: USDT/);
});
