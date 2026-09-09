import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const native = { status:'online', profile:'native', capabilities:{accounts:true,portfolio_read:true,native_status:true} };
const serverRow = {name:'native-owner',host:'127.0.0.1',port:8080,permission:'admin',online:true};
function fixture({ server='native-owner', status=native, discovery={data:[serverRow]}, pathname='/settings' }={}) {
  const buttons=[], refetches=[], selections=[], queries=[];
  const capture = name => (type, props, ...rest) => {
    if(type==='button')buttons.push(props);
    return jsxRuntime[name](type,props,...rest);
  };
  const modules = frontendModules({
    'react/jsx-runtime': {...jsxRuntime,jsx:capture('jsx'),jsxs:capture('jsxs')},
    '@tanstack/react-query': {useQuery(options){
      queries.push(options);
      const result=options.queryKey[0]==='servers'?discovery:{data:status};
      return {isError:false,isPending:false,isLoading:false,isFetching:false,...result,refetch:async()=>{refetches.push(options.queryKey);return result;}};
    }},
    '@/hooks/useServer': {useServer:()=>({server,setServer:value=>selections.push(value)})},
    '@/hooks/useTheme': {useTheme:()=>({theme:'dark',toggleTheme:()=>{}})},
    '@/hooks/useCredentials': {useCredentials:()=>({hasKeys:false,isLoading:false})},
    '@/hooks/useChat': {ChatProvider:({children})=>children},
    '@/hooks/usePrefetchData': {usePrefetchData:()=>{}},
    '@/hooks/useDisplayCurrency': {useDisplayCurrency:()=>({currency:'USDT',setCurrency:()=>{}}),CURRENCY_OPTIONS:['USDT'],CURRENCY_SYMBOLS:{USDT:'$'}},
    '@/lib/api': {api:{getServers:()=>{throw new Error('Network forbidden')},getServerStatus:()=>{throw new Error('Network forbidden')}}},
    '@/components/ConnectKeysOverlay': {ConnectKeysOverlay:()=>null},
    'react-router-dom': {NavLink:({to,children})=>React.createElement('a',{href:to},children),Link:({to,children})=>React.createElement('a',{href:to},children),Outlet:()=>React.createElement('p',null,'Protected route content'),useLocation:()=>({pathname}),useNavigate:()=>()=>{},matchPath:()=>null},
  });
  function render() { return renderToStaticMarkup(React.createElement(modules.load('components/layout/AppShell.tsx').AppShell)); }
  function tools() { return renderToStaticMarkup(React.createElement(modules.load('pages/WorkspaceTools.tsx').WorkspaceTools)); }
  function access() {let result;function Probe(){result=modules.load('hooks/useServerCapabilities.ts').useServerCapabilities();return null;}renderToStaticMarkup(React.createElement(Probe));return result;}
  return { render, tools, access, buttons, refetches, selections, queries };
}

test('failed discovery preserves selected identity, reports failure and hides management navigation/currency', async () => {
  const f=fixture({discovery:{isError:true,error:new Error('Discovery refused'),data:undefined}});
  const html=f.render();
  assert.ok(html.includes('native-owner'));
  assert.ok(!html.includes('No server'));
  for(const route of ['/trade','/executors','/routines'])assert.ok(!html.includes(`href="${route}"`));
  assert.ok(!html.includes('Display currency'));
  assert.ok(html.includes('role="alert"'));
  const retry=f.buttons.find(b=>String(b.children).includes('Retry'));
  assert.ok(retry);
  await retry.onClick();
  assert.ok(f.refetches.some(key=>key[0]==='servers'));
  assert.deepEqual(f.selections,[]);
});

test('no selected server cannot mount trading routes while discovery is unavailable', () => {
  const f=fixture({server:null,status:{status:'unknown'},pathname:'/trade',discovery:{isError:true,error:new Error('Offline')}});
  const html=f.render();
  assert.ok(!html.includes('Protected route content'));
  assert.ok(!html.includes('Display currency'));
});

test('discovery failure invalidates cached native controls and status fetching', () => {
  const f=fixture({status:{...native,capabilities:{...native.capabilities,native_controls_enabled:true,native_stop:true}},discovery:{isError:true,error:new Error('Offline'),data:[serverRow]}});
  const current=f.access();
  assert.equal(current.access.online,false);
  assert.equal(current.access.botStop,false);
  assert.equal(f.queries.find(q=>q.queryKey[0]==='server-capabilities').enabled,false);
});

test('a selected server absent from the discovery result cannot inherit another identity', () => {
  const f=fixture({server:'different-owner',status:native});
  assert.equal(f.access().access.botRead,false);
  const statusQuery=f.queries.find(q=>q.queryKey[0]==='server-capabilities');
  assert.deepEqual(statusQuery.queryKey,['server-capabilities','different-owner']);
  assert.equal(statusQuery.enabled,false);
});

test('successful native discovery retains source units and verified monitoring routes', () => {
  const f=fixture();
  const html=f.render();
  assert.ok(html.includes('native-owner'));
  assert.ok(html.includes('Source units'));
  assert.ok(html.includes('href="/bots"'));
  assert.ok(!html.includes('Display currency'));
  assert.equal(f.access().access.botRead,true);
});

test('Tools with unknown capabilities offers no automation link or native deployment claim', () => {
  const f=fixture({server:null,status:{status:'unknown'},discovery:{isError:true,error:new Error('Offline')}});
  const html=f.tools();
  assert.ok(!html.includes('href="/agents"'));
  assert.ok(!html.includes('This native deployment'));
  assert.ok(html.includes('role="alert"'));
});
