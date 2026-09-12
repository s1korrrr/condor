// Deterministic local UI fixtures only. Never used by the application build.
export function fixturePayload(mode='complete',server='fixture',range='1W') {
 const now=Date.now();const stamp=ms=>new Date(ms).toISOString();
 const raw=[['USDT','12000','10500','1'],['BTC','0.12','0.10','70000'],['SUI','1500','900','2.4'],['ETH','0.4','0.3','3100']];
 if(server==='fixture-other')raw.splice(0,raw.length,['OTHER','2','1','5']);
 const holdings=raw.map(([token,total,available,price])=>({token,total,available,locked:String(Number((Number(total)-Number(available)).toFixed(8))),price,value:String(Number(total)*Number(price)),quote_currency:'USDT',valuation_source:token==='USDT'?'quote_currency':'okx_spot_last_trade',price_observed_at:stamp(now)}));
 if(mode==='partial'){holdings[1].price=null;holdings[1].value=null;holdings[1].valuation_source=null;holdings[1].price_observed_at=null;}
 if(mode==='empty')holdings.length=0;
 const current={observed_at:stamp(now-(mode==='stale'?40000:0)),holdings,priced_total:String(holdings.reduce((s,h)=>s+Number(h.value??0),0)),valuation_complete:mode!=='partial',unpriced_assets:mode==='partial'?[holdings[1].token]:[]};
 const length=range==='1D'?60:range==='1W'?100:150;
 const points=Array.from({length},(_,i)=>({observed_at:stamp(now-(length-i)*60000),priced_total:String(24200+i*4+Math.sin(i/8)*90),valuation_complete:!(mode==='partial'&&i>35&&i<50),unpriced_assets:mode==='partial'&&i>35&&i<50?['BTC']:[]}));
 if(mode==='gap')points.splice(40,10);
 if(mode==='no-history')points.length=0;
 const history={points,first_observed_at:points[0]?.observed_at??null,range_start:stamp(now-({ '1D':1,'1W':7,'1M':30,'3M':90,ALL:365}[range])*86400000),range_end:stamp(now),truncated:false,gaps:mode==='gap'?[{from:points[39].observed_at,to:points[40].observed_at,seconds:660}]:[]};
 return {schema_version:1,quote_currency:'USDT',scope:mode==='disconnected'?null:{account:'master_account',connector:'okx',market:'spot',identity:server},capture_mode:'observation-driven',current:mode==='disconnected'?null:current,history:mode==='disconnected'?null:history,
 changes:mode==='disconnected'||mode==='no-history'||mode==='empty'?[]:[{observed_at:stamp(now-180000),token:holdings[0]?.token??'USDT',previous_total:'12500',total:'12000',delta:'-500',kind:'observed_balance_change'},{observed_at:stamp(now-360000),token:'SUI',previous_total:'1300',total:'1500',delta:'200',kind:'observed_balance_change'}],changes_truncated:false,
 performance:{available:false,reason:'Cash flows and acquisition cost are not reconciled; value changes are not profit or return.'}};
}
