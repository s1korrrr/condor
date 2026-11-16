import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import React from 'react';
import * as Router from 'react-router-dom';
import {Window} from 'happy-dom';
import {clockMutation} from './helpers/paper-clock-mutants.mjs';

const browser = new Window({url:'https://fixture.invalid/'});
const phoneSheet = new browser.CSSStyleSheet();
phoneSheet.replaceSync(fs.readFileSync(new URL('../src/v5/phone.css',import.meta.url),'utf8'));
const phoneTitleSelectors = rules => [...rules].flatMap(rule => [
  ...(rule.style?.content === 'attr(title)' && rule.selectorText.endsWith('::after') ? [rule.selectorText.replace(/::after$/,'')] : []),
  ...phoneTitleSelectors(rule.cssRules ?? []),
]);
const phoneTitleSelector = phoneTitleSelectors(phoneSheet.cssRules).join(', ');
for (const name of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','localStorage']) {
  Object.defineProperty(globalThis,name,{value:name === 'window' ? browser : browser[name],configurable:true});
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
const {frontendModules} = await import('./helpers/frontend-module.mjs');
const {createRoot} = await import('react-dom/client');
const baselineFiles = new Set(['components/charts/RecordedCandleChart.tsx','features/quant-ops/kit/Rows.tsx','pages/tabs/ActiveBotsTab.tsx','v5/format.mjs','v5/policy.ts','v5/V5Stocks.tsx','v5/bots-position-model.mjs','v5/V5CandleStore.tsx','v5/CandleStorePanels.tsx','v5/candle-store-model.ts','v5/V5Helm.tsx','v5/V5MarketDetail.tsx','v5/V5Pages.tsx','v5/OwnerJournalCondition.tsx']);
const baselineSource = (filename, source) => {
  if (!process.env.DISPLAY_SCAN_BASELINE) return source;
  const relative = path.relative(path.resolve(import.meta.dirname,'../src'), filename);
  const revision = process.env.DISPLAY_SCAN_BASELINE === 'e16cf5b9' ? 'e16cf5b9' : '87c660c8';
  return baselineFiles.has(relative) ? execFileSync('git',['show',`${revision}:frontend/src/${relative}`],{cwd:path.resolve(import.meta.dirname,'../..'),encoding:'utf8'}) : source;
};
const fixture = relative => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/${relative}`,import.meta.url)));
const poisonDecimals = value => {
  if (Array.isArray(value)) return value.map(poisonDecimals);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, poisonDecimals(item)]));
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.slice(0, 26).padEnd(8, '0')}7317`;
  }
  return value;
};
const baseline = fixture('v5_unbound_base_8284ffe7.json');
const sections = Object.fromEntries(['status','wallet','positions','executors','risk','fills','decisions','history','accounting','operations'].map(section => [section,fixture(`paper-api-final3/native-replay/${section}.json`)]));
for (const section of Object.values(sections)) section.data = poisonDecimals(section.data);
sections.fills.next_cursor = null;
Object.values(sections.risk.data.controllers)[0].native.configured_limits.pair_quote = '99.780079327317';
sections.status.state = 'available';
sections.status.reason = null;
const bot = sections.status.bot_id;
const fixtureMinute = Math.floor(sections.status.read_at_ms / 60_000) * 60 - 60;
const fixtureClose = 101.123456789;
const fixtureFill = sections.fills.data.find(row => row.trading_pair === 'BNB-USDC' && row.side === 'BUY');
fixtureFill.event_at_ms = fixtureMinute * 1000;
const laneFixture = {lane:'binance__spot',venue:'binance',segment:'spot',pair:'BTC-USDT',health:'green',health_rules:[{level:'info',rule:'fixture',detail:'owner evidence'}],volume_unit:'base',last_minute:1793403200,last_minute_age_s:1,coverage_1h:0.876543217317,coverage_24h:0.876543217317,coverage_7d:0.876543217317,gaps_7d:1,pending:0,unrecoverable_7d:0,no_trade_7d:0,ws_state:'connected',grace_s:30,pairs_listed:1,pairs_held:1,available:true,unavailable_reason:null,partition_errors:[]};
const identity = {name:'RSI V5',host:'razer',mode:'reports-only',execution_enabled:false,baseline_binding:null};
const settings = {...baseline.settings,identity,budget:{enabled:false}};
const profile = {...baseline.profile.body,readiness:{...baseline.profile.body.readiness,paper_owner:{bot_name:bot,state:'FRESH',generated_at:sections.status.generated_at_ms / 1000,reason:'fixture',mode:'PAPER'}}};
sections.history.data.terminal_executors.data = {delivery:'publication_pages',records:[{executor_id:'terminal-fixture',trading_pair:'BNB-USDC',controller_id:'v5-bnb',close_type:'completed',close_at_ms:sections.status.generated_at_ms - 1000}],publication_record_count:1};
const workspace = {schema_version:'v5-workspace.v1',identity,context:null,advisor:settings.budget,agents:Object.values(baseline.workspace_agents),sessions:[],source_error:null};
const agentFixture = {...baseline['agent:decision_reviewer'].body,tools:['fixture_reader'],policy:{...baseline['agent:decision_reviewer'].body.policy,allowed_tools:['fixture_reader']},notes:'Fixture operator notes'};
const sessionFixture = {...baseline['inspect:decision_reviewer'],id:'fixture-session',agent_id:'decision_reviewer',loop_id:null,started_at_ms:sections.status.read_at_ms,finished_at_ms:sections.status.read_at_ms,effect:'NONE',journal:'Fixture journal text',ticks:baseline['inspect:decision_reviewer'].ticks.map((tick,index) => ({...tick,id:`tick-${index}`,at_ms:sections.status.read_at_ms,evidence_refs:[],report:'Fixture report output'}))};
const routes = [
  ['/settings','Workspace settings'], ['/bots','Paper bots'], ['/helm','Helm paper bot'], ['/money','Money'], ['/capital','Capital'],
  ['/operations','Operations'], ['/v5/readiness','Paper readiness'], ['/system','Operations'], ['/system/checks','Operations'],
  ['/system/data-feeds','Venues and data health'], ['/system/engine-inputs','V5 market features'], ['/system/readiness','Paper readiness'], ['/system/settings','Workspace settings'],
  ['/backtests','Tradepad'], ['/','Overview'], ['/market','Market'], ['/market/BTC','Market'], ['/market/evidence','Market'], ['/market/candles','Market'],
  ['/market/stocks','OKX stocks'], ['/agents','Agents'],
  ['/agents/decision_reviewer','Decision Reviewer'], ['/research','Research'],
  ['/learning','Learning'], ['/research-factory','Research factory'],
  ['/decision-lineage','Decision lineage'], ['/sessions','Sessions'],
  ['/sessions/fixture-session','Session'],
];

