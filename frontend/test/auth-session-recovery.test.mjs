import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules, memoryStorage } from './helpers/frontend-module.mjs';

const user = { id: 1, username: 'operator', first_name: 'Operator', role: 'user' };
function fixture(t, overrides = {}) {
  const cleanups=[];
  const originals = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch, window: globalThis.window };
  globalThis.localStorage = memoryStorage({ condor_token: 'old-token', condor_user: JSON.stringify(user), condor_selected_server: 'native-owner', ...overrides });
  globalThis.sessionStorage = memoryStorage();
  globalThis.window = new EventTarget();
  t.after(() => { cleanups.reverse().forEach(cleanup=>cleanup()); Object.assign(globalThis, originals); });
  const modules = frontendModules();
  const authModule = modules.load('lib/auth.ts');
  const { queryClient } = modules.load('lib/queryClient.ts');
  cleanups.push(() => queryClient.clear());
  function auth() {
    let result;
    function Probe() { result = authModule.useAuthState(); return null; }
    renderToStaticMarkup(React.createElement(Probe));
    return result;
  }
  return { modules, auth, queryClient, onCleanup: cleanup=>cleanups.push(cleanup) };
}

test('malformed cached user recovers signed out and removes cached private data', t => {
  const { auth, queryClient } = fixture(t, { condor_user: '{' });
  queryClient.setQueryData(['private'], { balance: 123 });
  let session;
  assert.doesNotThrow(() => { session = auth(); });
  assert.equal(session.isAuthenticated, false);
  assert.equal(localStorage.getItem('condor_token'), null);
  assert.equal(queryClient.getQueryData(['private']), undefined);
  assert.equal(session.recoveryReason, 'invalid');
});

test('valid JSON with an invalid cached user shape cannot authenticate', t => {
  const { auth } = fixture(t, { condor_user: '{"id":"wrong"}' });
  assert.equal(auth().isAuthenticated, false);
  assert.equal(localStorage.getItem('condor_user'), null);
});

test('protected JSON 401 expires session, selection and cache with a manual recovery reason', async t => {
  const { modules, auth, queryClient } = fixture(t);
  assert.equal(auth().isAuthenticated, true);
  queryClient.setQueryData(['private'], { balance: 123 });
  globalThis.fetch = async () => Response.json({ detail: 'Invalid token' }, { status: 401 });
  await assert.rejects(modules.load('lib/api.ts').api.getServers(), /Invalid token|expired/i);
  assert.equal(localStorage.getItem('condor_token'), null);
  assert.equal(localStorage.getItem('condor_selected_server'), null);
  assert.equal(queryClient.getQueryData(['private']), undefined);
  assert.equal(auth().isAuthenticated, false);
  assert.equal(auth().recoveryReason, 'expired');
});

test('authenticated blob/monitor requests use the same protected 401 recovery', async t => {
  const { modules, auth } = fixture(t);
  auth();
  globalThis.fetch = async () => new Response(null, { status: 401 });
  await modules.load('lib/auth-token.ts').authFetch('/api/v1/trading-visuals/export/orders.csv');
  assert.equal(auth().isAuthenticated, false);
  assert.equal(localStorage.getItem('condor_token'), null);
});

test('old in-flight 401 cannot log out a newly accepted session', async t => {
  const { modules, auth, queryClient } = fixture(t);
  const session = auth();
  let finishOld;
  globalThis.fetch = async url => url === '/api/v1/auth/tailscale'
    ? Response.json({ token: 'new-token', user: { ...user, id: 2 } })
    : new Promise(resolve => { finishOld = resolve; });
  const pending = modules.load('lib/auth-token.ts').authFetch('/api/v1/servers');
  assert.equal(await session.loginWithTailscale(), true);
  queryClient.setQueryData(['new-private'], { balance: 456 });
  finishOld(new Response(null, { status: 401 }));
  await pending;
  assert.equal(localStorage.getItem('condor_token'), 'new-token');
  assert.equal(auth().user.id, 2);
  assert.deepEqual(queryClient.getQueryData(['new-private']), { balance: 456 });
});

test('logout invalidates an in-flight login response instead of signing the user back in', async t => {
  const { auth } = fixture(t);
  let finishLogin;
  globalThis.fetch = () => new Promise(resolve => { finishLogin = resolve; });
  const session = auth();
  const pending = session.loginWithTailscale();
  session.logout();
  finishLogin(Response.json({ token: 'late-token', user }));
  assert.equal(await pending, false);
  assert.equal(auth().isAuthenticated, false);
  assert.equal(localStorage.getItem('condor_token'), null);
});

test('malformed or duplicate discovery identities are rejected before capabilities can use them', async t => {
  const { modules, auth } = fixture(t);
  auth();
  const api = modules.load('lib/api.ts').api;
  for (const value of [{servers:[]}, [{name:'native-owner',online:'true'}], [{name:'same',online:true},{name:'same',online:false}]]) {
    globalThis.fetch = async () => Response.json(value);
    await assert.rejects(api.getServers(), /invalid|duplicate/i);
  }
});

