import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import * as Router from 'react-router-dom';
import {Window} from 'happy-dom';
import {frontendModules} from './helpers/frontend-module.mjs';

const browser = new Window({url:'https://fixture.invalid/'});
for (const name of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','localStorage']) {
  Object.defineProperty(globalThis,name,{value:name === 'window' ? browser : browser[name],configurable:true});
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {createRoot} = await import('react-dom/client');
const fixture = relative => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/${relative}`,import.meta.url)));

test('first committed Settings remount rejects expired cached owner data before subscription refresh', async () => {
  const baseline = fixture('v5_unbound_base_8284ffe7.json');
  const sections = Object.fromEntries(['status','wallet','positions','executors','risk'].map(section => [section,fixture(`paper-api-final3/native-replay/${section}.json`)]));
  sections.status.state = 'available';
  sections.status.reason = null;
  const bot = sections.status.bot_id;
  const identity = {name:'RSI V5',host:'razer',mode:'reports-only',execution_enabled:false,baseline_binding:null};
  const settings = {...baseline.settings,identity,budget:{enabled:false}};
  const profile = {...baseline.profile.body,readiness:{...baseline.profile.body.readiness,paper_owner:{bot_name:bot,state:'FRESH',generated_at:sections.status.generated_at_ms / 1000,reason:'fixture',mode:'PAPER'}}};
  const originalNow = Date.now, originalFetch = globalThis.fetch, originalError = console.error;
  let now = sections.status.read_at_ms;
  Date.now = () => now;
  const overrides = {'lightweight-charts':await import('lightweight-charts'),'react-router-dom':{...Router,BrowserRouter:({children}) => React.createElement(Router.MemoryRouter,{initialEntries:['/settings']},children)}};
  const {load} = frontendModules(overrides,{'v5/V5App.tsx':['client']});
  overrides['@/lib/auth-token'] = load('v5/auth-token.ts');
  const workspaceRoot = process.env.V5_WORKSPACE_ROOT ?? path.resolve(import.meta.dirname,'../../..');
  overrides['@workspace-monitoring'] = load(path.join(workspaceRoot,'dashboard/condor-workspace/src/index.ts'));
  const {V5App,client} = load('v5/V5App.tsx');
  client.setDefaultOptions({queries:{retry:false,staleTime:Infinity,gcTime:Infinity}});
  const requests = [], failures = [], warnings = [], firstCommits = [];
  console.error = (...args) => warnings.push(args.map(String).join(' '));
  globalThis.fetch = async (input,init = {}) => {
    assert.equal(init.method ?? 'GET','GET','remount tests must not invoke actions');
    const url = new URL(String(input),'https://fixture.invalid');
    requests.push(url.pathname + url.search);
    let body;
    if (url.pathname === '/api/v5/dashboard/read') {
      const native = url.searchParams.get('path');
      const section = native.includes('native/status') ? 'status' : native.includes('account-balances') || native.includes('fleet/summary') ? 'wallet' : native.includes('holdings') ? 'positions' : native.split('?')[0].split('/').at(-1);
      assert.ok(sections[section],`unmapped owner read: ${native}`);
      body = sections[section];
    } else if (url.pathname === '/api/v5/auth') body = {authenticated:true};
    else if (url.pathname === '/api/v5/dashboard/profile') body = profile;
    else if (url.pathname === '/api/v5/settings') body = settings;
    else assert.fail(`unmapped read: ${url}`);
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const container = document.createElement('div');
  document.body.append(container);
  const mount = createRoot(container);
  class Boundary extends React.Component {
    state = {failed:false};
    componentDidMount() {firstCommits.push(container.textContent);}
    static getDerivedStateFromError() {return {failed:true};}
    componentDidCatch(error,info) {failures.push(`${error.message}${info.componentStack}`);}
    render() {return this.state.failed ? null : this.props.children;}
  }
  client.setQueryData(['v5-auth'],{authenticated:true});
  client.setQueryData(['v5-profile'],profile);
  client.setQueryData(['v5-settings'],settings);
  try {
    await React.act(async () => {mount.render(React.createElement(Boundary,null,React.createElement(V5App)));});
    await React.act(async () => {await client.refetchQueries({type:'active'});});
    await React.act(async () => {await new Promise(resolve => setTimeout(resolve,0));});
    assert.match(container.textContent,/paper owner reads: available/,'first visit must fetch an available owner snapshot');
    assert.match(container.textContent,/snapshot only/);
    assert.ok(requests.some(request => request.includes('native%2Fstatus')),'the retained owner snapshot must come from real fixture transport');
    const health = client.getQueryData(['v5-paper-observation-health',bot]);
    assert.deepEqual(health,['status','wallet','positions','executors','risk'].map(section => sections[section]));
    for (const age of [61000,121000,25000]) {
      await React.act(async () => {mount.render(null);});
      now = sections.status.generated_at_ms + age;
      const before = firstCommits.length;
      await React.act(async () => {mount.render(React.createElement(Boundary,null,React.createElement(V5App)));});
      assert.equal(firstCommits.length,before + 1,'capture each first commit, before passive subscription refresh');
      const first = firstCommits.at(-1);
      assert.match(first,/stale; not current/,'first committed Settings render must not classify a 61-second-old snapshot as fresh');
      assert.match(first,/paper owner reads: stale/);
      assert.doesNotMatch(first,/paper owner reads: available|snapshot only|\b0s old/);
      assert.deepEqual(client.getQueryData(['v5-paper-observation-health',bot]),health,'remount must retain the same owner data');
      assert.deepEqual(failures,[],'real remount must not enter a render loop');
      assert.deepEqual(warnings,[],'remount must not warn about uncached snapshots or cross-component updates');
    }
  } finally {
    await React.act(async () => mount.unmount());
    container.remove();
    client.clear();
    load('lib/candle-store.ts').candleStore.dispose();
    Date.now = originalNow; globalThis.fetch = originalFetch; console.error = originalError;
    await browser.happyDOM.close();
  }
});
