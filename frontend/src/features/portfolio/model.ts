export type PortfolioRange = '1D' | '1W' | '1M' | '3M' | 'ALL';
export interface Holding {
  token: string; total: string; available: string; locked: string;
  price: string | null; value: string | null; quote_currency: 'USDT';
  valuation_source: string | null; price_observed_at: string | null;
}
export interface HistoryPoint {
  observed_at: string; priced_total: string; valuation_complete: boolean; unpriced_assets: string[];
}
export interface CurrentPortfolio extends HistoryPoint { holdings: Holding[] }
export interface PortfolioAnalytics {
  schema_version: 1; quote_currency: 'USDT';
  scope: {account: string; connector: string; market: 'spot'; identity: string} | null;
  capture_mode: 'observation-driven'; current: CurrentPortfolio | null;
  history: {points: HistoryPoint[]; first_observed_at: string | null; range_start: string; range_end: string; truncated: boolean; gaps: {from: string; to: string; seconds: number}[]} | null;
  changes: {observed_at: string; token: string; previous_total: string; total: string; delta: string; kind: 'observed_balance_change'}[];
  performance: {available: false; reason: string};
}
const number = (value: string | null) => value === null || value.trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export function portfolioSummary(current: CurrentPortfolio | null, now: number, failed = false) {
  const age = current ? now - Date.parse(current.observed_at) : NaN;
  const fresh = !failed && Number.isFinite(age) && age >= 0 && age < 30000;
  const holdings = fresh ? current!.holdings : [];
  const priced = holdings.filter(h => number(h.value) !== null && number(h.price) !== null);
  const pricedTotal = fresh ? number(current!.priced_total) : null;
  const unpricedCount = holdings.filter(h => Number(h.total) > 0 && (number(h.value) === null || number(h.price) === null)).length;
  const complete = fresh && current!.valuation_complete && unpricedCount === 0;
  return {current: fresh, complete, pricedTotal,
    availableValue: fresh ? priced.reduce((s,h) => s + Number(h.available) * Number(h.price), 0) : null,
    lockedValue: fresh ? priced.reduce((s,h) => s + Number(h.locked) * Number(h.price), 0) : null,
    unpricedCount,
    allocation: priced.filter(h=>Number(h.value)>0).sort((a,b)=>Number(b.value)-Number(a.value)).map(h=>({token:h.token,value:Number(h.value),weight:complete && pricedTotal!>0 ? Number(h.value)/pricedTotal! *100 : null})),
  };
}
export function historySeries(points: HistoryPoint[]) {
  const result: {time:number;value:number|null}[]=[];
  for (const [index,point] of points.entries()) {
    const time=Date.parse(point.observed_at);
    if (index && time-Date.parse(points[index-1].observed_at)>120000) result.push({time:Date.parse(points[index-1].observed_at)+1,value:null});
    result.push({time,value:point.valuation_complete ? number(point.priced_total) : null});
  }
  return result;
}
/** Raw account-value difference, never a return or P&L. Incomplete/gapped coverage has no comparable change. */
export function valueChange(points: HistoryPoint[]) {
  if(points.length<2 || historySeries(points).some(p=>p.value===null)) return null;
  return Number(points.at(-1)!.priced_total)-Number(points[0].priced_total);
}
export type SortKey = 'token'|'total'|'available'|'locked'|'price'|'value';
export function filterHoldings(rows: Holding[], search: string, key: SortKey, direction: 'asc'|'desc') {
  return rows.filter(h=>h.token.toLowerCase().includes(search.toLowerCase().trim())).sort((a,b)=>{
    if(a[key]===null) return b[key]===null?0:1;
    if(b[key]===null) return -1;
    const comparison=key==='token'?a.token.localeCompare(b.token):Number(a[key])-Number(b[key]);
    return (direction==='asc'?1:-1)*comparison;
  });
}
function csvCell(value: string | null) {
  const text=value===null?'Unavailable':value;
  const safe=/^[=+@\t\r]/.test(text) || /^-(?!\d)/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"','""')}"`;
}
export function holdingsCsv(rows: Holding[]) {
  return ['Asset,Total,Available,Locked,Price (USDT),Value (USDT),Price observed at,Source',...rows.map(h=>[h.token,h.total,h.available,h.locked,h.price,h.value,h.price_observed_at,h.valuation_source].map(csvCell).join(','))].join('\r\n');
}