test('external storage changes cannot send a new identity token under the current user', async t => {
  const { modules, auth, queryClient, onCleanup } = fixture(t);
  assert.equal(auth().user.id,1);
  const sessionStore=modules.load('lib/auth-session.ts');
  const unsubscribe=sessionStore.subscribeSession(()=>{});
  onCleanup(unsubscribe);
  queryClient.setQueryData(['private'],{balance:123});
  localStorage.setItem('condor_token','other-tab-token');
  localStorage.setItem('condor_user',JSON.stringify({...user,id:2}));
  let sent;
  globalThis.fetch=async (_url,init)=>{sent=new Headers(init.headers).get('Authorization');return Response.json({});};
  await modules.load('lib/auth-token.ts').authFetch('/api/v1/servers');
  assert.notEqual(sent,'Bearer other-tab-token');
  const event=new Event('storage');
  Object.defineProperties(event,{key:{value:'condor_token'},storageArea:{value:localStorage}});
  window.dispatchEvent(event);
  assert.equal(auth().isAuthenticated,false);
  assert.equal(queryClient.getQueryData(['private']),undefined);
  assert.equal(localStorage.getItem('condor_token'),'other-tab-token');
  assert.equal(modules.load('lib/auth-token.ts').getToken(),null);
});

test('a storage change before subscription is reconciled without removing the newer session', t => {
  const { modules, auth, queryClient, onCleanup }=fixture(t);
  auth();
  queryClient.setQueryData(['private'],{balance:123});
  localStorage.setItem('condor_token','other-tab-token');
  const unsubscribe=modules.load('lib/auth-session.ts').subscribeSession(()=>{});
  onCleanup(unsubscribe);
  assert.equal(auth().isAuthenticated,false);
  assert.equal(queryClient.getQueryData(['private']),undefined);
  assert.equal(localStorage.getItem('condor_token'),'other-tab-token');
});

test('old 401 before the storage event cannot delete another tab session', async t => {
  const { modules, auth }=fixture(t);
  auth();
  let finish;
  globalThis.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const pending=modules.load('lib/auth-token.ts').authFetch('/api/v1/servers');
  localStorage.setItem('condor_token','other-tab-token');
  localStorage.setItem('condor_user',JSON.stringify({...user,id:2}));
  finish(new Response(null,{status:401}));
  await pending;
  assert.equal(localStorage.getItem('condor_token'),'other-tab-token');
  assert.equal(auth().isAuthenticated,false);
});

test('partial session persistence cannot leave a new token paired with the old cached user', async t => {
  const { auth }=fixture(t);
  const session=auth();
  const save=localStorage.setItem;
  localStorage.setItem=(key,value)=>{if(key==='condor_user')throw new Error('Quota exceeded');save(key,value);};
  globalThis.fetch=async()=>Response.json({token:'partially-saved-token',user:{...user,id:2}});
  await assert.rejects(session.loginWithTailscale(),/browser storage/i);
  assert.equal(auth().isAuthenticated,false);
  assert.equal(localStorage.getItem('condor_token'),null);
  assert.equal(localStorage.getItem('condor_user'),null);
});

test('a delayed storage event cannot expire a newer accepted session matching current storage', async t => {
  const { modules, auth, queryClient, onCleanup }=fixture(t);
  const session=auth();
  onCleanup(modules.load('lib/auth-session.ts').subscribeSession(()=>{}));
  localStorage.setItem('condor_token','earlier-other-tab-token');
  globalThis.fetch=async()=>Response.json({token:'latest-token',user:{...user,id:3}});
  assert.equal(await session.loginWithTailscale(),true);
  queryClient.setQueryData(['new-private'],{balance:789});
  const event=new Event('storage');
  Object.defineProperties(event,{key:{value:'condor_token'},storageArea:{value:localStorage},newValue:{value:'earlier-other-tab-token'}});
  window.dispatchEvent(event);
  assert.equal(auth().user?.id,3);
  assert.equal(auth().isAuthenticated,true);
  assert.deepEqual(queryClient.getQueryData(['new-private']),{balance:789});
});

test('successful data from an older session is discarded after a new login', async t => {
  const { modules, auth }=fixture(t);
  const session=auth();
  let finish;
  globalThis.fetch=url=>url==='/api/v1/auth/tailscale'
    ? Promise.resolve(Response.json({token:'new-token',user:{...user,id:2}}))
    : new Promise(resolve=>{finish=resolve;});
  const pending=modules.load('lib/auth-token.ts').authFetch('/api/v1/servers');
  await session.loginWithTailscale();
  finish(Response.json({privateData:'old-session'}));
  await assert.rejects(pending,/Session changed/);
});
