import test from 'node:test';
import assert from 'node:assert/strict';
import {envelope,renderResearchComponent} from './helpers/research-component-render.mjs';
function render(node,data={}) {
 const selections=[];
 const result=renderResearchComponent('ResearchInspector',{server:'fixture',id:node.id,onSelect:id=>selections.push(id),onFindInNetwork:id=>selections.push('network:'+id),onArchiveRecord:id=>selections.push('archive:'+id)}, {'research-node':{data:envelope({node,...data})},'research-comparisons':{data:envelope({items:[],excluded:0,limitations:[]})}});
 return {...result,selections};
}
test('idea detail exposes distinct usage, attributed evaluations and recorded attempt outcomes without treating process completion as support',()=>{
 const r=render({id:'idea:1',title:'A real hypothesis',kind:'idea',status:'HELD',data:{hypothesis:'Range recovery'},source:{sha256:'abc'}},{usage:{experiments:2,attempts:5,valid_evaluations:3,valid_isolated:{SUPPORTED:1,CONTRADICTED:1,INCONCLUSIVE:1},combined:4,unavailable:6,independent_evaluation_note:'Evaluations share a dataset',attempt_states:{FAILED:2,COMPLETED:3}}});
 for(const content of ['Distinct experiments','Recorded attempts','Valid evaluations','Supported','Contradicted','Inconclusive','Combined attribution','Unavailable attribution','Evaluations share a dataset','Attempt outcomes','FAILED']) assert.ok(r.html.includes(content),content);
 const b=r.buttons.find(b=>b.text==='Find in research network'); assert.ok(b);b.onClick();assert.deepEqual(r.selections,['network:idea:1']);
});
test('supervisor detail preserves budgets, blocked reason and actionable revision/outcome/lesson references',()=>{
 const r=render({id:'decision:s',title:'Supervised trial',kind:'decision',status:'HELD',source:{},data:{schema:'research_knowledge.supervisor.v1',mandate:{program_id:'program:a',authority:'research-only',budget:{max_trials:3,max_agent_actions:10}},stage:'RESULT_AUDIT',agent_actions:4,promotion:'HOLD',reason:'Need owner evidence',program:{blockers:['No isolated comparison']},trials:[{idea:{title:'One hypothesis'},idea_revision_id:'revision:one',outcome_id:'outcome:one',lesson_ids:['lesson:one'],scorecard:{process_status:'COMPLETED',historical_result:'PROXY'},owner_comparison:{verdict:'UNAVAILABLE'}}]}});
 for(const content of ['Supervised research','1 / 3','4 / 10','RESULT_AUDIT','No isolated comparison','One hypothesis','Idea revision','Recorded outcome','Retained lesson'])assert.ok(r.html.includes(content),content);
 const b=r.buttons.find(b=>b.text==='Retained lesson');assert.ok(b);b.onClick();assert.deepEqual(r.selections,['lesson:one']);
});
test('outcome detail retains exclusive window, scope, reopening condition and supersession',()=>{
 const r=render({id:'outcome:a',title:'Failed trial',kind:'decision',status:'HELD',data:{schema:'research_knowledge.outcome.v1',rationale:'Insufficient evidence',outcome:'INCONCLUSIVE',backtest_state:'COMPLETED',evidence_state:'PROXY',failure_domain:'HYPOTHESIS',scope:{venue:'OKX',capital_model:'SPOT',window:{start:'2026-05-01',end_exclusive:'2026-09-01'},regimes:['range']},reopening_condition:'Acquire independent evidence',idea_revision_id:'revision:a',supersedes:'outcome:old'}});
 for(const content of ['end exclusive','Acquire independent evidence','Supersedes','HYPOTHESIS','OKX','SPOT'])assert.ok(r.html.includes(content),content);
});
test('scorecard preserves declared units and fractions, error and passive baseline qualification',()=>{
 const r=render({id:'decision:score',title:'Score',kind:'decision',status:'HELD',data:{schema:'research_knowledge.campaign_scorecard.v1',process_status:'COMPLETED',owner_baseline_comparison:'UNAVAILABLE',promotion:'HOLD',metrics:{drawdown:{value:.125,unit:'fraction'},trades:{value:0,unit:'trades'}},owner_scorecard:{passive_baseline:{},activity_definition:'Count filled orders',limitations:['No native queue model']},evidence_error:'Missing comparative evidence'}});
 for(const content of ['12.5%','0 trades','uncosted reference','Count filled orders','No native queue model','Missing comparative evidence'])assert.ok(r.html.includes(content),content);
});
test('history labels recorded relationship basis and unsafe source URL never becomes an anchor',()=>{
 const r=render({id:'idea:1',title:'<script>bad()</script>',kind:'idea',status:'HELD',data:{},source:{url:'javascript:alert(1)',record_id:'archive:1'}},{related:[{id:'run:1',title:'Attempt one',kind:'run'}],edges:[{source:'idea:1',target:'run:1',relation:'tested_by',basis:'explicit manifest'}]});
 assert.match(r.html,/explicit manifest/);assert.match(r.html,/tested by/);assert.doesNotMatch(r.html,/href="javascript:/);assert.match(r.html,/&lt;script&gt;/);
 const b=r.buttons.find(b=>b.text==='Open archival record');assert.ok(b);b.onClick();assert.deepEqual(r.selections,['archive:archive:1']);
});
test('paper and experiment summaries remain visible without opening raw node disclosure',()=>{
 const r=render({id:'paper:p',title:'Paper P',kind:'paper',status:'INDEXED',data:{summary:{claim:'Mean reversion hypothesis',caveat:'Source claim only'}}});
 assert.match(r.html.split('Full graph node')[0],/Mean reversion hypothesis/);
});
test('a comparison from another graph revision is withheld while refresh is offered',()=>{
 const r=renderResearchComponent('ResearchInspector',{server:'fixture',id:'idea:1',onSelect(){},onFindInNetwork(){},onArchiveRecord(){}},{'research-node':{data:envelope({revision:'r2',node:{id:'idea:1',title:'New revision',kind:'idea',data:{}}})},'research-comparisons':{data:envelope({revision:'r1',items:[],limitations:['OLD_COMPARISON_MUST_NOT_RENDER']})}});
 assert.match(r.html,/different graph revision/);assert.doesNotMatch(r.html,/OLD_COMPARISON_MUST_NOT_RENDER/);
});
