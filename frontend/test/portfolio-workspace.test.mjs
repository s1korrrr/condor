import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioSummary, historySeries, filterHoldings, holdingsCsv, valueChange } from '../src/features/portfolio/model.ts';
const now = Date.parse('2026-09-10T10:00:00Z');
const holding = {token:'SUI',total:'10',available:'6',locked:'4',price:'2',value:'20',quote_currency:'USDT',valuation_source:'owner',price_observed_at:new Date(now).toISOString()};
const current = {observed_at:new Date(now).toISOString(),holdings:[holding],priced_total:'20',valuation_complete:true,unpriced_assets:[]};
test('capital summary values available and locked inventory with one price basis',()=>{
 const s=portfolioSummary(current,now); assert.equal(s.pricedTotal,20); assert.equal(s.availableValue,12); assert.equal(s.lockedValue,8); assert.equal(s.complete,true);
});
test('partial valuation cannot claim total account value or whole-account weights',()=>{
 const s=portfolioSummary({...current,valuation_complete:false,unpriced_assets:['ABC'],holdings:[holding,{...holding,token:'ABC',price:null,value:null}]},now);
 assert.equal(s.complete,false); assert.equal(s.pricedTotal,20); assert.equal(s.allocation[0].weight,null); assert.equal(s.unpricedCount,1);
});
test('stale or failed observations do not display current capital',()=>{
 assert.equal(portfolioSummary(current,now+30000).current,false);
 assert.equal(portfolioSummary(current,now,true).pricedTotal,null);
 assert.equal(portfolioSummary({...current,observed_at:new Date(now+1).toISOString()},now).current,false);
});
test('history gaps and unpriced observations interrupt charts, without fabricated profit',()=>{
 const p=(seconds,value,complete=true)=>({observed_at:new Date(now+seconds*1000).toISOString(),priced_total:value,valuation_complete:complete,unpriced_assets:[]});
 const points=[p(0,'10'),p(60,'11'),p(240,'12'),p(300,'8',false),p(360,'13')];
 const series=historySeries(points); assert.equal(series.filter(p=>p.value===null).length,2); assert.equal(series.at(-1).value,13);
 assert.equal(valueChange(points),null); assert.equal(valueChange([p(0,'10'),p(60,'12')]),2);
});
test('search and sorting preserve exact amounts for details and CSV',()=>{
 const rows=[holding,{...holding,token:'BTC',value:'100'}];
 assert.equal(filterHoldings(rows,'sui','value','desc')[0].total,'10');
 assert.equal(filterHoldings(rows,'','value','desc')[0].token,'BTC');
 const csv=holdingsCsv([{...holding,token:'=FORMULA',total:'0.123456789012345678'}]);
 assert.ok(csv.includes('0.123456789012345678')); assert.ok(csv.includes("'=FORMULA"));
});

test('zero inventory without a market price does not make the account partially valued',()=>{
 const s=portfolioSummary({...current,holdings:[holding,{...holding,token:'OLD',total:'0',available:'0',locked:'0',price:null,value:null}]},now);
 assert.equal(s.complete,true);assert.equal(s.unpricedCount,0);assert.equal(s.allocation[0].weight,100);
});
