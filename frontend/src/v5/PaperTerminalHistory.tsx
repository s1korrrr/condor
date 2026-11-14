import type { PaperRead } from './contracts';
import { DataTable, type TableColumn } from '@/features/quant-ops/kit/DataTable';
import { paperSectionError, paperTime } from './policy';
import { paperSnapshotPresentation } from './snapshot-presentation';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

export function PaperTerminalHistory({read, now}: {read?: PaperRead; now: number}) {
  const descriptor = object(object(read?.data).terminal_executors), data = object(descriptor.data);
  if (data.delivery !== 'publication_pages') return null;
  const snapshot = paperSnapshotPresentation(read?.generated_at_ms, now, false);
  const valid = read && !paperSectionError(read) && !snapshot.stale && !snapshot.clockAhead && ['complete', 'partial'].includes(read.completeness ?? '') && read.capabilities?.includes('read') && ['available', 'degraded'].includes(read.state) && Array.isArray(data.records) && data.records.every(row => typeof object(row).executor_id === 'string');
  const columns: TableColumn<Row>[] = [
    {id:'id',header:'Executor ID',value:row => String(row.executor_id),size:180},
    {id:'pair',header:'Pair',value:row => String(row.trading_pair ?? 'Not published'),size:130},
    {id:'controller',header:'Controller',value:row => String(row.controller_id ?? 'Not published'),size:180},
    {id:'reason',header:'Close reason',value:row => String(row.close_type ?? 'Not published'),size:150},
  ];
  return <section className="paper-section"><h2>Terminal executor history</h2><p className="paper-caption">Partial retained window · at most 500 terminal rows, not lifetime history. Publication pages restore only the retained owner window; totals and readiness are not inferred.</p><p className="paper-caption">{paperTime(read?.generated_at_ms, now)}{valid && Number.isInteger(data.publication_record_count) ? ` · showing the newest ${(data.records as unknown[]).length} of ${data.publication_record_count as number} published terminal rows` : ''}</p>{valid ? <DataTable rows={data.records as Row[]} columns={columns} rowId={row => String(row.executor_id)} label="Paper terminal history" pageSize={8} emptyText="No rows in this retained window; absence does not prove no terminal activity." maxHeight={360} exportName="paper-terminal-history" /> : <p role="status">Terminal records are unavailable or stale. No complete history is inferred.</p>}{read?.next_cursor && <p>More terminal records exist beyond this page.</p>}</section>;
}