function longVisibleDecimals(container) {
  const findings = [];
  const scan = (value, label, parent, boundaries = null) => {
    for (const match of value.matchAll(/(?<![\w.])[-−+]?\d+\.\d+(?:[eE][−+-]?\d+)?/g)) {
      if (boundaries && !boundaries.some(boundary => match.index < boundary && match.index + match[0].length > boundary)) continue;
      const number = match[0], [mantissa, exponent] = number.split(/[eE]/);
      const fraction = mantissa.split('.')[1];
      const dustLine = parent.closest('.paper-positions dd > div');
      const dust = !exponent && parent.matches('.paper-positions dd > div > span[title]') && dustLine?.textContent.trim().endsWith('dust') && /^[-−+]?0\.0{4}/.test(number) && fraction.replace(/^0+/, '').length <= 3;
      if (!dust && (fraction.length > 8 || fraction.includes('7317') || fraction.length === 8 && (/^0+$/.test(fraction) || fraction.replace(/^0+/, '').length > 3) || (exponent && fraction.length + 1 > 3))) findings.push(`${label}: ${number}`);
    }
  };
  const walker = document.createTreeWalker(container, browser.NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode, parent = node.parentElement;
    if (!parent || parent.closest('script, style')) continue;
    scan(node.textContent, parent.tagName.toLowerCase(), parent);
  }
  for (const block of container.querySelectorAll('p, dd, dt, td, th, li, summary')) {
    const textNodes = document.createTreeWalker(block, browser.NodeFilter.SHOW_TEXT);
    let combined = '', boundaries = [];
    while (textNodes.nextNode()) { if (combined) boundaries.push(combined.length); combined += textNodes.currentNode.textContent; }
    scan(combined, `${block.tagName.toLowerCase()}[split]`, block, boundaries);
  }
  for (const element of container.querySelectorAll('[aria-label]')) scan(element.getAttribute('aria-label'), `${element.tagName.toLowerCase()}[aria-label]`, element);
  if (phoneTitleSelector) for (const element of container.querySelectorAll(phoneTitleSelector)) scan(element.title, `${element.tagName.toLowerCase()}[phone ::after]`, element);
  return findings;
}

