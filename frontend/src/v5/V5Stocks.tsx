import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RecordedCandleChart } from '@/components/charts/RecordedCandleChart';
import { DataTable, type TableColumn } from '@/features/quant-ops/kit/DataTable';
import { readStockOwner } from './stocks-api';
import { captureEntry, effectiveState, filterStockRows, fundingApplicable, publicObservation, selectedStock, stockCaptured, stockKey, stockProductLabel, unlistedCapture } from './stocks-model.mjs';
import type { PublicEvent, StockCatalog, StockCandles, StockChannel, StockFilter, StockInstrument, StockMarket, StockRange, StockRegion, StockRow } from './stocks-types';
import './stocks.css';

const utc = (seconds: number | null | undefined) => seconds == null ? 'Unavailable' : new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
const value = (item: unknown) => typeof item === 'string' && item !== '' ? item : typeof item === 'number' && Number.isFinite(item) ? String(item) : 'Unavailable';
const field = (event: PublicEvent | null, name: string) => value(event?.data[name]);
const readable = (state: string) => state === 'live' || state === 'stale';

function metadataTime(stamp: unknown) {
  if (typeof stamp !== 'string' || !/^\d+$/.test(stamp)) return 'Unavailable';
  const millis = Number(stamp);
  return Number.isSafeInteger(millis) && millis > 0 && millis <= 4102444800000 ? utc(millis / 1000) : 'Unavailable';
}

function Observation({ label, event, name, unit, notApplicable = false }: { label: string; event: PublicEvent | null; name: string; unit: string; notApplicable?: boolean }) {
  return <div className="v5-stock-observation"><dt>{label}</dt><dd className="v5-stock-value">{notApplicable ? 'Not applicable' : field(event, name)}{!notApplicable && event && <small>{unit}</small>}</dd>{event && !notApplicable && <dd className="v5-stock-caption">Source time: {utc(event.event_time_ms == null ? null : event.event_time_ms / 1000)}<br />Received: {utc(event.received_at_ms / 1000)} · {event.source.toUpperCase()}</dd>}</div>;
}

type DepthRow = { side: string; index: number; price: string; size: string; orders: string };
function depthRows(book: PublicEvent | null): DepthRow[] {
  return (['bids', 'asks'] as const).flatMap(side => {
    const levels = book?.data[side];
    return Array.isArray(levels) ? levels.filter(Array.isArray).map((level, index) => ({ side: side === 'bids' ? 'Bid' : 'Ask', index, price: value(level[0]), size: value(level[1]), orders: value(level[3]) })) : [];
  });
}

const depthColumns: TableColumn<DepthRow>[] = [
  { id: 'side', header: 'Side', value: row => row.side, rowHeader: true, size: 70 },
  { id: 'price', header: 'Price', value: row => row.price, size: 180 },
  { id: 'size', header: 'Size (venue units)', value: row => row.size, size: 180 },
  { id: 'orders', header: 'Order count', value: row => row.orders, size: 110 },
];
const tradeColumns: TableColumn<PublicEvent>[] = [
  { id: 'time', header: 'Source time (UTC)', value: event => utc(event.event_time_ms == null ? null : event.event_time_ms / 1000), rowHeader: true, size: 180 },
  { id: 'id', header: 'Trade ID', value: event => field(event, 'tradeId'), size: 130 },
  { id: 'side', header: 'Side', value: event => field(event, 'side'), size: 70 },
  { id: 'price', header: 'Price', value: event => field(event, 'px'), size: 150 },
  { id: 'size', header: 'Size (venue units)', value: event => field(event, 'sz'), size: 150 },
];
const channelColumns: TableColumn<StockChannel & { name: string }>[] = [
  { id: 'name', header: 'Public channel', value: row => row.name, rowHeader: true, size: 150 },
  { id: 'state', header: 'Collection state', value: row => row.state, size: 100 },
  { id: 'age', header: 'Receipt age at evaluation (s)', value: row => row.age_s, kind: 'number', size: 120 },
  { id: 'source', header: 'Source time (UTC)', value: row => utc(row.event_time_ms == null ? null : row.event_time_ms / 1000), size: 180 },
  { id: 'received', header: 'Received (UTC)', value: row => utc(row.received_at_ms == null ? null : row.received_at_ms / 1000), size: 180 },
  { id: 'reason', header: 'Reason', value: row => row.reason, wrap: true, size: 200 },
];

