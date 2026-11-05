import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Window} from 'happy-dom';
import {frontendModules} from './helpers/frontend-module.mjs';

const sections = ['status','wallet','positions','fills','executors','risk','decisions','history','accounting'];
const fixture = () => Object.fromEntries(sections.map(section => [section, JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`,import.meta.url)))]));
const original = fixture();
const now = original.status.generated_at_ms;
const overrides = Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}]));
function render(reads, extra={}) {
  const {load}=frontendModules(overrides);
  return renderToStaticMarkup(React.createElement(load('pages/tabs/ActiveBotsTab.tsx').PaperWorkspace, {reads:Object.values(reads),accountingRead:reads.accounting,now,reportAt:now,heartbeat:'Fresh',bot:original.status.bot_id,...extra}));
}

test('paper view retains simulated disclosure, independent heartbeat and exact owner exit detail', () => {
  const reads=fixture();
  const html=render(reads);
  assert.match(html,/SIMULATED ACCOUNT/);
  assert.match(html,/Fresh · heartbeat/);
  assert.match(html,/Read-only dashboard/);
  assert.match(html,/No dashboard|separately authenticated owner path/);
  assert.match(html,/Native closed candles only/);
  assert.match(html,/Remaining basis/);
});

const metricMarkup=(html,id)=>html.match(new RegExp(`<article[^>]*data-panel-id="${id}"[^>]*>[\\s\\S]*?<\/article>`))?.[0]??'';

test('zero and unavailable accounting stay distinct; large and negative exact detail survives', () => {
  const reads=fixture();
  Object.assign(reads.accounting.data.program,{realized_pnl_quote:'-0.000001',unrealized_pnl_quote:'0',fees_paid_quote:'9007199254740993.00001'});
  const html=render(reads);
  assert.match(metricMarkup(html,'paper-unrealized-pnl'),/0\.0000 USDC/);
  assert.match(html,/9,007,199,254,740,993\.0000 USDC/);
  const missing=render(reads,{accountingRead:undefined});
  assert.match(metricMarkup(missing,'paper-unrealized-pnl'),/Not published/);
  assert.doesNotMatch(metricMarkup(missing,'paper-unrealized-pnl'),/0\.0000 USDC/);
  assert.doesNotMatch(missing,/9,007,199,254,740,993/);
});

test('stale flat inventory never becomes current flatness when heartbeat is fresh', () => {
  const reads=fixture();
  reads.positions.data=[]; reads.executors.data=[];
  const html=render(reads,{now:now+120000,reportAt:now+120000});
  assert.match(html,/Fresh · heartbeat/);
  assert.match(html,/No position in last report · stale since/);
  assert.doesNotMatch(html,/No position · waiting for entry signal/);
  assert.match(html,/Incomplete or stale owner read/);
});

test('received risk holds survive incomplete and failed snapshots', () => {
  const reads=fixture();
  const held={...reads.risk,data:{holds:[{reason:'clock_persistence_failed',explanation:'Retained clock evidence'}]}};
  const html=render({status:reads.status},{safetyReads:[held],complete:false,readFailed:true});
  assert.match(html,/New acquisitions held/);
  assert.match(html,/Retained clock evidence/);
  assert.match(html,/Owner snapshot unavailable/);
  assert.doesNotMatch(html,/Wallet equity/);
});

test('a recent status cannot summarize stale child records as fresh', () => {
  const reads=fixture();
  reads.positions.state='stale';
  const html=render(reads);
  assert.match(html,/data-panel-id="paper-observation-summary"[^>]*data-state="stale"/);
  assert.match(html,/Stale.*owner sections/);
  assert.match(html,/Fresh · heartbeat/);
});

for (const [field,value] of [['realized_pnl_quote','-0.000001'],['fees_paid_quote','9007199254740993.00001'],['unrealized_pnl_quote','0']]) test(`metric exact owner decimal survives: ${value}`, () => {
  const reads=fixture(); reads.accounting.data.program[field]=value;
  const html=render(reads);
  const label={realized_pnl_quote:'Realized PnL',fees_paid_quote:'Fees paid',unrealized_pnl_quote:'Unrealized PnL'}[field];
  assert.ok(html.includes(`<summary>Exact ${label}</summary><p>${value} USDC</p>`),'the metric disclosure must preserve every owner digit and sign');
});

test('kit percent contract consumes 0.12 as 12 percent once', () => {
  const {StatStrip}=frontendModules().load('features/quant-ops/primitives.tsx');
  const html=renderToStaticMarkup(React.createElement(StatStrip,{tiles:[{id:'ratio',label:'Ratio',value:'0.12',unit:'%',state:{kind:'fresh'}}]}));
  assert.match(html,/12\.00%/);
  assert.doesNotMatch(html,/1200/);
});

test('paper rail maps percent points once and rejects a double-scaled producer value', () => {
  const reads=fixture();
  reads.risk={...reads.risk,state:'available',data:{rails:[{label:'Exposure',used_quote:'12',limit_quote:'100',used_percent:12}]}};
  const html=render(reads);
  assert.match(html,/12\.00%/);
  assert.doesNotMatch(html,/1200\.00%/);
  reads.risk.data.rails[0].used_percent=1200;
  const bad=render(reads);
  assert.match(bad,/Use not published/);
  assert.doesNotMatch(bad,/<progress/);
});

for (const [section,change] of [['wallet',{completeness:'partial'}],['risk',{state:'degraded'}],['accounting',{state:'collecting',data:null}]]) test(`summary retains ${section} qualification`, () => {
  const reads=fixture(); Object.assign(reads[section],change);
  const html=render(reads);
  assert.match(html,/data-panel-id="paper-observation-summary"[^>]*data-state="incomplete"/);
  assert.doesNotMatch(html,/Available owner sections/);
});


test('paper record export uses exact owner decimals, units and snapshot identity', async t => {
  const reads=fixture();
  const values=['-0.000001','0','9007199254740993.00001'];
  reads.executors.data=values.map((value,index) => ({...reads.executors.data[0],executor_id:`exact-${index}`,realized_pnl_quote:value}));
  let props;
  const {load}=frontendModules({...overrides,'@/features/quant-ops/kit/DataTable':{DataTable:table => {if(table.label==='Paper executors')props=table;return null;}}});
  renderToStaticMarkup(React.createElement(load('pages/tabs/ActiveBotsTab.tsx').PaperWorkspace,{reads:Object.values(reads),accountingRead:reads.accounting,now,reportAt:now,heartbeat:'Fresh',bot:reads.status.bot_id}));
  assert.ok(props,'actual workspace supplied executor table');
  const core=createRequire(import.meta.url)('@tanstack/table-core');
  const {DataTable}=frontendModules({react:{useState:initial=>[initial,()=>{}],useMemo:fn=>fn(),useEffect(){},useRef:current=>({current})},'@tanstack/react-table':{...core,flexRender:(render,context)=>typeof render==='function'?render(context):render,useReactTable:options=>{const table=core.createTable({...options,renderFallbackValue:null,onStateChange(){}});table.setOptions(old=>({...old,state:{...table.initialState,...options.state}}));return table;}}}).load('features/quant-ops/kit/DataTable.tsx');
  const tree=DataTable(props);
  function* walk(node){if(Array.isArray(node)){for(const child of node)yield* walk(child);}else if(node?.props){yield node;yield* walk(node.props.children);}}
  const previousDocument=globalThis.document,previousURL=globalThis.URL;
  let csv;
  globalThis.document={createElement:()=>({click(){}})};
  globalThis.URL={createObjectURL:blob=>{csv=blob.text();return 'blob:paper-exact';},revokeObjectURL(){}};
  t.after(()=>{globalThis.document=previousDocument;globalThis.URL=previousURL;});
  [...walk(tree)].find(node=>node.type==='button'&&node.props.children==='Export CSV').props.onClick();
  const text=await csv;
  for(const value of values)assert.ok(text.includes(`,${value},`),`CSV retains ${value}`);
  for(const id of ['exact-0','exact-1','exact-2',reads.status.bot_id,reads.status.snapshot_id])assert.ok(text.includes(id),id);
  assert.match(text,/quantity_unit,quote_unit,fee_unit/);
  assert.doesNotMatch(text,/9,007,199|−0\.000001/);
});


test('retained journal notice remains visible beside a failed extracted workspace', () => {
  const reads=fixture();
  const journal={...reads.status,state:'stale',reason:'OWNER_JOURNAL_EXCEEDED',data:{journal_budget:{state:'exceeded',journal_evidence_held:true,native_execution_continues:true,post_transition_bytes:123,limit_bytes:1000}}};
  const {load}=frontendModules({...overrides,'./usePaperObservation':{usePaperObservation:()=>({status:reads.status,journalStatus:journal,journalSnapshotLabel:'Retained journal snapshot · stale'})}});
  const {PaperJournalNotice}=load('v5/OwnerJournalCondition.tsx');
  const {PaperWorkspace}=load('pages/tabs/ActiveBotsTab.tsx');
  const html=renderToStaticMarkup(React.createElement(React.Fragment,null,React.createElement(PaperJournalNotice,{bot:reads.status.bot_id}),React.createElement(PaperWorkspace,{reads:[],complete:false,readFailed:true,now,reportAt:now,heartbeat:'Fresh',bot:reads.status.bot_id})));
  for(const text of ['Paper journal evidence held','OWNER_JOURNAL_EXCEEDED','journal_evidence_held: true','native_execution_continues: true','123 / 1000 bytes','Retained journal snapshot · stale','Owner snapshot unavailable'])assert.ok(html.includes(text),text);
});

test('only all available sections produce the available summary; heartbeat stays independent', () => {
  const reads=fixture();
  for(const read of Object.values(reads)){read.state='available';read.completeness='complete';read.next_cursor=null;}
  const html=render(reads,{heartbeat:'Stale'});
  assert.match(html,/data-panel-id="paper-observation-summary"[^>]*data-state="fresh"/);
  assert.match(html,/Available owner sections/);
  assert.match(html,/Stale · heartbeat/);
});


test('old PaperWorkspace import resolves to the extracted component', () => {
  const {load}=frontendModules(overrides);
  assert.equal(load('pages/tabs/ActiveBotsTab.tsx').PaperWorkspace,load('v5/components/PaperWorkspace.tsx').PaperWorkspace);
});

test('summary cannot be fresh when accounting belongs to another snapshot', () => {
  const reads=fixture();
  for(const read of Object.values(reads)){read.state='available';read.completeness='complete';read.next_cursor=null;}
  reads.accounting.snapshot_id='other-owner-snapshot';
  const html=render(reads);
  assert.match(html,/data-panel-id="paper-observation-summary"[^>]*data-state="incomplete"/);
  assert.doesNotMatch(html,/Available owner sections/);
});

function heldEvidence() {
  const reads=fixture();
  const id=Object.keys(reads.risk.data.controllers)[0];
  const controller=reads.risk.data.controllers[id];
  controller.operator={...controller.operator,paused:true,emergency:false};
  reads.risk.data.controllers={[id]:controller};
  reads.risk.data.native_entry_holds=[];
  reads.risk.data.control_hold='clock_anomaly';
  const retained=structuredClone(reads.risk);
  retained.snapshot_id='next:1';retained.generated_at_ms+=1000;retained.source.sequence+=1;
  retained.data.controllers[id].operator={paused:false,emergency:true};
  return {reads,id,retained};
}
const heldAside = html => html.match(/<aside\b[^>]*class="paper-fleet"[\s\S]*?<\/aside>/)?.[0] ?? '';
const controllerRows = (html,id) => html.split(`<h3>${id}</h3>`).length-1;

test('held controller appears once with the union of displayed pause and retained emergency', () => {
  const {reads,id,retained}=heldEvidence();
  const before=structuredClone({reads,retained});
  const aside=heldAside(render(reads,{safetyReads:[retained]}));
  assert.equal(controllerRows(aside,id),1);
  assert.match(aside,/Reported operator pause: Yes/);
  assert.match(aside,/Reported emergency halt: Yes/);
  assert.match(aside,/Retained clock evidence|clock anomalies/i);
  assert.deepEqual({reads,retained},before,'presentation does not mutate retained or displayed evidence');
});

test('held controller is not duplicated by cloned repeated safety signals', () => {
  const {reads,id}=heldEvidence();
  const aside=heldAside(render(reads,{safetyReads:[structuredClone(reads.risk),structuredClone(reads.risk)]}));
  assert.equal(controllerRows(aside,id),1);
  assert.match(aside,/Reported operator pause: Yes/);
});

test('held controller union preserves native entry reasons and latch alongside operator evidence', () => {
  const {reads,id,retained}=heldEvidence();
  reads.risk.data.native_entry_holds=[{controller_id:id,reason:'native_refusal_owner_ambiguous',explanation:'Displayed native ownership evidence',protected_exits:'preserved'}];
  retained.data.native_entry_holds=[{controller_id:id,reason:'native_refusal_receipt_pending',explanation:'Retained native refusal evidence',protected_exits:'preserved'}];
  retained.data.controllers[id].native={complete:false,entry_hold:true,latched:true};
  const aside=heldAside(render(reads,{safetyReads:[retained]}));
  assert.equal(controllerRows(aside,id),1);
  for(const text of ['Reported operator pause: Yes','Reported emergency halt: Yes','Reported native entry hold: Yes','Displayed native ownership evidence','Retained native refusal evidence'])assert.ok(aside.includes(text),text);
});

test('invalid displayed risk cannot remove any retained controller signals', () => {
  const {reads,id,retained}=heldEvidence();
  const paused=structuredClone(reads.risk);
  reads.risk.reason={invalid:true};
  const aside=heldAside(render(reads,{safetyReads:[retained,paused]}));
  assert.equal(controllerRows(aside,id),1);
  assert.match(aside,/Reported operator pause: Yes/);
  assert.match(aside,/Reported emergency halt: Yes/);
});


test('extracted paper container owns wrapping without the V5 page wrapper', () => {
  const window = new Window();
  try {
    // Load only the extracted view's stylesheet: its boundary must not depend on page CSS.
    const style = window.document.createElement('style');
    style.textContent = fs.readFileSync(new URL('../src/v5/components/PaperWorkspace.css', import.meta.url), 'utf8');
    window.document.head.append(style);
    window.document.body.innerHTML = render(fixture());
    const workspace = window.document.querySelector('[data-paper-workspace]');
    assert.ok(workspace);
    assert.equal(workspace.closest('.v5-paper-bots'), null);
    assert.equal(window.getComputedStyle(workspace).overflowWrap, 'anywhere');
    assert.equal(Number.parseFloat(window.getComputedStyle(workspace).minWidth), 0);
    assert.equal(Number.parseFloat(window.getComputedStyle(workspace).marginBlock), 0);
    assert.equal(Number.parseFloat(window.getComputedStyle(workspace).paddingBlock), 0);
  } finally { window.close(); }
});