test('decimal scan checks phone CSS title helpers but not exact leaf tooltips', () => {
  const fixture = document.createElement('div');
  fixture.className = 'condor-native';
  fixture.innerHTML = '<div class="v5m-stat" title="13.71580913935440000000000000"><strong>13.72</strong></div><div class="v5m-stat"><strong><span title="13.71580913935440000000000000">13.72</span></strong></div>';
  assert.deepEqual(longVisibleDecimals(fixture), ['div[phone ::after]: 13.71580913935440000000000000']);
});

test('decimal scan excludes exact titles and only allows three-significant-digit position dust', () => {
  const fixture = document.createElement('div');
  fixture.innerHTML = '<span title="1.123456789">1.12</span><span>2.123456789</span><span>8.7317</span><span>1.234567890123e-20</span><span>0.00000000 BTC</span><span>99.78007932 USDC</span><p><span>198961.1707</span><span>7127617</span></p><div class="paper-positions"><dd><div>+ <span title="0.0000000000123">0.0000000000123 BTC</span> dust</div><div>+ <span title="0.00000000001234">0.00000000001234 BTC</span> dust</div><div>+ <span title="1.000000000">1.000000000 BTC</span> dust</div><div>+ <span title="99.000000000">99.000000000 BTC</span> dust</div></dd></div>';
  assert.deepEqual(longVisibleDecimals(fixture), ['span: 2.123456789', 'span: 8.7317', 'span: 1.234567890123e-20', 'span: 0.00000000', 'span: 99.78007932', 'span: 0.00000000001234', 'span: 1.000000000', 'span: 99.000000000', 'p[split]: 198961.17077127617']);
});

test('decimal scan covers a complete native-risk snapshot', async () => {
  const {renderToStaticMarkup} = await import('react-dom/server');
  const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}]));
  const {PaperWorkspace} = frontendModules(stubs,{},baselineSource).load('pages/tabs/ActiveBotsTab.tsx');
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads:Object.values(sections),accountingRead:sections.accounting,now:sections.status.generated_at_ms,reportAt:sections.status.generated_at_ms,heartbeat:'Fresh',bot}));
  assert.match(container.textContent,/Pair cap 99\.78 USDC/);
  assert.deepEqual(longVisibleDecimals(container),[]);
});

