import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';
import { unavailableServerRoute } from '../src/lib/server-capabilities.ts';

const require = createRequire(import.meta.url);
const { matchPath } = require('react-router-dom');
const link = ({ to, children }) => React.createElement('a', { href: to }, children);

test('the public placeholder names Tradepad, explains the missing workspace and links the backend viewer', () => {
  const placeholder = frontendModules({ 'react-router-dom': { Link: link } }).load('features/workspace-monitoring/unavailable.tsx');
  const html = renderToStaticMarkup(React.createElement(placeholder.Tradepad));
  assert.match(html, /<h1[^>]*>Tradepad<\/h1>/);
  assert.match(html, /role="status"/);
  assert.match(html, /Monitoring workspace unavailable/);
  assert.match(html, /<a[^>]*href="\/tradepad"[^>]*>Open the Tradepad viewer<\/a>/, 'the backend viewer is a document link, not a client route');
  const operations = renderToStaticMarkup(React.createElement(placeholder.Operations));
  assert.match(operations, /<h1[^>]*>Operations<\/h1>/);
  assert.ok(!operations.includes('/tradepad'), 'other placeholders are unchanged');
});

function appRoutes() {
  const Route = function Route() { return null; };
  const Navigate = function Navigate() { return null; };
  const Pass = ({ children }) => children;
  const WorkspaceTradepad = function WorkspaceTradepad() { return null; };
  const overrides = {
    'react-router-dom': { BrowserRouter: Pass, Routes: Pass, Route, Navigate, useLocation: () => ({ pathname: '/' }), useParams: () => ({}), Link: link },
    '@/lib/auth': { AuthContext: Pass, SERVER_KEY: 'condor_selected_server', useAuth: () => ({ isAuthenticated: true }), useAuthState: () => ({ user: { id: 1 } }) },
    '@/components/layout/AppShell': { AppShell: () => null },
    '@workspace-monitoring': { Tradepad: WorkspaceTradepad },
  };
  for (const name of ['AgentDetail', 'Agents', 'BotDetail', 'Bots', 'CreateExecutor', 'Executors', 'Login', 'Portfolio', 'Routines', 'Settings', 'StrategyDetail', 'WorkspaceTools']) overrides[`@/pages/${name}`] = { [name]: () => null };
  const App = frontendModules(overrides).load('App.tsx').default;
  const routes = [];
  const visit = (node, layout) => {
    if (Array.isArray(node)) return node.forEach(child => visit(child, layout));
    if (!node || typeof node !== 'object' || !node.props) return;
    if (node.type === Route) {
      routes.push({ path: node.props.path, element: node.props.element, layout });
      return visit(node.props.children, node.props.path ? layout : node.props.element);
    }
    visit(node.props.children, layout);
  };
  visit(App(), null);
  return { routes, Navigate, WorkspaceTradepad };
}

test('/backtests lazily mounts the workspace Tradepad inside the protected layout; /backtest still opens Hummingbot backtests', async () => {
  const { routes, Navigate, WorkspaceTradepad } = appRoutes();
  const tradepad = routes.find(route => route.path === '/backtests');
  assert.ok(tradepad, 'the /backtests route exists');
  const research = routes.find(route => route.path === '/research');
  assert.equal(tradepad.layout, research.layout, 'Tradepad shares the protected shell with Research');
  assert.ok(tradepad.layout, 'the route is nested under the authenticated layout');
  assert.equal(tradepad.element.type, React.Suspense);
  const lazy = tradepad.element.props.children.type;
  assert.equal(lazy.$$typeof, Symbol.for('react.lazy'));
  try {
    lazy._init(lazy._payload);
  } catch (pending) {
    assert.equal(typeof pending?.then, 'function', 'the page module loads on demand');
    await pending;
  }
  assert.equal(lazy._init(lazy._payload), WorkspaceTradepad, 'the page comes from @workspace-monitoring');
  const legacy = routes.find(route => route.path === '/backtest');
  assert.equal(legacy.element.type, Navigate);
  assert.deepEqual(legacy.element.props, { to: '/bots?tab=backtest', replace: true });
  assert.equal(routes.filter(route => route.path === '/tradepad').length, 0, 'the backend serves /tradepad; the app does not route it');
});

