import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import * as Router from 'react-router-dom';
import {Window} from 'happy-dom';
import {frontendModules} from './helpers/frontend-module.mjs';
import {clockMutation} from './helpers/paper-clock-mutants.mjs';

const browser = new Window({url:'https://fixture.invalid/'});
for (const name of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','localStorage']) {
  Object.defineProperty(globalThis,name,{value:name === 'window' ? browser : browser[name],configurable:true});
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {createRoot} = await import('react-dom/client');
const fixture = relative => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/${relative}`,import.meta.url)));
const baseline = fixture('v5_unbound_base_8284ffe7.json');
const sections = Object.fromEntries(['status','wallet','positions','executors','risk','fills','decisions','history','accounting','operations'].map(section => [section,fixture(`paper-api-final3/native-replay/${section}.json`)]));
sections.status.state = 'available';
sections.status.reason = null;
const bot = sections.status.bot_id;
const identity = {name:'RSI V5',host:'razer',mode:'reports-only',execution_enabled:false,baseline_binding:null};
const settings = {...baseline.settings,identity,budget:{enabled:false}};
const profile = {...baseline.profile.body,readiness:{...baseline.profile.body.readiness,paper_owner:{bot_name:bot,state:'FRESH',generated_at:sections.status.generated_at_ms / 1000,reason:'fixture',mode:'PAPER'}}};
const workspace = {schema_version:'v5-workspace.v1',identity,context:null,advisor:settings.budget,agents:Object.values(baseline.workspace_agents),sessions:[],source_error:null};
const routes = [
  ['/settings','Workspace settings'], ['/bots','Paper bots'], ['/capital','Capital'],
  ['/operations','Operations'], ['/v5/readiness','Paper readiness'],
  ['/backtests','Tradepad'], ['/','Market'], ['/market/evidence','Market Picture'],
  ['/market/candles','Candle store'], ['/agents','Agents'],
  ['/agents/decision_reviewer','Decision Reviewer'], ['/research','Research'],
  ['/learning','Learning'], ['/research-factory','Research factory'],
  ['/decision-lineage','Decision lineage'], ['/sessions','Sessions'],
  ['/sessions/fixture-session','Session'],
];

test('real V5 routes settle with shared providers and an advancing paper clock', async context => {
  const routeSource = fs.readFileSync(new URL('../src/v5/V5App.tsx',import.meta.url),'utf8');
  const registered = [...routeSource.matchAll(/<Route path="([^"]+)"/g)].map(match => match[1]).filter(pathname => pathname !== '*').map(pathname => pathname.replace('/agents/:id','/agents/decision_reviewer').replace('/sessions/:id','/sessions/fixture-session'));
  assert.deepEqual(routes.map(([pathname]) => pathname).sort(),registered.sort(),'every registered V5 route needs a real render case');
  let route = '/settings';
  const journalRoutes = new Set(['/bots', '/operations', '/v5/readiness']);
  const statusForRoute = () => journalRoutes.has(route) ? {...sections.status, state:'degraded', reason:'OWNER_JOURNAL_EXCEEDED', data:{...sections.status.data, journal_budget:{state:'exceeded',journal_evidence_held:true,native_execution_continues:true}}} : sections.status;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalError = console.error;
  let now = sections.status.read_at_ms;
  Date.now = () => ++now;
  const overrides = {'lightweight-charts':await import('lightweight-charts'),'react-router-dom':{...Router,BrowserRouter:({children}) => React.createElement(Router.MemoryRouter,{initialEntries:[route]},children)}};
  const {load} = frontendModules(overrides,{'v5/V5App.tsx':['client']},(filename,source) => {
    source = clockMutation(filename,source);
    if (!filename.endsWith('/v5/V5Pages.tsx')) return source;
    const anchor = 'function PaperIdentity() {';
    assert.equal(source.split(anchor).length - 1,1,'frame probe must target exactly one real PaperIdentity');
    return source.replace(anchor,`${anchor} globalThis.__v5FrameBoundaryAdvance?.();`);
  });
  overrides['@/lib/auth-token'] = load('v5/auth-token.ts');
  const workspaceRoot = process.env.V5_WORKSPACE_ROOT ?? path.resolve(import.meta.dirname,'../../..');
  overrides['@workspace-monitoring'] = load(path.join(workspaceRoot,'dashboard/condor-workspace/src/index.ts'));
  const {V5App,client} = load('v5/V5App.tsx');
  client.setDefaultOptions({queries:{retry:false,staleTime:Infinity,gcTime:Infinity}});
  const requests = [];
  const unexpectedReads = [];
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(init.method ?? 'GET','GET','render tests must not invoke actions');
    const url = new URL(String(input),'https://fixture.invalid');
    requests.push(url.pathname + url.search);
    let body;
    if (url.pathname === '/api/v5/dashboard/read') {
      const native = url.searchParams.get('path');
      const section = native.includes('native/status') ? 'status' : native.includes('account-balances') || native.includes('fleet/summary') ? 'wallet' : native.includes('holdings') ? 'positions' : native.includes('performance/history') ? 'history' : native.includes('operations/workspace') ? 'operations' : native.split('?')[0].split('/').at(-1);
      assert.ok(sections[section],`unmapped owner read: ${native}`);
      body = section === 'status' ? statusForRoute() : sections[section];
    } else if (url.pathname === '/api/v5/auth') body = {authenticated:true};
    else if (url.pathname === '/api/v5/dashboard/profile') body = profile;
    else if (url.pathname === '/api/v5/settings') body = settings;
    else if (url.pathname === '/api/v5/workspace') body = workspace;
    else if (url.pathname === '/api/v5/sessions') body = {sessions:[]};
    else if (url.pathname === '/api/v5/sessions/fixture-session') body = {...baseline['inspect:decision_reviewer'],id:'fixture-session',agent_id:'decision_reviewer',loop_id:null,started_at_ms:sections.status.read_at_ms,finished_at_ms:sections.status.read_at_ms,effect:'NONE',journal:'',ticks:baseline['inspect:decision_reviewer'].ticks.map((tick,index) => ({...tick,id:`tick-${index}`,at_ms:sections.status.read_at_ms,evidence_refs:[]}))};
    else if (url.pathname === '/api/v5/agents/decision_reviewer') body = baseline['agent:decision_reviewer'].body;
    else if (url.pathname.startsWith('/api/v5/learning/')) body = {effect:'NONE',status:'DISABLED',roles:[],reason:'Stage1 disabled'};
    else {unexpectedReads.push(url.pathname + url.search); throw new Error(`unmapped read: ${url}`);}
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try {
    for (const [pathname,heading] of routes) await context.test(pathname,async () => {
      route = pathname;
      const failures = [];
      const warnings = [];
      console.error = (...args) => warnings.push(args.map(String).join(' '));
      class Boundary extends React.Component {
        state = {failed:false};
        static getDerivedStateFromError() {return {failed:true};}
        componentDidCatch(error,info) {failures.push(`${error.message}${info.componentStack}`);}
        render() {return this.state.failed ? null : this.props.children;}
      }
      const container = document.createElement('div');
      document.body.append(container);
      const mount = createRoot(container);
      client.setQueryData(['v5-auth'],{authenticated:true});
      client.setQueryData(['v5-profile'],profile);
      client.setQueryData(['v5-settings'],settings);
      client.setQueryData(['v5-paper-observation-health',bot],['status','wallet','positions','executors','risk'].map(section => section === 'status' ? statusForRoute() : sections[section]));
      try {
        await React.act(async () => {mount.render(React.createElement(Boundary,null,React.createElement(V5App)));});
        await React.act(async () => {await client.refetchQueries({type:'active'});});
        await React.act(async () => {await new Promise(resolve => setTimeout(resolve,0));});
        assert.deepEqual(failures,[],'real route must not enter a render loop');
        assert.deepEqual(warnings,[],'React must not warn about unstable snapshots or cross-component updates');
        assert.ok(container.querySelector('main'),`${pathname} must keep the app mounted`);
        assert.ok(container.textContent.includes(heading),`${pathname} must render ${heading}: ${container.textContent}`);
        if (journalRoutes.has(pathname)) {
          assert.ok(container.textContent.includes('OWNER_JOURNAL_EXCEEDED'));
          assert.ok(container.textContent.includes('journal_evidence_held: true'));
          assert.ok(container.textContent.includes('native_execution_continues: true'));
        }
        if (pathname === '/settings') {
          const health = client.getQueryData(['v5-paper-observation-health',bot]);
          assert.deepEqual(health,['status','wallet','positions','executors','risk'].map(section => sections[section]));
          now = sections.status.generated_at_ms + 30000;
          Date.now = () => now;
          await React.act(async () => {window.dispatchEvent(new browser.Event('focus'));});
          assert.match(container.textContent,/paper owner reads: available/,'the owner fixture must be available at exactly 30 seconds');
          assert.match(container.textContent,/snapshot only/);
          globalThis.__v5FrameBoundaryAdvance = () => {now = sections.status.generated_at_ms + 30001;};
          try {
            await React.act(async () => {
              client.setQueryData(['v5-settings'],{...settings,frame_marker:'boundary'});
              await new Promise(resolve => setTimeout(resolve,0));
            });
          } finally {delete globalThis.__v5FrameBoundaryAdvance;}
          const text = container.textContent;
          assert.ok(!(text.includes('paper owner reads: available') && text.includes('stale; not current')),'Settings must not call owner reads available while identity marks the same snapshot stale');
          await React.act(async () => {window.dispatchEvent(new browser.Event('focus'));});
          assert.match(container.textContent,/stale; not current/,'the next turn must observe the crossed freshness boundary');
          assert.doesNotMatch(container.textContent,/paper owner reads: available/);
        }
        await React.act(async () => {window.dispatchEvent(new browser.Event('focus'));});
        if (pathname === '/settings') {
          assert.match(container.textContent,/stale; not current/,'focus must publish the stale flip at 30,001 ms');
          assert.doesNotMatch(container.textContent,/snapshot only/);
          assert.doesNotMatch(container.textContent,/paper owner reads: available/);
        }
        assert.deepEqual(failures,[],'clock publication must settle');
        assert.deepEqual(warnings,[],'clock publication must not trigger React warnings');
        assert.deepEqual(unexpectedReads,[],'every requested owner response must have a fixture');
      } finally {
        await React.act(async () => mount.unmount());
        container.remove();
        client.clear();
      }
    });
    assert.ok(requests.some(request => request.includes('native%2Fstatus')),'real snapshot query must read owner fixtures');
  } finally {
    client.clear();
    load('lib/candle-store.ts').candleStore.dispose();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    console.error = originalError;
    await browser.happyDOM.close();
  }
});