function InstrumentMetadata({ instrument }: { instrument: StockInstrument }) {
  const spot = instrument.instType === 'SPOT';
  return <details className="v5-stock-details"><summary>Instrument metadata</summary><dl className="v5-stock-metadata">
    <div><dt>Underlying</dt><dd>{value(instrument.uly)}</dd></div>
    <div><dt>Quote / settlement</dt><dd>{value(instrument.quoteCcy)} / {spot ? 'Not applicable' : value(instrument.settleCcy)}</dd></div>
    <div><dt>Contract value / multiplier</dt><dd>{spot ? 'Not applicable' : `${value(instrument.ctVal)} ${value(instrument.ctValCcy)} / ${value(instrument.ctMult)}`}</dd></div>
    <div><dt>Tick / lot / minimum size</dt><dd>{value(instrument.tickSz)} / {value(instrument.lotSz)} / {value(instrument.minSz)}</dd></div>
    <div><dt>Listed (UTC)</dt><dd>{metadataTime(instrument.listTime)}</dd></div>
    <div><dt>Expiry (UTC)</dt><dd>{spot || instrument.instType === 'SWAP' ? 'Not applicable' : metadataTime(instrument.expTime)}</dd></div>
  </dl><details><summary>All public instrument fields</summary><pre className="v5-stock-json">{JSON.stringify(instrument, null, 2)}</pre></details></details>;
}

function NotCaptured({ region, instrument }: { region: StockRegion; instrument: StockInstrument }) {
  return <section className="v5-stock-notice" aria-label="Capture status"><h3>Listed but not captured</h3><p>{instrument.instId} is in the OKX {region.toUpperCase()} stock catalog, but the collector does not capture its public data. No prices, order book, trades or candles are recorded for it, so no chart is shown. This is not a data gap.</p><p>To capture it, add this exact entry to the collector's <code>--stocks-instruments</code> allowlist (region:instType:instId, at most 64 per region): <code className="v5-stock-entry">{captureEntry(region, instrument)}</code></p></section>;
}

