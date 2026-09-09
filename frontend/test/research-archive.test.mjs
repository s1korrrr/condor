import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {envelope,renderResearchComponent} from './helpers/research-component-render.mjs';
const code=ts.transpileModule(fs.readFileSync(new URL('../src/features/research/research-archive.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {archiveState,updateArchiveParams}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('archive deep links retain independent archive filters and selection with bounded offset',()=>{
 const state=archiveState(new URLSearchParams('view=archive&q=graph&archive_view=coverage&archive_q=old+RSI&archive_status=HELD&archive_offset=60&archive_record=record%3Aone'));
 assert.deepEqual(state,{view:'coverage',q:'old RSI',kind:'',family:'',lane:'',status:'HELD',offset:60,record:'record:one'});
 assert.equal(archiveState(new URLSearchParams('archive_offset=-3')).offset,0);
 assert.equal(archiveState(new URLSearchParams('archive_offset=Infinity')).offset,0);
 assert.equal(archiveState(new URLSearchParams('archive_offset=1000001')).offset,0);
});
test('archive filter changes reset page and selection without overwriting graph navigation state',()=>{
 const original=new URLSearchParams('view=archive&id=idea%3Aone&q=graph&archive_offset=60&archive_record=record%3Aone');
 const next=updateArchiveParams(original,{q:'new search',family:'rsi_v5'});
 assert.equal(next.get('q'),'graph');assert.equal(next.get('id'),'idea:one');assert.equal(next.get('archive_q'),'new search');assert.equal(next.get('archive_family'),'rsi_v5');assert.equal(next.has('archive_offset'),false);assert.equal(next.has('archive_record'),false);assert.equal(original.get('archive_record'),'record:one');
});
function render({record={},prepared={},query='',overview={}}={}) {
 return renderResearchComponent('ResearchArchive',{server:'fixture'},{'research-archive-overview':{data:envelope({revision:'r1',generated_at:'2026-09-08',counts:{records:1},coverage:{records:1,files_discovered:2,unresolved_count:1},...overview})},'research-archive':{data:envelope({revision:'r1',items:[{id:'record:one',display_title:'Frozen experiment',kind:'experiment',status_group:'HELD'}],total:1,limit:30,offset:0,facets:{}})},'research-archive-record':{data:envelope({revision:'r1',record:{id:'record:one',kind:'experiment',fields:{long_source:'retained'},...record},prepared:{id:'record:one',display_title:'Frozen experiment',projection_note:'Summary index only',aliases:['prior:one'],...prepared},documents:[]})}},{search:'view=archive&archive_record=record%3Aone'+query});
}
test('archive distinguishes prepared preview, full native record and aliases and retains source-hash metric gate',()=>{
 const r=render({prepared:{evidence_readout:{metrics_state:'HASH_MISMATCH',recorded_metrics:{economics:{net_pnl_quote:999}},baseline_comparison:'UNAVAILABLE'}}});
 for(const s of ['Frozen experiment','Summary index only','Source aliases','Full native record','Prepared index record','matching frozen source has not been established'])assert.ok(r.html.includes(s),s);
 assert.doesNotMatch(r.html,/<dt>net_pnl_quote<\/dt>/);
});
test('hash-matched archive economics retain raw names and separate baseline and promotion',()=>{
 const r=render({prepared:{evidence_readout:{metrics_state:'SOURCE_HASH_MATCHED; NOT_ECONOMIC_ADJUDICATION',recorded_metrics:{economics:{net_pnl_quote:-12},activity:{fills:4},risk:{max_drawdown:0.1}},baseline_comparison:'UNAVAILABLE',promotion:'HOLD_FOR_EVIDENCE',authority:'research-only'}}});
 assert.match(r.html,/<dt>net_pnl_quote<\/dt><dd>-12<\/dd>/);assert.match(r.html,/Baseline comparison/);assert.match(r.html,/HOLD_FOR_EVIDENCE/);
});
test('missing preservation receipts remain unavailable and coverage subview stays navigable',()=>{
 const r=render({query:'&archive_view=coverage',overview:{preservation:{missing_paths:[]}}});
 assert.match(r.html,/Preservation receipt incomplete/);assert.match(r.html,/Coverage/);assert.match(r.html,/Provenance/);
 const button=r.buttons.find(b=>b.text==='Next experiment');assert.ok(button);button.onClick();assert.match(r.searchUpdates.at(-1),/archive_view=next/);
});
