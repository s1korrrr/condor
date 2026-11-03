import type { ObservationSource, PublicDataset, PublicEvent, StockCapture, StockCatalog, StockEnvelope, StockFilter, StockInstrument, StockRegion, StockRow, StockState } from './stocks-types';

export function stockKey(region: StockRegion, instrument: StockInstrument): string;
export function filterStockRows(rows: StockRow[], product: StockFilter): StockRow[];
export function selectedStock(rows: StockRow[], region: StockRegion, selected: string): StockRow | null;
export function effectiveState(source: Pick<StockEnvelope, 'state' | 'now'> | null | undefined, failed: boolean, nowMs?: number): StockState | 'unavailable';
export function publicObservation(source: ObservationSource | null | undefined, dataset: PublicDataset, failed?: boolean, nowMs?: number): PublicEvent | null;
export function stockProductLabel(instrument: StockInstrument): string;
export function fundingApplicable(instrument: StockInstrument): boolean;
export function captureEntry(region: StockRegion, identity: Pick<StockInstrument, 'instType' | 'instId'>): string;
export function stockCaptured(row: Pick<StockRow, 'captured'> | null | undefined): boolean;
export function unlistedCapture(catalog: Pick<StockCatalog, 'capture'> | null | undefined): StockCapture[];
