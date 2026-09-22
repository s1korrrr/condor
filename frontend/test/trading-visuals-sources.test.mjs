import test from 'node:test';
import assert from 'node:assert/strict';
import * as sources from '../src/features/trading-visuals/sources.ts';
test('default source follows selected server; explicit bot links fail closed',()=>{
 assert.equal(typeof sources.selectTradingVisualsSource,'function');
 const rows=[{bot:'ok_rsi',server:'main'},{bot:'ok_rsi_sui_sell_only',server:'sui'}];
 assert.equal(sources.selectTradingVisualsSource(rows,null,'sui').bot,'ok_rsi_sui_sell_only');
 assert.equal(sources.selectTradingVisualsSource(rows,'ok_rsi','sui').bot,'ok_rsi');
 assert.equal(sources.selectTradingVisualsSource(rows,'unknown','sui'),undefined);
});
test('registry owners without ok_rsi still resolve from discovery',()=>{
 const rows=[{bot:'rsi_modular_v2',server:'native-rsi-modular-v2'},{bot:'breakout_paper_v2',server:'paper'}];
 assert.equal(sources.selectTradingVisualsSource(rows,null,'native-rsi-modular-v2').bot,'rsi_modular_v2');
 assert.equal(sources.selectTradingVisualsSource(rows,null,null).bot,'rsi_modular_v2');
 assert.equal(sources.selectTradingVisualsSource(rows,'breakout_paper_v2',null).bot,'breakout_paper_v2');
});
