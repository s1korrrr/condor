import test from 'node:test';
import assert from 'node:assert/strict';
import * as sources from '../src/features/trading-visuals/sources.ts';
test('default source follows selected server; explicit bot links fail closed',()=>{
 assert.equal(typeof sources.selectTradingVisualsSource,'function');
 const rows=[{bot:'ok_rsi',server:'main'},{bot:'ok_rsi_sui_sell_only',server:'sui'},{bot:'rsi_v5',server:'main'}];
 assert.equal(sources.selectTradingVisualsSource(rows,null,'sui').bot,'ok_rsi_sui_sell_only');
 assert.equal(sources.selectTradingVisualsSource(rows,'ok_rsi','sui').bot,'ok_rsi');
 assert.equal(sources.selectTradingVisualsSource(rows,'rsi_v5','sui').bot,'rsi_v5');
 assert.equal(sources.selectTradingVisualsSource(rows,'unknown','sui'),undefined);
});
test('authorized identities are unique registered names; a fourth bot does not need an allowlist',()=>{
 const payload={sources:[{bot:'ok_rsi',server:'native-ok-rsi'},{bot:'ok_rsi_sui_sell_only',server:'native-ok-rsi'},{bot:'rsi_v5',server:'native-ok-rsi'},{bot:'meanrev_eth',server:'native-ok-rsi'}]};
 assert.deepEqual(sources.parseTradingVisualsSources(payload).map(row=>row.bot),['ok_rsi','ok_rsi_sui_sell_only','rsi_v5','meanrev_eth']);
 assert.throws(()=>sources.parseTradingVisualsSources({sources:[...payload.sources,{bot:'rsi_v5',server:'other'}]}),/invalid or duplicated/);
 assert.throws(()=>sources.parseTradingVisualsSources({sources:[{bot:'',server:'native-ok-rsi'}]}),/invalid or duplicated/);
 assert.throws(()=>sources.parseTradingVisualsSources({sources:[{bot:'bad bot',server:'native-ok-rsi'}]}),/invalid or duplicated/);
});
test('display names keep V1 nicknames and leave registered V2 ids intact',()=>{
 assert.equal(sources.displayBotName('ok_rsi'),'Main');
 assert.equal(sources.displayBotName('rsi_modular_v2'),'rsi_modular_v2');
 assert.equal(sources.displayBotName('breakout_paper_v2'),'breakout_paper_v2');
});
test('paper bots are labelled without hiding them from the roster',()=>{
 assert.equal(sources.isPaperBot('breakout_paper_v2'),true);
 assert.equal(sources.isPaperBot('rsi_modular_v2'),false);
});
test('source matching accepts a second server name that shares host and port',()=>{
 const source={bot:'rsi_modular_v2',server:'native-ok-rsi'};
 const servers=[{name:'native-ok-rsi',host:'127.0.0.1',port:8000},{name:'rsibot-stack-v2',host:'127.0.0.1',port:8000}];
 assert.equal(sources.sourceMatchesServer(source,'rsibot-stack-v2',servers),true);
 assert.equal(sources.sourceMatchesServer(source,'other',servers),false);
 assert.deepEqual(sources.sourcesForServer([source],'rsibot-stack-v2',servers).map(row=>row.bot),['rsi_modular_v2']);
});
