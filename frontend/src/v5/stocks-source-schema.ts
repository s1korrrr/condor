import { ownerTitleText } from './format.mjs';

const decimal = 'decimal';
const opaque = 'opaque';
const identity = { instType: opaque, instId: opaque } as const;

export const okxSourceSchemas = {
  instrument: {
    ...identity, instCategory: opaque, state: opaque, ruleType: opaque, baseCcy: opaque,
    quoteCcy: opaque, settleCcy: opaque, uly: opaque, instFamily: opaque, ctType: opaque,
    ctValCcy: opaque, listTime: opaque, expTime: opaque, auctionEndTime: opaque,
    futureSettlement: opaque, optType: opaque, alias: opaque, stkType: opaque,
    ctVal: decimal, ctMult: decimal, lotSz: decimal, tickSz: decimal, minSz: decimal,
    lever: decimal, stk: decimal, maxLmtSz: decimal, maxMktSz: decimal,
    maxLmtAmt: decimal, maxMktAmt: decimal, maxTwapSz: decimal, maxIcebergSz: decimal,
    maxTriggerSz: decimal, maxStopSz: decimal,
  },
  ticker: {
    ...identity, ts: opaque, last: decimal, lastSz: decimal, askPx: decimal, askSz: decimal,
    bidPx: decimal, bidSz: decimal, open24h: decimal, high24h: decimal, low24h: decimal,
    volCcy24h: decimal, vol24h: decimal, sodUtc0: decimal, sodUtc8: decimal,
  },
  funding: {
    ...identity, method: opaque, formulaType: opaque, fundingTime: opaque,
    nextFundingTime: opaque, settState: opaque, ts: opaque,
    fundingRate: decimal, nextFundingRate: decimal, minFundingRate: decimal,
    maxFundingRate: decimal, interestRate: decimal, impactValue: decimal,
    settFundingRate: decimal, premium: decimal,
  },
  mark_price: { ...identity, ts: opaque, markPx: decimal },
  index_price: { instId: opaque, ts: opaque, idxPx: decimal, high24h: decimal, low24h: decimal, open24h: decimal, sodUtc0: decimal, sodUtc8: decimal },
  open_interest: { ...identity, ts: opaque, oi: decimal, oiCcy: decimal, oiUsd: decimal },
  trades: { ...identity, tradeId: opaque, side: opaque, ts: opaque, seqId: opaque, source: opaque, px: decimal, sz: decimal, count: decimal },
  books: { ts: opaque, checksum: opaque, seqId: opaque, prevSeqId: opaque, bids: 'levels', asks: 'levels' },
} as const;

export type OkxSourcePayload<Dataset extends keyof typeof okxSourceSchemas> = {
  [Field in keyof typeof okxSourceSchemas[Dataset]]?: typeof okxSourceSchemas[Dataset][Field] extends 'levels' ? unknown[][] : string | number | null;
};

type SourceSchema = Record<string, 'decimal' | 'opaque' | 'levels'>;
type SourceRecord = Record<string, unknown>;

function projectSource(value: unknown, schema: SourceSchema): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => {
    if (schema[name] === 'decimal') return [name, ownerTitleText(entry) ?? entry];
    if (schema[name] === 'levels' && Array.isArray(entry)) return [name, entry.map(level => Array.isArray(level) ? level.map((part, index) => index < 2 ? ownerTitleText(part) ?? part : part) : level)];
    return [name, entry];
  }));
}

function projectEvent(value: unknown, schema: SourceSchema): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  const event = value as SourceRecord;
  return { ...event, data: projectSource(event.data, schema) };
}

export function stockRecordTitle(value: unknown): string | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value, null, 2);
  const record = projectSource(value, okxSourceSchemas.instrument) as SourceRecord;
  const latest = record.latest;
  if (latest != null && typeof latest === 'object' && !Array.isArray(latest)) {
    record.latest = Object.fromEntries(Object.entries(latest).map(([dataset, event]) => [dataset, Object.hasOwn(okxSourceSchemas, dataset) ? projectEvent(event, okxSourceSchemas[dataset as keyof typeof okxSourceSchemas]) : event]));
  }
  if (Array.isArray(record.recent_trades)) record.recent_trades = record.recent_trades.map(event => projectEvent(event, okxSourceSchemas.trades));
  if (record.book_depth != null) record.book_depth = projectSource(record.book_depth, { bids: decimal, asks: decimal });
  return JSON.stringify(record, null, 2);
}