test('real V5 routes settle with shared providers and an advancing paper clock', async context => {
  const routeSource = fs.readFileSync(new URL('../src/v5/V5App.tsx',import.meta.url),'utf8');
  const registered = [...routeSource.matchAll(/<Route path="([^"]+)"/g)].map(match => match[1]).filter(pathname => pathname !== '*').map(pathname => pathname.replace('/system/:tab','/system/checks').replace('/market/:coin','/market/BTC').replace('/agents/:id','/agents/decision_reviewer').replace('/sessions/:id','/sessions/fixture-session'));
  assert.deepEqual([...new Set(routes.map(([pathname]) => pathname.replace(/^\/system\/(data-feeds|engine-inputs|readiness|settings)$/, '/system/checks')))].sort(),registered.sort(),'every registered V5 route needs a real render case');
  let route = '/settings';
  const profileForRoute = () => route.startsWith('/market') && route !== '/market/stocks' ? {...profile,candle_store:{configured:true}} : profile;
  const journalRoutes = new Set(['/bots', '/operations', '/v5/readiness']);
  const statusForRoute = () => journalRoutes.has(route) ? {...sections.status, state:'degraded', reason:'OWNER_JOURNAL_EXCEEDED', data:{...sections.status.data, journal_budget:{state:'exceeded',journal_evidence_held:true,native_execution_continues:true}}} : sections.status;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalError = console.error;
  let now = sections.status.read_at_ms;
  Date.now = () => ++now;
  const charts = [];
  const overrides = {'lightweight-charts':{CandlestickSeries:{},ColorType:{Solid:'solid'},LineStyle:{Dashed:2},createChart:() => {
    const capture = {data:[],markers:[],move:null}; charts.push(capture);
    return {addSeries:() => ({capture,setData(data){capture.data = data;},createPriceLine(){}}),subscribeCrosshairMove(callback){capture.move = callback;},timeScale:() => ({fitContent(){}}),remove(){}};
  },createSeriesMarkers(series,markers){series.capture.markers = markers;}},'react-router-dom':{...Router,BrowserRouter:({children}) => React.createElement(Router.MemoryRouter,{initialEntries:[route]},children)}};
  const {load} = frontendModules(overrides,{'v5/V5App.tsx':['client']},(filename,source) => {
    source = clockMutation(filename,baselineSource(filename,source));
    if (!filename.endsWith('/v5/V5Pages.tsx')) return source;
    const anchor = 'function PaperIdentity({ paused = false }: { paused?: boolean }) {';
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
  const decimalFindings = [];
  const scan = (container, label) => {
    const display = container.cloneNode(true);
    for (const details of display.querySelectorAll('details')) {
      if (details.querySelector(':scope > summary')?.textContent === 'Exact record · as sent') details.querySelector(':scope > pre').textContent = '';
    }
    decimalFindings.push(...longVisibleDecimals(display).map(finding => `${label}: ${finding}`));
  };
  const openDisclosures = async container => {
    while (container.querySelector('details:not([open])')) {
      await React.act(async () => {
        for (const details of container.querySelectorAll('details:not([open])')) { details.open = true; details.dispatchEvent(new browser.Event('toggle')); }
        await new Promise(resolve => setTimeout(resolve,0));
      });
    }
  };
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
    else if (url.pathname === '/api/v5/dashboard/profile') body = profileForRoute();
    else if (url.pathname === '/api/v5/settings') body = settings;
    else if (url.pathname === '/api/v5/workspace') body = workspace;
    else if (url.pathname === '/api/v5/sessions') body = {sessions:[sessionFixture]};
    else if (url.pathname === '/api/v5/sessions/fixture-session') body = sessionFixture;
    else if (url.pathname === '/api/v5/agents/decision_reviewer') body = agentFixture;
    else if (url.pathname === '/api/v5/candle-store/symbols') body = {state:'AVAILABLE',reason:null,data:{rows:[{lane:'okx__spot',pair:'BNB-USDC'}]}};
    else if (url.pathname === '/api/v5/candle-store/candles') {
      const end = Math.floor(sections.status.read_at_ms / 60_000) * 60 - 60;
      body = {state:'AVAILABLE',reason:null,data:{pair:url.searchParams.get('pair') ?? 'BNB-USDC',venue:'binance',volume_unit:'base',start:end-60,end,now:end+65,buckets:[[end-60,100,101,99,100,2,1],[end,101,102,100,fixtureClose,2,1]],totals:{}}};
    }
    else if (url.pathname === '/api/v5/candle-store/summary') body = {state:'AVAILABLE',reason:null,data:{now:Math.floor(sections.status.read_at_ms/1000),status_age_s:1,tiles:[laneFixture],rows:[laneFixture]}};
    else if (url.pathname === '/api/v5/candle-store/cross') body = {state:'AVAILABLE',reason:null,data:{now:1793403300,asset:'BTC',segment:'spot',range:'24h',res:'1h',res_s:3600,start:1793401200,end:1793401200,minutes:1,minutes_with_median:1,venues_per_minute_max:2,note:'fixture',table:[{lane:'binance__spot',venue:'binance',pair:'BTC-USDT',quote:'USDT',n:1,minutes_with_close:1,mean_bps:0.123456787317,mean_abs_bps:0.123456787317,p95_abs_bps:0.123456787317,max_abs_bps:0.123456787317,max_at:1793401200}],series:[{lane:'binance__spot',venue:'binance',pair:'BTC-USDT',close:[[1793401200,101.123456787317]],deviation_bps:[[1793401200,0.123456787317]]}]}};
    else if (['/api/v5/candle-store/stocks','/api/v5/candle-store/stock-market','/api/v5/candle-store/stock-candles'].includes(url.pathname)) {
      const seconds = Math.floor(now/1000), identity = {region:'eea',instId:'EXAMPLE-USDT-SWAP',instType:'SWAP'};
      const ticker = {...identity,dataset:'ticker',event_time_ms:now-1000,received_at_ms:now,source:'ws',data:{last:'123.456789017317',bidPx:'122.123456787317',askPx:'124.123456787317',vol24h:'456.123456787317',volCcy24h:'500.123456787317'}};
      const channel = {state:'live',age_s:0,event_time_ms:now-1000,received_at_ms:now,reason:null};
      const coverage = {capture_started_at:seconds-3600,candle_start:null,candle_end:null,historical_trades:false,historical_books:false};
      const instrument = {instId:identity.instId,instType:'SWAP',instCategory:'3',state:'live',quoteCcy:'USDT',settleCcy:'USDT',ruleType:'normal',ctVal:'1.123456787317',ctMult:'2.123456787317',tickSz:'0.010000007317',lotSz:'0.000001007317',minSz:'0.000001007317'};
      const observation = (dataset,data) => ({...ticker,dataset,data});
      const latest = {ticker,mark_price:observation('mark_price',{markPx:'101.123456787317'}),index_price:observation('index_price',{idxPx:'102.123456787317'}),funding:observation('funding',{fundingRate:'0.012345677317'}),open_interest:observation('open_interest',{oi:'103.123456787317'}),books:observation('books',{bids:[['104.123456787317','1.234567897317','0','2']],asks:[]})};
      const channels = Object.fromEntries(['ticker','mark_price','index_price','funding','open_interest','books','trades'].map(name => [name,channel]));
      const catalog = {...identity,format:'okx-stocks-v1',now:seconds,state:'live',catalog_at:seconds,updated_at:seconds,reason:null,rows:[{instrument,latest,channels,coverage,captured:true}],capture:[{instType:'SWAP',instId:identity.instId,listed:true}]};
      const trades = [observation('trades',{tradeId:'fixture-trade',px:'105.123456787317',sz:'2.123456787317',side:'buy'})];
      const data = url.pathname.endsWith('/stocks') ? catalog : url.pathname.endsWith('/stock-market') ? {...catalog,format:'okx-stock-market-v1',latest,channels,coverage,recent_trades:trades,book_depth:{bids:1,asks:0},captured:true} : {...identity,range:'24h',now:seconds,state:'live',captured:true,buckets:[[fixtureMinute,101,102,99,fixtureClose,2,1,0,0,0,0,0]],totals:{final:1},volume_unit:'contracts'};
      body = {state:'AVAILABLE',reason:null,data};
    }
    else if (url.pathname === '/api/v5/candle-store/heatmap') body = {state:'AVAILABLE',reason:null,data:{now:1793403300,segment:'spot',hours:[1793401200],fields:['final','no_trade','unrecoverable','missing','pending'],last_closed:1793403200,rows:[{lane:'binance__spot',venue:'binance',segment:'spot',pair:'BTC-USDT',asset:'BTC',first_minute:1793401200,cells:[[59,0,0,1,0]]}]}};
    else if (url.pathname === '/api/v5/candle-store/store') body = {state:'AVAILABLE',reason:null,data:{now:1793403300,status:{present:true,error:null,age_s:1,started_at:1793403200,uptime_s:100,fatal_error:null,process:{rss_mib:10,max_rss_mib:10,cpu_user_s:1,cpu_sys_s:1,loop_lag_s:{p50:0,p99:0,max:0,max_recent:0}},fault_injections:0},retention:{window_s:604800,margin_s:0,window_days:7,keep_days:7},versions:{found:{},expected:{},mismatches:[]},config:{source:'fixture',error:null,assets:['BTC']},bytes_total:1,lanes:[{lane:'binance__spot',venue:'binance',segment:'spot',bytes:{lanes:1,sealed:0,metrics:0},bytes_total:1,wal_bytes:0,days:[],days_held:0,sealed_days:[],metrics_files:0}],read_method:'fixture'}};
    else if (url.pathname === '/api/v5/money') body = {sampler:true,daily:[{day:1793923200000,samples:2,gaps:1,valid:1,equity_start:'199318.98',equity_end:'199318.98',equity_change:'0',realized_change:'0',first_at_ms:1793929000000,last_at_ms:1793929000000}],recorder_errors:{count:0,last:null,at_ms:null},started_at_ms:1793929000000,now_ms:1793929900000,range:'7d',rows:[{bot:'v5',at_ms:1793929000000,unit:'USDC',equity:'199318.98',initial_funding:'200000',realized:'114.13',unrealized:'-795.15',fees:'23.11',coins:{BNB:{realized:'14.8',unrealized:null}}},{bot:'v5',at_ms:1793929600000,gap:'wallet: stale'},{bot:'helm',at_ms:1793929600000,gap:'HELM_STATUS_MISSING'}]};
    else if (url.pathname === '/api/v5/helm') body = {state:'STALE',reason:'HELM_STATUS_STALE',bot:'helm_v5_paper',status:{generated_at:1793929882.6,age_s:600000,ready:false,failure:null,failure_reported:true,reasons:null,steps:5086,actions:0,phase:'P1',profile_id:null,entries_held:'operator_entry_pause',operator_entry_paused:true,kill_switch:null,adaptive_actions:'off',funding:'finite_wallet',image_tag:null,shutdown:{checkpoint:true,clean:null},mandate:{mandate_id:'helm-v5-paper-20261105',state:'active',valid_until_ms:1e18},risk:null,control_rejections:null,symbols:[{pair:'BNB-USDC',status:null,candidate_hold:'low_volatility',bag:null,last_decision:{at:-1e21,reason:null}}],withheld:2}};
    else if (url.pathname.startsWith('/api/v5/learning/')) body = {effect:'NONE',status:'DISABLED',roles:[],reason:'Stage1 disabled'};
    else {unexpectedReads.push(url.pathname + url.search); throw new Error(`unmapped read: ${url}`);}
    if (url.pathname === '/api/v5/money') body = poisonDecimals(body);
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try {
    for (const [pathname,heading] of routes) await context.test(pathname,async () => {
      route = pathname;
      const chartStart = charts.length;
      if (pathname === '/bots') now = sections.status.generated_at_ms + 1000;
      const requestStart = requests.length;
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
      if (pathname === '/bots') context.mock.timers.enable({apis:['setInterval']});
      client.setQueryData(['v5-auth'],{authenticated:true});
      client.setQueryData(['v5-profile'],profileForRoute());
      client.setQueryData(['v5-settings'],settings);
      client.setQueryData(['v5-paper-observation-health',bot],['status','wallet','positions','executors','risk'].map(section => section === 'status' ? statusForRoute() : sections[section]));
      if (pathname === '/bots') client.setQueryData(['v5-paper-bots',bot],['status','wallet','positions','fills','executors','risk','decisions','history','accounting'].map(section => section === 'status' ? statusForRoute() : sections[section]));
      try {
        await React.act(async () => {mount.render(React.createElement(Boundary,null,React.createElement(V5App)));});
        assert.equal(requests.slice(requestStart).filter(request => request === '/api/v5/candle-store/symbols').length, pathname === '/bots' ? 1 : 0, 'only Bots reads symbols once on initial mount with a complete snapshot');
        await React.act(async () => {await client.refetchQueries({type:'active'});});
        await React.act(async () => {await new Promise(resolve => setTimeout(resolve,0));});
        if (pathname === '/bots') {
          assert.match(container.textContent,/terminal-fixture/,'terminal history must render a published record');
          assert.ok(charts.slice(chartStart).some(chart => chart.markers.some(marker => marker.text === 'BUY 0.00617 @ 748.17')), 'the chart must receive the formatted buy marker');
          const markerText = document.createElement('div');
          markerText.textContent = charts.slice(chartStart).flatMap(chart => chart.markers.map(marker => marker.text)).join(' · ');
          assert.deepEqual(longVisibleDecimals(markerText), [], 'chart markers must not expose raw decimal tails');
          assert.equal(requests.slice(requestStart).filter(request => request === '/api/v5/candle-store/symbols').length, 1, 'explicit refresh must not reload the symbols list');
          const candlesBefore = requests.slice(requestStart).filter(request => request.startsWith('/api/v5/candle-store/candles?')).length;
          assert.ok(candlesBefore > 0, 'listed BNB must load candles before the interval');
          now += 60_001;
          await React.act(async () => {context.mock.timers.tick(60_001); await new Promise(resolve => setTimeout(resolve,0));});
          assert.ok(requests.slice(requestStart).filter(request => request.startsWith('/api/v5/candle-store/candles?')).length > candlesBefore, 'candles must poll after an elapsed interval');
          assert.equal(requests.slice(requestStart).filter(request => request === '/api/v5/candle-store/symbols').length, 1, 'symbols stay loaded after an elapsed interval');
          const symbols = client.getQueryCache().find({queryKey:['v5-bots-candle-symbols']});
          assert.equal(symbols.options.refetchInterval, undefined, 'symbols must not schedule an interval');
          now -= 60_001;
        }
        if (pathname !== '/bots') assert.equal(requests.slice(requestStart).filter(request => request === '/api/v5/candle-store/symbols').length, 0, 'other routes never read Bots symbols');
        assert.deepEqual(failures,[],'real route must not enter a render loop');
        assert.deepEqual(warnings,[],'React must not warn about unstable snapshots or cross-component updates');
        assert.ok(container.querySelector('main'),`${pathname} must keep the app mounted`);
        assert.ok(container.textContent.includes(heading),`${pathname} must render ${heading}: ${container.textContent}`);
        await openDisclosures(container);
        if (pathname === '/market') await React.act(async () => { await client.refetchQueries({type:'active'}); await new Promise(resolve => setTimeout(resolve,0)); });
        if (pathname === '/market') {
          const chart = charts.slice(chartStart).findLast(item => item.data.some(row => row.close === 101.123456789));
          assert.ok(chart?.move, 'the real candle chart must subscribe to crosshair movement');
          await React.act(async () => {chart.move({time:fixtureMinute});});
          assert.match(container.textContent,/C 101\.12/, 'the crosshair must show the formatted close');
          assert.match(container.textContent,/101\.12/,'configured Market must show a fixture candle close');
          assert.match(container.textContent,/Instrument coverage/,'open candle-store details must render the fixture view');
          scan(container, `${pathname} / Instrument coverage`);
          for (const [tab, heading] of [['Cross-venue','Cross-venue price deviation'],['Coverage heatmap','Hourly coverage'],['Store facts','Store facts']]) {
            const button = [...container.querySelectorAll('[role="tab"]')].find(node => node.textContent === tab);
            assert.ok(button, `market tab ${tab} must exist`);
            await React.act(async () => { button.click(); await client.refetchQueries({type:'active'}); await new Promise(resolve => setTimeout(resolve,0)); });
            await openDisclosures(container);
            assert.match(container.textContent,new RegExp(heading));
            if (tab === 'Cross-venue') {
              assert.ok(container.querySelector('figure[aria-label="BTC spot deviation from the cross-venue median, basis points"]'), 'the populated cross-venue series must mount its chart');
              assert.match(container.querySelector('[aria-label="Venues in the chart"]')?.textContent ?? '', /binance BTC-USDT/, 'the fixture series must appear in the chart legend');
            }
            scan(container, `${pathname} / ${tab}`);
          }
        }
        if (pathname === '/agents/decision_reviewer') {
          for (const tab of ['Skills','Tools & policy','Notes']) {
            const button = [...container.querySelectorAll('[role="tab"]')].find(node => node.textContent.startsWith(tab));
            assert.ok(button, `agent tab ${tab} must exist`);
            await React.act(async () => { button.click(); });
            await openDisclosures(container);
            if (tab === 'Skills') assert.match(container.querySelector('[role="tabpanel"]')?.textContent ?? '',/Native Decision Trace/);
            if (tab === 'Tools & policy') {
              const panel = container.querySelector('[role="tabpanel"]')?.textContent ?? '';
              assert.match(panel,/fixture_reader/); assert.match(panel,/Listed/); assert.match(panel,/Allowed/);
            }
            if (tab === 'Notes') assert.equal(container.querySelector('#agent-notes')?.value,'Fixture operator notes');
            scan(container, `${pathname} / ${tab}`);
          }
        }
        scan(container, pathname);
        if (pathname === '/market/stocks') {
          assert.match(container.textContent,/Stock data is not configured/,'the unbound fixture must explain absent stock data');
          assert.equal(container.querySelector('a[href="/market/stocks"]')?.getAttribute('aria-current'),'page');
          assert.equal(container.querySelector('select[aria-label="Region"]')?.value,'eea');
          assert.equal(container.querySelector('select[aria-label="Instrument"]'),null);
          assert.ok(!requests.slice(requestStart).some(request => request.startsWith('/api/v5/candle-store/')),'unconfigured Stocks must not read the collector');
          await React.act(async () => { client.setQueryData(['v5-profile'], {...profile,candle_store:{configured:true}}); await new Promise(resolve => setTimeout(resolve,0)); });
          await React.act(async () => { await client.refetchQueries({queryKey:['stock-catalog']}); await new Promise(resolve => setTimeout(resolve,0)); });
          await React.act(async () => { await client.refetchQueries({queryKey:['stock-market']}); await client.refetchQueries({queryKey:['stock-candles']}); await new Promise(resolve => setTimeout(resolve,0)); });
          await openDisclosures(container);
          assert.match(container.textContent,/EXAMPLE-USDT/,'configured Stocks must show its fixture');
          assert.match(container.textContent,/Best bid/,'configured Stocks must show public observations');
          for (const value of ['Mark price','Index price','Funding rate','Open interest','Public order book','Recent captured trades','fixture-trade','Contract value / multiplier']) assert.ok(container.textContent.includes(value), `configured Stocks must mount ${value}`);
          for (const value of ['101.12','102.12','0.0123','103.12','104.12','105.12','1.1235']) assert.ok(container.textContent.includes(value), `configured Stocks must mount formatted value ${value}`);
          assert.match(container.querySelector('[aria-label="Selected stock public order book"]')?.textContent ?? '', /104\.12/, 'the book level must render');
          assert.match(container.querySelector('[aria-label="Selected stock recent trades"]')?.textContent ?? '', /105\.12/, 'the trade price must render');
          assert.ok(charts.slice(chartStart).some(chart => chart.data.some(row => row.close === 101.123456789)), 'configured Stocks must mount its final candle');
          scan(container, `${pathname} / configured`);
        }
        if (pathname === '/sessions') assert.match(container.textContent,/Blocked: exact native V5 baseline/,'session list must mount a record');
        if (pathname === '/sessions/fixture-session') { assert.match(container.textContent,/Fixture report output/); assert.match(container.textContent,/Fixture journal text/); }
        if (pathname === '/money') {
          // A gap as the latest sample is said, the last values stay labelled with their time, Helm says why it has none.
          assert.match(container.textContent,/Latest V5 sample at .* is a gap: wallet: stale/);
          assert.match(container.textContent,/199,318\.98/);
          assert.match(container.textContent,/No Helm money yet: helm status missing/);
          assert.match(container.textContent,/no backfill/);
          await React.act(async () => {
            client.setQueryData(['v5-money','7d'], old => ({...old,rows:[...old.rows,{bot:'helm',at_ms:1793929000001,unit:'USDC',realized:'1.234567897317',unrealized:'-0.123456787317'}]}));
            await new Promise(resolve => setTimeout(resolve,0));
          });
          assert.match(container.textContent,/\+1\.23/,'Helm Money fixture must render');
          scan(container, `${pathname} / Helm money`);
        }
        if (pathname === '/helm') {
          // A hostile but schema-shaped Helm read: unknowns stay unknown and unrepresentable times never throw.
          assert.match(container.textContent,/No status update since .*; current state unknown/);
          assert.match(container.textContent,/shutdown not published/);
          assert.match(container.textContent,/a failure was reported but cannot be shown safely/);
          assert.match(container.textContent,/as last published at/);
          assert.match(container.textContent,/until unknown time/);
          assert.match(container.textContent,/2 published value\(s\) did not match/);
          assert.doesNotMatch(container.textContent,/Running/);
          await React.act(async () => {
            client.setQueryData(['v5-helm'], old => ({...old,state:'FRESH',reason:null,status:{...old.status,generated_at:now/1000,age_s:0,ready:true,risk:{reason:'risk_clear',latched:false,daily_loss_use:'1.234567897317',risk_reference_quote:'100.000000007317',unit:'USDC'},control_rejections:{count:1,recent:[{action:'pause',at_ms:now-1000,reason:'fixture rejection'}]},symbols:[{pair:'BNB-USDC',status:'held',candidate_hold:null,bag:{held_amount:'0.123456787317',breakeven_price:'101.123456787317'},last_decision:null,signal:{at:now/1000,rsi:'30.123456787317',oversold:'25.123456787317',rsi_length:14,atr_fraction:'0.012345677317',min_atr_fraction:'0.010000007317',max_atr_fraction:'0.020000007317',atr_length:14,decision:{enter:false,reason:'fixture_signal'}}}]}}));
            await new Promise(resolve => setTimeout(resolve,0));
          });
          assert.match(container.textContent,/fixture rejection/,'current Helm risk, bag and rejection fixture must render');
          assert.match(container.textContent,/RSI 30\.1235/,'current Helm RSI fixture must render');
          assert.match(container.textContent,/ATR\(14\)/,'current Helm ATR fixture must render');
          assert.match(container.textContent,/Buys when RSI\(14\)/,'current Helm rule must render');
          scan(container, `${pathname} / current`);
        }
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
        if (pathname === '/bots') context.mock.timers.reset();
        container.remove();
        client.clear();
      }
    });
    assert.deepEqual(decimalFindings, [], `Visible decimals over eight places:\n${decimalFindings.join('\n')}`);
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
