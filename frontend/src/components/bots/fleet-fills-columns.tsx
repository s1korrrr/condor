import { Link } from 'react-router-dom';
import { botChartsHref } from '@/features/bots/chart-links';
import { RECEIPT_LABEL, RECEIPT_TITLE, fleetFillBotName, fleetFillTime } from '@/features/bots/fleet-fills-model';
import { formatDecimal, formatSigned, metricTone } from '@/features/quant-ops/format';
import type { TableColumn } from '@/features/quant-ops/kit/DataTable';
import type { FleetFillItem } from '@/lib/fleet-fills';

const NOT_REPORTED = 'The owner did not report this value.';

/** One row per fill, every bot. Raw values (exact decimal strings) sort, filter and export; `cell` only formats. */
export const fleetFillColumns: TableColumn<FleetFillItem>[] = [
  { id: 'time', header: 'Recorded (UTC)', value: row => fleetFillTime(row.time_ms), cell: row => fleetFillTime(row.time_ms) ?? '—', title: row => row.time_ms === null ? 'The owner stamp has no timezone offset, so no time is guessed.' : 'Owner-recorded time, used for feed ordering.', size: 150 },
  { id: 'execution-time', header: 'Exchange executed (UTC)', value: row => fleetFillTime(row.execution_timestamp_ms ?? null), cell: row => fleetFillTime(row.execution_timestamp_ms ?? null) ?? '—', title: row => row.execution_timestamp_source === 'okx.fillTime' ? 'Attested by OKX fillTime; separate from recorded time and amount precision.' : 'Exchange execution time is unavailable for this receipt.', size: 180 },
  { id: 'bot', header: 'Bot', value: row => `${row.generation ?? ''} ${fleetFillBotName(row)}`.trim(), size: 190,
    cell: row => <>{row.generation && <span className="q-pill" title={`Bot generation ${row.generation}`}>{row.generation}</span>} {fleetFillBotName(row)}{row.paper ? <> <span className="q-pill" data-tone="blocked" title="Paper bot: a simulated fill, never part of live fills or Capital.">PAPER</span></> : row.simulated && <> <span className="q-pill" data-tone="blocked" title="The owner flagged this fill as simulated.">sim</span></>}</> },
  { id: 'side', header: 'Side', value: row => row.side?.toUpperCase(), cell: row => row.side?.toUpperCase() ?? '—', className: row => row.side === 'buy' ? 'q-positive' : row.side === 'sell' ? 'q-negative' : undefined, title: row => row.side === null ? NOT_REPORTED : undefined, size: 70 },
  { id: 'pair', header: 'Pair', value: row => row.pair, cell: row => row.pair ? <Link to={botChartsHref(row.bot, row.pair)} title={`Open ${row.pair} charts for ${row.bot}`}>{row.pair}</Link> : '—', title: row => row.pair === null ? NOT_REPORTED : undefined, size: 100 },
  { id: 'amount', header: 'Amount', kind: 'number', value: row => row.amount, cell: row => row.amount === null ? '—' : formatDecimal(row.amount, 18), title: row => row.amount === null ? NOT_REPORTED : undefined, size: 120 },
  { id: 'price', header: 'Price', kind: 'number', value: row => row.price, cell: row => row.price === null ? '—' : formatDecimal(row.price, 18), title: row => row.price === null ? NOT_REPORTED : undefined, size: 110 },
  { id: 'volume', header: 'Volume', kind: 'number', value: row => row.volume, cell: row => row.volume === null ? '—' : formatDecimal(row.volume), title: row => row.volume === null ? NOT_REPORTED : undefined, size: 100 },
  { id: 'fee', header: 'Fee', kind: 'number', value: row => row.fee, cell: row => row.fee === null ? '—' : `${formatDecimal(row.fee, 18)}${row.fee_unit ? ` ${row.fee_unit}` : ''}`, title: row => row.fee === null ? NOT_REPORTED : row.fee_unit ? `${row.fee} ${row.fee_unit}${Number(row.fee) < 0 ? ' (rebate)' : ''}` : row.fee, size: 130 },
  { id: 'receipt', header: 'Receipt', value: row => row.receipt, cell: row => <span className="q-pill" data-tone={row.receipt === 'exact' ? 'ok' : row.receipt === 'legacy_6dp' ? 'neutral' : 'flat'}>{RECEIPT_LABEL[row.receipt]}</span>, title: row => RECEIPT_TITLE[row.receipt], size: 120 },
  { id: 'pnl', header: 'PnL', kind: 'number', value: row => row.realized_pnl, cell: row => row.realized_pnl === null ? '—' : formatSigned(row.realized_pnl, 8), className: row => metricTone(row.realized_pnl) ? `q-${metricTone(row.realized_pnl)}` : undefined, title: row => row.realized_pnl === null ? 'The owner publishes no per-fill realised PnL yet.' : undefined, size: 90 },
];