export function V5Stocks({ configured, profilePending = false, profileError = null }: { configured: boolean; profilePending?: boolean; profileError?: Error | null }) {
  const [region, setRegion] = useState<StockRegion>('eea');
  const [product, setProduct] = useState<StockFilter>('ALL');
  const [selected, setSelected] = useState('');
  const [range, setRange] = useState<StockRange>('24h');
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNowMs(Date.now()), 10000); return () => clearInterval(timer); }, []);

  const catalog = useQuery({ queryKey: ['stock-catalog', region], queryFn: ({ signal }) => readStockOwner<StockCatalog>('stocks', { region }, signal), enabled: configured && !profileError, retry: false, refetchInterval: 30000 });
  const snapshot = configured && !profileError && !catalog.isError && catalog.data?.region === region ? catalog.data : null;
  const state = effectiveState(snapshot, catalog.isError, nowMs);
  const rows = filterStockRows(snapshot?.rows ?? [], product);
  const selectedRow = selectedStock(rows, region, selected);
  const instrument = selectedRow?.instrument ?? null;
  const ownerReady = !!snapshot && readable(state);
  // Listed-only instruments have no captured data, so they get no market or candle reads.
  const captureReady = ownerReady && stockCaptured(selectedRow);
  const unlisted = snapshot ? unlistedCapture(snapshot) : [];
  const identity = instrument ? { region, instId: instrument.instId, instType: instrument.instType } : null;
  const market = useQuery({ queryKey: ['stock-market', region, instrument?.instType, instrument?.instId], queryFn: ({ signal }) => readStockOwner<StockMarket>('stock-market', identity!, signal), enabled: captureReady && !!identity, retry: false, refetchInterval: 30000 });
  const candles = useQuery({ queryKey: ['stock-candles', region, instrument?.instType, instrument?.instId, range], queryFn: ({ signal }) => readStockOwner<StockCandles>('stock-candles', { ...identity!, range }, signal), enabled: captureReady && !!identity, retry: false, refetchInterval: 30000 });
  const matches = (data: { region: StockRegion; instType: string; instId: string } | undefined) => !!identity && !!data && data.region === identity.region && data.instType === identity.instType && data.instId === identity.instId;
  const marketRead = captureReady && !market.isError && matches(market.data) ? market.data! : null;
  const chartRead = captureReady && !candles.isError && matches(candles.data) && candles.data?.range === range ? candles.data! : null;
  // The selected read can also report that the owner no longer captures this identity.
  const notCaptured = ownerReady && !!instrument && (!captureReady || marketRead?.captured === false || chartRead?.captured === false);
  const detail = notCaptured || marketRead?.captured !== true ? null : marketRead;
  const chart = notCaptured || chartRead?.captured !== true ? null : chartRead;
  const marketState = effectiveState(detail, market.isError, nowMs);
  const chartState = effectiveState(chart, candles.isError, nowMs);
  const ticker = publicObservation(detail, 'ticker', market.isError, nowMs);
  const funding = publicObservation(detail, 'funding', market.isError, nowMs);
  const openInterest = publicObservation(detail, 'open_interest', market.isError, nowMs);
  const book = publicObservation(detail, 'books', market.isError, nowMs);
  const trades = detail && readable(marketState) && ['live', 'stale'].includes(detail.channels.trades?.state) ? detail.recent_trades : [];
  const failures = [{ name: 'Catalog', query: catalog }, ...(captureReady && instrument ? [{ name: 'Public observations', query: market }, { name: 'Candles', query: candles }] : [])].filter(item => item.query.isError);
  const refresh = () => { void catalog.refetch(); if (captureReady && instrument) { void market.refetch(); void candles.refetch(); } };

  const columns: TableColumn<StockRow>[] = [
    { id: 'instrument', header: 'Exact instrument ID', rowHeader: true, value: row => row.instrument.instId, size: 210, cell: row => <button type="button" className="v5-stock-select" onClick={() => setSelected(stockKey(region, row.instrument))}>{row.instrument.instId}</button> },
    { id: 'product', header: 'Product', value: row => stockProductLabel(row.instrument), size: 165 },
    { id: 'capture', header: 'Capture', value: row => stockCaptured(row) ? 'Captured' : 'Not captured', size: 110 },
    { id: 'rule', header: 'Rule type', value: row => row.instrument.ruleType, size: 95 },
    { id: 'state', header: 'Instrument state', value: row => row.instrument.state, size: 100 },
    { id: 'quote', header: 'Quote / settlement', value: row => `${value(row.instrument.quoteCcy)} / ${row.instrument.instType === 'SPOT' ? 'N/A' : value(row.instrument.settleCcy)}`, size: 140 },
    { id: 'last', header: 'Last recorded trade price', value: row => field(publicObservation(snapshot ? { ...row, now: snapshot.now, state: snapshot.state } : null, 'ticker', catalog.isError, nowMs), 'last'), size: 150 },
    { id: 'channel', header: 'Ticker state', value: row => !ownerReady ? 'Unavailable' : !stockCaptured(row) ? 'Not captured' : row.channels.ticker?.state ?? 'Unavailable', size: 100 },
    { id: 'age', header: 'Ticker receipt age at evaluation (s)', value: row => ownerReady ? row.channels.ticker?.age_s : null, kind: 'number', size: 120 },
    { id: 'from', header: 'Candles from (UTC)', value: row => utc(row.coverage.candle_start), size: 180 },
    { id: 'through', header: 'Candles through (UTC)', value: row => utc(row.coverage.candle_end), size: 180 },
  ];

  return <div className="v5-stock-market">
    <header className="v5-stock-heading"><div><h2>OKX stocks</h2><p>Public market observations · exact venue instruments · UTC</p></div><button type="button" className="v5-button" disabled={!configured || !!profileError || catalog.isFetching} onClick={refresh}>{catalog.isFetching ? 'Refreshing…' : 'Refresh'}</button></header>
    <p className="v5-stock-caption">Spot tokenized stocks, perpetuals and dated futures remain separate. Public data does not establish account trading eligibility. Prices are raw observations; no corporate-action adjustment or currency conversion is applied.</p>
    <div className="v5-stock-controls"><label>Region<select aria-label="Region" value={region} onChange={event => { setRegion(event.target.value as StockRegion); setSelected(''); }}><option value="eea">EEA</option><option value="global">Global</option></select></label><label>Product<select aria-label="Product" value={product} onChange={event => { setProduct(event.target.value as StockFilter); setSelected(''); }}><option value="ALL">All products</option><option value="SPOT">Spot · SPOT</option><option value="SWAP">Perpetual · SWAP</option><option value="FUTURES">Futures / X-Perps · FUTURES</option></select></label></div>
    {profilePending ? <p role="status">Loading market data configuration…</p> : profileError ? <p role="alert">Market data configuration is unavailable: {profileError.message}. No stock observations are shown.</p> : !configured ? <section className="v5-stock-notice"><h3>Stock data is not configured</h3><p>The recorded market data source is not connected to this workspace. No catalog, prices or coverage are available.</p></section> : <>
      {failures.length > 0 && <p role="alert" className="v5-stock-notice">Stock data read unavailable: {failures.map(item => `${item.name}: ${item.query.error?.message ?? 'No owner response'}`).join('; ')}. Checked {utc(Math.max(...failures.map(item => item.query.errorUpdatedAt)) / 1000)} by the dashboard. Failed views clear previous price observations. Use Refresh to retry.</p>}
      {catalog.isPending && <p role="status">Loading {region.toUpperCase()} stock catalog…</p>}
      {snapshot && <>
        <section className="v5-stock-notice" aria-label="Stock collection state"><h3>{state === 'live' ? 'Recorded public data' : state === 'stale' ? 'Stale observations' : state === 'empty' ? 'No classified stock instruments' : state === 'disabled' ? 'Stock collection is disabled' : state === 'starting' ? 'Stock collection is starting' : 'Stock collection is unavailable'} · {region.toUpperCase()}</h3><p>Collection state: {snapshot.state}. Evaluated {utc(snapshot.now)} · catalog {utc(snapshot.catalog_at)} · last collection update {utc(snapshot.updated_at)}.</p>{snapshot.reason && <p>Collection status: {snapshot.reason}</p>}{state === 'stale' && <p>These observations may be old. Check each source and receipt timestamp before use.</p>}{state === 'empty' && <p>The successful discovery returned no instruments classified by OKX as stocks for this region.</p>}{state === 'error' && <p>Any retained catalog rows are metadata only. Current prices and chart observations are unavailable.</p>}{snapshot.discovery && !snapshot.discovery.complete && <p role="alert">The catalog is incomplete. Missing or unclassified instruments are not evidence that a product is unavailable. {snapshot.discovery.warnings.join('; ')}</p>}{snapshot.state !== 'disabled' && snapshot.capture.length === 0 && <p>Discovery only: the collector's capture allowlist has no {region.toUpperCase()} instruments, so no prices or candles are recorded.</p>}</section>
        {unlisted.length > 0 && <section className="v5-stock-notice" aria-label="Capture allowlist"><p role="alert">{unlisted.length === 1 ? '1 capture allowlist entry is' : `${unlisted.length} capture allowlist entries are`} not in the current {region.toUpperCase()} catalog and record nothing: {unlisted.map(entry => <code key={captureEntry(region, entry)} className="v5-stock-entry">{captureEntry(region, entry)}</code>)}. Check the exact instrument ID and type.</p></section>}
        {snapshot.rows.length > 0 && <section><h3>Instruments</h3><p className="v5-stock-caption">{rows.length} observed instruments match this product filter; {rows.filter(stockCaptured).length} are captured. Ages below are evaluated by the collector at {utc(snapshot.now)}; collector liveness is separate from candle coverage.</p><DataTable rows={rows} columns={columns} rowId={row => stockKey(region, row.instrument)} label="OKX stock instruments" emptyText="No observed instruments match the selected product. Choose another product or region." pinned={row => !!instrument && stockKey(region, row.instrument) === stockKey(region, instrument)} /></section>}
      </>}
      {instrument && <section className="v5-stock-selection" aria-label="Selected stock instrument"><div className="v5-stock-controls"><label>Instrument<select aria-label="Instrument" value={stockKey(region, instrument)} onChange={event => setSelected(event.target.value)}>{rows.map(row => <option key={stockKey(region, row.instrument)} value={stockKey(region, row.instrument)}>{row.instrument.instId} · {stockProductLabel(row.instrument)}{stockCaptured(row) ? '' : ' · not captured'}</option>)}</select></label><label>Candle range<select aria-label="Candle range" value={range} onChange={event => setRange(event.target.value as StockRange)}>{(['1h', '6h', '24h', '7d'] as const).map(span => <option key={span} value={span}>{span}</option>)}</select></label></div><h3>{instrument.instId}</h3><p className="v5-stock-caption">{stockProductLabel(instrument)} · rule type {value(instrument.ruleType)} · instrument state {value(instrument.state)} · price currency {value(instrument.quoteCcy)}</p>
        {!ownerReady ? <p>Price observations are unavailable until the collector provides a valid catalog state.</p> : notCaptured ? <NotCaptured region={region} instrument={instrument} /> : <>
          {candles.isPending && <p role="status">Loading recorded trade candles…</p>}
          {chart && (readable(chartState) || chartState === 'empty') && <><RecordedCandleChart buckets={chart.buckets} label={`OKX ${region.toUpperCase()} · ${stockProductLabel(instrument)} · ${instrument.instId} · raw trade price`} volumeUnit={chart.volume_unit} /><p className="v5-stock-caption">{chartState === 'stale' ? 'Stale read · ' : ''}Evaluated {utc(chart.now)} · 1m · raw, unadjusted trade prices · volume in {chart.volume_unit}. Selected range only: {Object.entries(chart.totals).map(([name, count]) => `${name}: ${count}`).join(' · ')}.</p>{chart.totals.final === 0 && <p>No recorded final trade prices in this range. Missing, pending and no-trade minutes remain gaps.</p>}</>}
          {chart && !readable(chartState) && chartState !== 'empty' && <p>Recorded candles unavailable: {chart.state}{chart.reason ? ` · ${chart.reason}` : ''}.</p>}
          {market.isPending && <p role="status">Loading public observations…</p>}
          {detail && <section><h3>Selected public observations · {marketState}</h3><p className="v5-stock-caption">Evaluated {utc(detail.now)}. Last trade, mark and index prices are separate sources. Capture began {utc(detail.coverage.capture_started_at)}; complete historical trades and books are not available.</p>{detail.reason && <p>Collection status: {detail.reason}</p>}
            <dl className="v5-stock-observations">
              <Observation label="Last trade price" event={ticker} name="last" unit={value(instrument.quoteCcy)} />
              <Observation label="Best bid" event={ticker} name="bidPx" unit={value(instrument.quoteCcy)} />
              <Observation label="Best ask" event={ticker} name="askPx" unit={value(instrument.quoteCcy)} />
              <Observation label="Mark price" event={publicObservation(detail, 'mark_price', market.isError, nowMs)} name="markPx" unit={value(instrument.quoteCcy)} notApplicable={instrument.instType === 'SPOT'} />
              <Observation label="Index price" event={publicObservation(detail, 'index_price', market.isError, nowMs)} name="idxPx" unit={value(instrument.quoteCcy)} notApplicable={instrument.instType === 'SPOT'} />
              <Observation label="Funding rate" event={funding} name="fundingRate" unit="fraction" notApplicable={!fundingApplicable(instrument)} />
              <Observation label="Open interest" event={openInterest} name="oi" unit="contracts" notApplicable={instrument.instType === 'SPOT'} />
            </dl>
            <details className="v5-stock-details"><summary>Ticker and derivatives fields</summary>
              <dl className="v5-stock-observations">
                <Observation label="24h open" event={ticker} name="open24h" unit={value(instrument.quoteCcy)} />
                <Observation label="24h high" event={ticker} name="high24h" unit={value(instrument.quoteCcy)} />
                <Observation label="24h low" event={ticker} name="low24h" unit={value(instrument.quoteCcy)} />
                <Observation label="24h volume" event={ticker} name="vol24h" unit={instrument.instType === 'SPOT' ? value(instrument.baseCcy) : 'contracts'} />
                <Observation label="24h currency volume" event={ticker} name="volCcy24h" unit={instrument.instType === 'SPOT' ? value(instrument.quoteCcy) : 'venue volCcy24h units'} />
                <Observation label="Open interest in currency" event={openInterest} name="oiCcy" unit="venue base currency units" notApplicable={instrument.instType === 'SPOT'} />
                <Observation label="Open interest in USD" event={openInterest} name="oiUsd" unit="USD, as reported by OKX" notApplicable={instrument.instType === 'SPOT'} />
                <div className="v5-stock-observation"><dt>Funding settlement (UTC)</dt><dd>{fundingApplicable(instrument) ? metadataTime(funding?.data.fundingTime) : 'Not applicable'}</dd><dt>Next funding settlement (UTC)</dt><dd>{fundingApplicable(instrument) ? metadataTime(funding?.data.nextFundingTime) : 'Not applicable'}</dd></div>
              </dl>
              <p className="v5-stock-caption">Volume and open-interest fields retain the venue's units. Funding is a raw fraction; settlement times are separate from source and receipt times. No conversion or annualization is applied.</p>
            </details>
            <details className="v5-stock-details"><summary>Public order book{book && detail.book_depth ? ` · ${detail.book_depth.bids} bids / ${detail.book_depth.asks} asks` : ' · unavailable'}</summary><p className="v5-stock-caption">Up to 50 levels per side from the recorded standard public book. Size is {instrument.instType === 'SPOT' ? 'in the base asset' : 'in derivative contracts'}. A stream gap removes the current book until a new snapshot arrives.</p><DataTable rows={depthRows(book)} columns={depthColumns} rowId={row => `${row.side}/${row.index}`} label="Selected stock public order book" emptyText="No continuous public order book is available." /></details>
            <details className="v5-stock-details"><summary>Recent captured trades · {trades.length}</summary><p className="v5-stock-caption">Up to 50 captured observations; this is not a complete historical trade record. Size is {instrument.instType === 'SPOT' ? 'in the base asset' : 'in derivative contracts'}.</p><DataTable rows={trades} columns={tradeColumns} rowId={(event, index) => `${event.received_at_ms}/${index}`} label="Selected stock recent trades" emptyText="Recent trade observations are unavailable." /></details>
            <details className="v5-stock-details"><summary>Channel freshness and coverage</summary><DataTable rows={Object.entries(detail.channels).map(([name, channel]) => ({ name, ...channel }))} columns={channelColumns} rowId={row => row.name} label="Selected stock channel freshness" emptyText="No channel status is available." /><p className="v5-stock-caption">Recorded candles: {utc(detail.coverage.candle_start)} through {utc(detail.coverage.candle_end)}. Funding settlement times in source records describe settlement, not observation freshness.</p></details>
            <details className="v5-stock-details"><summary>All recorded market fields</summary><p className="v5-stock-caption">Exact public source fields and decimal strings for the selected instrument. Unavailable channels are null. Books are the bounded display projection, and trades are the recent captured observations shown above.</p><pre className="v5-stock-json">{JSON.stringify({ latest: Object.fromEntries((['ticker', 'mark_price', 'index_price', 'funding', 'open_interest', 'books'] as const).map(dataset => [dataset, publicObservation(detail, dataset, market.isError, nowMs)])), recent_trades: trades, book_depth: book ? detail.book_depth : null }, null, 2)}</pre></details>
          </section>}
        </>}
        <InstrumentMetadata instrument={instrument} />
      </section>}
    </>}
  </div>;
}
