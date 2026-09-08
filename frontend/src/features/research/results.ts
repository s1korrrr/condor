export function sourceResultBars(data: Record<string,unknown>) {
  return [['net_pnl_quote','Net PnL'],['fees_quote','Fees'],['gross_pnl_quote','Gross PnL']].flatMap(([key,label])=>{
    const value=data[key];return typeof value==='number' && Number.isFinite(value) ? [{key,label,value}] : [];
  });
}
export function comparisonGroups(values: Record<string,unknown>[]) {
  const groups=new Map<string,{key:string,unit:string,metric:string,baseline:string,items:{label:string,value:number}[]}>();
  for(const v of values) {
    if(typeof v.value!=='number'||!Number.isFinite(v.value)||v.validity!=='VALID'||v.attribution!=='ISOLATED'||!Array.isArray(v.source_refs)||v.source_refs.length===0)continue;
    if(!['label','unit','metric','baseline','comparable_group'].every(key=>typeof v[key]==='string'&&v[key]))continue;
    const key=JSON.stringify([v.comparable_group,v.unit,v.metric,v.baseline]);
    if(!groups.has(key))groups.set(key,{key,unit:v.unit as string,metric:v.metric as string,baseline:v.baseline as string,items:[]});
    groups.get(key)!.items.push({label:v.label as string,value:v.value});
  }
  return [...groups.values()];
}
