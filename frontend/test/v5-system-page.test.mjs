import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Router from 'react-router-dom';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';
import { readFileSync } from 'node:fs';

const browser = new Window({url:'https://fixture.invalid/'});
for (const name of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver']) Object.defineProperty(globalThis, name, {value:name === 'window' ? browser : browser[name], configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {createRoot} = await import('react-dom/client');

test('old addresses select their corresponding System tabs', () => {
  const routes = readFileSync(new URL('../src/v5/V5App.tsx', import.meta.url), 'utf8');
  for (const [oldPath, tab] of [['/operations','checks'], ['/v5/readiness','readiness'], ['/settings','settings']]) {
    assert.ok(routes.includes(`<Route path="${oldPath}" element={<V5System initialTab="${tab}" />}`), oldPath);
  }
  const {groupOf} = frontendModules({'@/hooks/useTheme':{}, '@/lib/auth':{}}, {'v5/V5AppShell.tsx':['groupOf']}).load('v5/V5AppShell.tsx');
  for (const path of ['/operations','/v5/readiness','/settings','/system/checks']) assert.equal(groupOf(path)?.label, 'System');
});

test('System integer totals are exact and incomplete counts stay unavailable', () => {
  const {load} = frontendModules({
    '@/features/quant-ops/kit/charts': {}, '@/features/quant-ops/kit/grid': {},
    './V5CandleStore': {}, './V5MarketDetail': {}, './V5MarketFeatures': {},
  });
  const {exactSystemCount, systemTime, systemStoreCurrent} = load('v5/V5Market.tsx');
  assert.equal(exactSystemCount([9007199254740991, 9007199254740991]), '18014398509481982');
  assert.equal(exactSystemCount([1, null]), null);
  assert.equal(exactSystemCount([]), null);
  assert.equal(exactSystemCount([1.5]), null);
  assert.equal(systemTime(0, 60000), '1970-01-01 00:00Z · 60 s ago');
  assert.equal(systemTime(null, 60000), '— · time not reported');
  assert.match(systemTime(61000, 60000), /owner clock ahead/);
  const summary = {now:1000,status_age_s:10,tiles:[]};
  assert.equal(systemStoreCurrent(summary, 1_000_000, 1_000_000), true);
  assert.equal(systemStoreCurrent(summary, 1_000_000, 1_051_000), false);
  assert.equal(systemStoreCurrent({...summary,status_age_s:null}, 1_000_000, 1_000_000), false);
  assert.equal(systemStoreCurrent({...summary,now:1001}, 1_000_000, 1_000_000), false);
});

test('market system tabs show only current owner inputs and the selected view', () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const summary = {now:1000,status_age_s:10,tiles:[{lane:'okx__spot',venue:'okx',segment:'spot',available:true,health:'red',pairs_held:1,pairs_listed:1,coverage_24h:1,coverage_7d:1,gaps_7d:5,last_minute_age_s:30}]};
    const workspace = {source_refresh:{feed_freshness:'FRESH',feed_fresh_until_ms:1_030_000,last_success_at_ms:999_000},context:{cutoff_ms:999_000,features:{}}};
    const overrides = {
      '@tanstack/react-query': {useQuery: ({queryKey}) => queryKey[0] === 'v5-profile' ? {data:{candle_store:{configured:true}}} : queryKey[1] === 'market-summary' ? {isSuccess:true,data:summary,dataUpdatedAt:1_000_000} : {isSuccess:true,data:workspace}},
      '@/features/quant-ops/kit/charts': {}, '@/features/quant-ops/kit/grid': {},
      './usePaperClock': {usePaperClock: () => now},
      './V5CandleStore': {}, './V5MarketDetail': {}, './V5MarketFeatures': {V5MarketFeatures:() => React.createElement('p',null,'FEATURE PACKET')},
    };
    const {V5SystemMarket} = frontendModules(overrides).load('v5/V5Market.tsx');
    const feeds = renderToStaticMarkup(React.createElement(V5SystemMarket,{tab:'data-feeds',paused:false}));
    assert.match(feeds, /Venue coverage/); assert.match(feeds, /okx/); assert.match(feeds, /class="is-down" title="Owner health: red · available"/); assert.doesNotMatch(feeds, /FEATURE PACKET/);
    assert.match(feeds, /7-day coverage<\/span><strong title="exact mean of 1 = 100%">100\.0%/);
    assert.match(feeds, /7-day coverage 100\.0% · missing minutes 5/);
    assert.match(feeds, /title="1">100%<\/span>/);
    summary.tiles[0].coverage_7d = 0.1;
    summary.tiles.push({...summary.tiles[0],lane:'other__spot',venue:'other',coverage_7d:0.2});
    const mean = renderToStaticMarkup(React.createElement(V5SystemMarket,{tab:'data-feeds',paused:false}));
    assert.match(mean, /7-day coverage<\/span><strong title="exact mean of 0\.1, 0\.2 = 15%">15\.0%/);
    assert.match(mean, /exact mean.*0\.1.*0\.2/);
    summary.tiles[1].coverage_7d = null;
    assert.match(renderToStaticMarkup(React.createElement(V5SystemMarket,{tab:'data-feeds',paused:false})), /7-day coverage is missing or invalid/);
    summary.tiles.pop(); summary.tiles[0].coverage_7d = 1;
    const inputs = renderToStaticMarkup(React.createElement(V5SystemMarket,{tab:'engine-inputs',paused:false}));
    assert.match(inputs, /FEATURE PACKET/); assert.doesNotMatch(inputs, /Venue coverage/);
    summary.tiles.push({lane:'bad__spot',venue:'bad',segment:'spot',available:false,pairs_held:999,pairs_listed:999,coverage_24h:1,coverage_7d:1,gaps_7d:999,last_minute_age_s:1});
    const partial = renderToStaticMarkup(React.createElement(V5SystemMarket,{tab:'data-feeds',paused:false}));
    assert.match(partial, /lane unavailable/); assert.match(partial, /lane not reported/); assert.doesNotMatch(partial, /999\/999/);
    assert.match(partial, /A lane is unavailable or gaps were not reported/);
    summary.tiles.pop();
    now += 61_000;
    assert.match(renderToStaticMarkup(React.createElement(V5SystemMarket,{tab:'data-feeds',paused:true})), /Candle store data is not current/);
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(V5SystemMarket,{tab:'engine-inputs',paused:true})), /FEATURE PACKET/);
  } finally { Date.now = originalNow; }
});

