import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import * as portfolio from '../src/features/portfolio/model.ts';

const require=createRequire(new URL('../package.json',import.meta.url));
const ts=require('typescript');
const module={exports:{}};
const source=ts.transpileModule(readFileSync(new URL('../src/features/quant-ops/capital-project.ts',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(source,{module,exports:module.exports,require(name){
  assert.equal(name,'@/features/portfolio/model');return portfolio;
}});
const {nativeWalletFromRuntime,projectCapitalModel,observedDrawdown,observedEquityChanges,concentration}=module.exports;
const at='2026-09-23T06:00:00Z',now=Date.parse(at);
const holding=(token,total,available,value,price)=>({token,total,available,locked:available===null?null:String(Number(total)-Number(available)),
  value,price,quote_currency:'USDT',valuation_source:'owner',price_observed_at:at});

test('cash totals use valued total balances across quote assets; available remains token units',()=>{
  const current={observed_at:at,priced_total:'1000',valuation_complete:true,unpriced_assets:[],holdings:[
    holding('USDC','200','100','198','0.99'),holding('USDT','100','100','100','1'),holding('ETH','2','2','702','351'),
  ]};
  const view=projectCapitalModel({current,history:[],now,unit:'USDT'});
  assert.equal(view.availableQuote.value,'100');assert.equal(view.availableQuote.unit,'USDC');
  assert.equal(view.cashValue,298);assert.equal(view.nonCashValue,702);assert.equal(view.deployed.value,'702');
});

test('native wallet requires an explicit value quote and keeps missing free balance unknown',()=>{
  const balances=[{asset:'USDC',total_balance:200,value_quote:198}];
  assert.equal(nativeWalletFromRuntime({balances,observedAt:at}),null);
  const wallet=nativeWalletFromRuntime({balances,observedAt:at,quoteCurrency:'USDT'});
  assert.equal(wallet.holdings[0].available,null);
  assert.equal(wallet.holdings[0].locked,null);
  const view=projectCapitalModel({current:wallet,history:[],now,unit:'USDT'});
  assert.equal(view.availableQuote.value,null);
  assert.equal(view.cashValue,198);
});

test('incomplete or unpriced holdings do not claim non-cash account exposure',()=>{
  const current={observed_at:at,priced_total:'300',valuation_complete:false,unpriced_assets:['ETH'],holdings:[
    holding('USDC','100','100','100','1'),holding('ETH','1','1',null,null),
  ]};
  const view=projectCapitalModel({current,history:[],now,unit:'USDT'});
  assert.equal(view.cashValue,null);assert.equal(view.nonCashValue,null);assert.equal(view.deployed.value,null);
});

test('raw balances cannot become performance risk when owner risk is unqualified',()=>{
  const current={observed_at:at,priced_total:'100',valuation_complete:true,unpriced_assets:[],holdings:[holding('USDC','100','100','100','1')]};
  const history=[{observed_at:'2026-09-21T00:00:00Z',priced_total:'100',valuation_complete:true,unpriced_assets:[]},
    {observed_at:'2026-09-22T00:00:00Z',priced_total:'0',valuation_complete:true,unpriced_assets:[]}];
  const model=projectCapitalModel({current,history,now,dashboard:{drawdown:'-1',volatility:'0.1',sharpe:'2',sample_days:30}});
  assert.equal(observedDrawdown(history),-1);
  assert.equal(model.drawdown,null);assert.equal(model.volatility,null);assert.equal(model.sharpe,null);assert.equal(model.sampleDays,0);
});

test('incomplete concentration and gapped observed changes remain unavailable',()=>{
  const rows=[holding('ETH','1','1','50','50'),holding('BNB','1','1',null,null)];
  assert.equal(concentration(rows,100).top3,null);
  const points=[{observed_at:'2026-09-21T00:00:00Z',priced_total:'100',valuation_complete:true},
    {observed_at:'2026-09-21T00:01:00Z',priced_total:'110',valuation_complete:false},
    {observed_at:'2026-09-21T00:02:00Z',priced_total:'120',valuation_complete:true}];
  assert.equal(observedEquityChanges(points).length,0);
});
