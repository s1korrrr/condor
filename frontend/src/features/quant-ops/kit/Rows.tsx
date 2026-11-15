import { Children, isValidElement, type ReactNode } from 'react';

type RowField<T> = { id: string; header: string; value: (row: T) => unknown; cell?: (row: T) => ReactNode; rowHeader?: boolean; title?: (row: T) => string | undefined; className?: (row: T) => string | undefined };

function expandedCell(content: ReactNode) {
  if (!isValidElement<{ children?: ReactNode }>(content) || content.type !== 'details') return content;
  return Children.toArray(content.props.children).filter(child => !isValidElement(child) || child.type !== 'summary');
}

function cellText(content: ReactNode): string {
  return Children.toArray(content).map(child => isValidElement<{ children?: ReactNode }>(child) ? cellText(child.props.children) : String(child)).join('');
}

export function Rows<T>({ rows, columns, rowId, label, rowState, controls }: {
  rows: T[];
  columns: RowField<T>[];
  rowId: (row: T, index: number) => string;
  label: string;
  rowState?: (row: T) => string | undefined;
  controls?: (row: T, index: number) => ReactNode;
}) {
  const primary = columns.find(column => column.rowHeader) ?? columns.find(column => column.id === 'pair') ?? columns[0];
  const secondary = columns.find(column => column.id === 'state' && column !== primary) ?? columns.find(column => column.id === 'reason' && column !== primary) ?? columns.find(column => column !== primary && !['id', 'controller', 'detail'].includes(column.id));
  return <div className="v5-phone-rows hidden" role="list" aria-label={label}>{rows.map((row, index) => <div role="listitem" key={rowId(row, index)} data-state={rowState?.(row)}>
    {controls?.(row, index)}
    <details><summary>{[primary, secondary].filter(column => column != null).map(column => <span key={column.id}><small>{column.header}</small><strong>{String(column.value(row) ?? '—')}</strong></span>)}</summary>
      <dl>{columns.map(column => {
        const raw = column.value(row);
        const content = column.cell ? expandedCell(column.cell(row)) : String(raw ?? '—');
        const rawText = raw == null ? '' : String(raw);
        const note = [column.title?.(row), column.cell && rawText !== '' && cellText(content) !== rawText ? `Raw value: ${rawText}` : undefined].filter(Boolean).join(' · ');
        return <div key={column.id}><dt>{column.header}</dt><dd className={column.className?.(row)}>{content}{note && <small className="v5-phone-row-note">{note}</small>}</dd></div>;
      })}</dl>
    </details>
  </div>)}</div>;
}