test('System market rejects missing or malformed lane collections without crashing either tab', () => {
  for (const tiles of [undefined, null, {}, [null]]) {
    const summary = {now:1000,status_age_s:10,tiles};
    const {V5SystemMarket} = frontendModules({
      '@tanstack/react-query': {useQuery: ({queryKey}) => queryKey[0] === 'v5-profile' ? {data:{candle_store:{configured:true}}} : queryKey[1] === 'market-summary' ? {isSuccess:true,data:summary,dataUpdatedAt:1_000_000} : {isSuccess:true,data:{}}},
      './usePaperClock': {usePaperClock: () => 1_000_000},
      '@/features/quant-ops/kit/charts': {}, '@/features/quant-ops/kit/grid': {}, './V5CandleStore': {}, './V5MarketDetail': {}, './V5MarketFeatures': {},
    }).load('v5/V5Market.tsx');
    for (const tab of ['data-feeds','engine-inputs']) {
      const html = renderToStaticMarkup(React.createElement(V5SystemMarket,{tab,paused:false}));
      assert.match(html, /— · Candle store lane data is invalid/);
    }
  }
});

test('engine inputs retain owner decimal strings and explain unqualified values', () => {
  const {V5MarketFeatures} = frontendModules().load('v5/V5MarketFeatures.tsx');
  const html = renderToStaticMarkup(React.createElement(V5MarketFeatures,{features:{
    'spot.advancers':{status:'QUALIFIED',unit:'asset_count',value:'0.123456789012345678901234567890'},
    'baseline.composite_score':{status:'UNAVAILABLE',unit:'score',value:'123'},
  }}));
  assert.match(html, /exact ≈ 0\.123456789012 \(rounded\)/);
  assert.match(html, /— · unavailable/);
  assert.doesNotMatch(html, />123<\/strong>/);
});