const serverRow = { name: 'owner', host: '127.0.0.1', port: 8080, permission: 'admin', online: true };
const PROFILES = {
  native: { status: 'online', profile: 'native', capabilities: { native_status: true } },
  full: { status: 'online', profile: 'full' },
  offline: { status: 'error', profile: 'native', capabilities: {} },
};

function shell({ status, pathname = '/backtests', hasKeys = true }) {
  const prefetch = [];
  const modules = frontendModules({
    '@tanstack/react-query': {
      useQueryClient: () => ({ getQueryData: () => status }),
      useQuery(options) {
        const result = options.queryKey[0] === 'servers' ? { data: [serverRow] } : { data: status };
        return { isError: false, isPending: false, isLoading: false, isFetching: false, ...result, refetch: async () => result };
      },
    },
    '@/hooks/useServer': { useServer: () => ({ server: 'owner', setServer: () => {}, persistenceError: null }) },
    '@/hooks/useTheme': { useTheme: () => ({ theme: 'dark', toggleTheme: () => {} }) },
    '@/hooks/useCredentials': { useCredentials: () => ({ hasKeys, isLoading: false }) },
    '@/components/chat/ChatProvider': { ChatProvider: ({ children }) => children },
    '@/hooks/usePrefetchData': { usePrefetchData: enabled => prefetch.push(enabled) },
    '@/hooks/useDisplayCurrency': { useDisplayCurrency: () => ({ currency: 'USDT', setCurrency: () => {} }), CURRENCY_OPTIONS: ['USDT'], CURRENCY_SYMBOLS: { USDT: '$' } },
    '@/lib/api': { api: { getServers: () => { throw new Error('Network forbidden'); }, getServerStatus: () => { throw new Error('Network forbidden'); } } },
    '@/components/ConnectKeysOverlay': { ConnectKeysOverlay: () => React.createElement('p', null, 'Connect keys overlay') },
    'react-router-dom': {
      NavLink: link, Link: link, Outlet: () => React.createElement('p', null, 'Protected route content'),
      useLocation: () => ({ pathname }), useNavigate: () => () => {}, matchPath,
    },
  });
  const html = renderToStaticMarkup(React.createElement(modules.load('components/layout/AppShell.tsx').AppShell));
  const nav = [...html.matchAll(/<a href="([^"]+)"><svg[^>]*>[\s\S]*?<\/svg>([^<]+)<\/a>/g)].map(match => [match[1], match[2]]);
  return { html, nav, prefetch };
}

test('the Tradepad nav item sits right after Research for native, full and offline profiles', () => {
  for (const [profile, status] of Object.entries(PROFILES)) {
    const { nav } = shell({ status });
    const index = nav.findIndex(([href]) => href === '/research');
    assert.ok(index >= 0, `${profile}: Research is listed`);
    assert.deepEqual(nav[index + 1], ['/backtests', 'Tradepad'], `${profile}: Tradepad follows Research`);
  }
});

test('Tradepad opens without a verified server, keys or trading prefetch', () => {
  const offline = shell({ status: PROFILES.offline });
  assert.match(offline.html, /Protected route content/, 'the catalog does not depend on the selected trading server');
  const noKeys = shell({ status: PROFILES.full, hasKeys: false });
  assert.ok(!noKeys.html.includes('Connect keys overlay'), 'exchange keys are not needed to read backtests');
  assert.match(shell({ status: PROFILES.full, hasKeys: false, pathname: '/bots' }).html, /Connect keys overlay/, 'other routes keep the keys overlay');
  assert.deepEqual(noKeys.prefetch, [false], 'no executor, bot or candle prefetch on the catalog');
  assert.deepEqual(shell({ status: PROFILES.full, pathname: '/bots' }).prefetch, [true]);
  for (const status of [undefined, PROFILES.offline, PROFILES.native]) {
    assert.equal(unavailableServerRoute('/backtests', status), null);
    assert.equal(typeof unavailableServerRoute('/backtest', status), 'string', 'Hummingbot backtests keep their automation gate');
  }
});
