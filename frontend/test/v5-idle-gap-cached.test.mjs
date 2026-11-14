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
  ['/backtests','Tradepad'], ['/','Market'],
  ['/agents','Agents'],
  ['/agents/decision_reviewer','Decision Reviewer'], ['/research','Research'],
  ['/learning','Learning'], ['/research-factory','Research factory'],
  ['/decision-lineage','Decision lineage'], ['/sessions','Sessions'],
  ['/sessions/fixture-session','Session'],
];


test('review probe: first commit after a zero-subscriber gap', async () => {
  let route = '/settings';
  let now = sections.status.generated_at_ms;
  const originalNow = Date.now;
  Date.now = () => now;
  const overrides = {'lightweight-charts':await import('lightweight-charts'),'react-router-dom':{...Router,BrowserRouter:({children}) => React.createElement(Router.MemoryRouter,{initialEntries:[route]},children)}};
  const {load} = frontendModules(overrides,{'v5/V5App.tsx':['client']},(filename,source) => {
    if (!filename.endsWith('/v5/V5Pages.tsx')) return source;
    const anchor = 'const snapshotLabel = identity.snapshot?.label;';
    assert.equal(source.split(anchor).length - 1,1);
    return source.replace(anchor,`${anchor} require("react").useLayoutEffect(() => { globalThis.__commits?.push({label:snapshotLabel, reads:identity.summary.label, wall:Date.now()}); });`);
  });
  overrides['@/lib/auth-token'] = load('v5/auth-token.ts');
  const workspaceRoot = process.env.V5_WORKSPACE_ROOT ?? path.resolve(import.meta.dirname,'../../..');
  overrides['@workspace-monitoring'] = load(path.join(workspaceRoot,'dashboard/condor-workspace/src/index.ts'));
  const {V5App,client} = load('v5/V5App.tsx');
  client.setDefaultOptions({queries:{retry:false,refetchOnWindowFocus:false,staleTime:Infinity}});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input),'https://fixture.invalid');
    let body;
    if (url.pathname === '/api/v5/dashboard/read') {
      const native = url.searchParams.get('path');
      const section = native.includes('native/status') ? 'status' : native.includes('account-balances') || native.includes('fleet/summary') ? 'wallet' : native.includes('holdings') ? 'positions' : native.includes('performance/history') ? 'history' : native.split('?')[0].split('/').at(-1);
      body = sections[section];
    } else if (url.pathname === '/api/v5/auth') body = {authenticated:true};
    else if (url.pathname === '/api/v5/dashboard/profile') body = profile;
    else if (url.pathname === '/api/v5/settings') body = settings;
    else if (url.pathname === '/api/v5/workspace') body = workspace;
    else if (url.pathname === '/api/v5/sessions') body = {sessions:[]};
    else throw new Error(`unmapped read: ${url}`);
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const container = document.createElement('div');
  document.body.append(container);
  const mount = createRoot(container);
  try {
    client.setQueryData(['v5-auth'],{authenticated:true});
    client.setQueryData(['v5-profile'],profile);
    client.setQueryData(['v5-settings'],settings);
    client.setQueryData(['v5-paper-observation-health',bot],['status','wallet','positions','executors','risk'].map(section => sections[section]));
    await React.act(async () => {mount.render(React.createElement(V5App));});
    await React.act(async () => {await new Promise(resolve => setTimeout(resolve,0));});
    console.log('ON SETTINGS:', container.textContent.match(/Last coherent owner snapshot · [^·]+· [a-z ;]+/)?.[0]);
    const agents = [...container.querySelectorAll('a')].find(a => a.getAttribute('href') === '/agents');
    await React.act(async () => {agents.dispatchEvent(new browser.MouseEvent('click',{bubbles:true,cancelable:true,button:0}));});
    await React.act(async () => {await new Promise(resolve => setTimeout(resolve,0));});
    console.log('ON AGENTS, identity mounted:', container.textContent.includes('Paper owner identity'));
    now += 40_000;
    globalThis.__commits = [];
    const settingsLink = container.querySelector('a[aria-label="V5 settings"]');
    await React.act(async () => {settingsLink.dispatchEvent(new browser.MouseEvent('click',{bubbles:true,cancelable:true,button:0}));});
    await React.act(async () => {await new Promise(resolve => setTimeout(resolve,0));});
    console.log('COMMITS AFTER RETURN:', JSON.stringify(globalThis.__commits.map(c => ({...c, wallMinusGenerated:c.wall - sections.status.generated_at_ms}))));
    console.log('FINAL:', container.textContent.match(/Last coherent owner snapshot · [^·]+· [a-z ;]+/)?.[0]);
    assert.ok(!globalThis.__commits.some(c => c.label && !/stale/.test(c.label)),'a 40 s old snapshot must never commit as non-stale');
  } finally {
    await React.act(async () => mount.unmount());
    container.remove(); client.clear();
    load('lib/candle-store.ts').candleStore.dispose();
    globalThis.fetch = originalFetch; Date.now = originalNow; delete globalThis.__commits;
    await browser.happyDOM.close();
  }
});