test('System tabs route correctly and pause changes only the page interval', async () => {
  const intervals = [];
  const mocks = {
    '@tanstack/react-query': {useQuery: () => ({data:{readiness:{paper_owner:{bot_name:'paper'}}}}), useQueryClient: () => ({})},
    './usePaperObservation': {usePaperWorkspace: (_page, _bot, interval) => {intervals.push(interval); return {data:{fixture:true},error:null,pending:false,refresh(){}};}},
    '@/hooks/useTheme': {useTheme: () => ({theme:'dark', toggleTheme(){}})},
    '@/lib/auth': {useAuth: () => ({logout(){}})},
    './V5Pages': {PaperReadinessPage: () => React.createElement('p',null,'READINESS CONTENT'), SettingsPage: () => React.createElement('p',null,'SETTINGS CONTENT')},
    './V5Market': {V5SystemMarket: ({tab}) => React.createElement('p',null,`${tab} CONTENT`)},
    '@workspace-monitoring': {SystemOverview: () => React.createElement('p',null,'SUMMARY'), Operations: ({incidentsOnly}) => React.createElement('p',null,incidentsOnly ? 'OPERATIONS CONTENT' : 'CHECKS CONTENT')},
  };
  const {load} = frontendModules(mocks);
  const {V5System, SystemPauseProvider} = load('v5/V5System.tsx');
  const {V5AppShell} = load('v5/V5AppShell.tsx');
  const systemRoute = props => React.createElement(V5AppShell, null, React.createElement(V5System, props));
  for (const [tab,content] of [['checks','CHECKS CONTENT'],['data-feeds','data-feeds CONTENT'],['engine-inputs','engine-inputs CONTENT'],['readiness','READINESS CONTENT'],['settings','SETTINGS CONTENT'],['operations','OPERATIONS CONTENT']]) {
    const node = document.createElement('div'); document.body.append(node);
    const root = createRoot(node);
    await React.act(async () => {root.render(React.createElement(Router.MemoryRouter,{initialEntries:[`/system/${tab}`]},React.createElement(Router.Routes,null,React.createElement(Router.Route,{path:'/system/:tab',element:systemRoute()}))));});
    assert.match(node.textContent, new RegExp(content));
    assert.equal(node.querySelector('[aria-label="System pages"] [aria-current="page"]').getAttribute('href'), `/system/${tab}`);
    assert.match(node.textContent, /Updates every 15 s/);
    await React.act(async () => node.querySelector('.v5-system button').click());
    assert.equal(intervals.at(-1), false);
    assert.match(node.textContent, /Paused at \d\d:\d\d:\d\d UTC/);
    await React.act(async () => node.querySelector('.v5-system button').click());
    assert.equal(intervals.at(-1), 15_000);
    await React.act(async () => root.unmount()); node.remove();
  }
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  await React.act(async () => {root.render(React.createElement(SystemPauseProvider,null,React.createElement(Router.MemoryRouter,{initialEntries:['/operations']},React.createElement(Router.Routes,null,
    React.createElement(Router.Route,{path:'/operations',element:systemRoute({initialTab:'checks'})}),
    React.createElement(Router.Route,{path:'/system/:tab',element:systemRoute()})))));});
  await React.act(async () => node.querySelector('.v5-system button').click());
  await React.act(async () => node.querySelector('a[href="/system/data-feeds"]').dispatchEvent(new browser.MouseEvent('click',{bubbles:true,cancelable:true,button:0})));
  assert.match(node.textContent, /Paused at \d\d:\d\d:\d\d UTC/);
  assert.match(node.textContent, /data-feeds CONTENT/);
  assert.equal(intervals.at(-1), false);
  await React.act(async () => root.unmount()); node.remove();
});
