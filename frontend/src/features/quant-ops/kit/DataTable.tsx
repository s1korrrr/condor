import { useMemo, useState, type ReactNode } from 'react';
import { numericFilterMatch } from './table-filter';
import './kit.css';
import { flexRender, getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable, type ColumnDef, type ColumnFiltersState, type FilterFn, type SortingState } from '@tanstack/react-table';

/**
 * Shared data table for every dashboard page (TanStack Table). Columns sort from their header,
 * filter per column (text contains, or numeric `>`, `<`, `>=`, `<=`, `=`, `a..b`), resize by
 * dragging the header edge (double-click resets), and the whole table is searchable.
 * Values sort and filter on the raw accessor value; cells render the formatted text.
 */
export type TableColumn<T> = {
  id: string;
  header: string;
  /** Raw value used for sorting, filtering, search and CSV export. */
  value: (row: T) => string | number | null | undefined;
  /** Rendered cell; defaults to the raw value. */
  cell?: (row: T) => ReactNode;
  /** `number` right-aligns, sorts numerically and accepts comparison filters. */
  kind?: 'text' | 'number';
  size?: number;
  minSize?: number;
  /** Row header cell (`<th scope="row">`). */
  rowHeader?: boolean;
  title?: (row: T) => string | undefined;
  className?: (row: T) => string | undefined;
  /** Long prose cells wrap; every other cell stays on one line and shows its full value on hover. */
  wrap?: boolean;
};

const textFilter: FilterFn<unknown> = (row, columnId, filter) => String(row.getValue(columnId) ?? '').toLowerCase().includes(String(filter).trim().toLowerCase());
const numberFilter: FilterFn<unknown> = (row, columnId, filter) => numericFilterMatch(row.getValue(columnId), String(filter));
const globalFilter: FilterFn<unknown> = (row, columnId, filter) => String(row.getValue(columnId) ?? '').toLowerCase().includes(String(filter).trim().toLowerCase());

const csvCell = (value: unknown) => { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };

export function DataTable<T>({ rows, columns, rowId, label, initialSort, pageSize = 12, emptyText = 'No rows.', exportName, toolbar, maxHeight, rowState, dense = false }: {
  rows: T[];
  columns: TableColumn<T>[];
  rowId: (row: T, index: number) => string;
  label: string;
  initialSort?: { id: string; desc?: boolean };
  /** Rows shown before "Show all"; filters and sort apply to the full set. */
  pageSize?: number;
  emptyText?: ReactNode;
  /** CSV file name; the export holds raw values of the filtered, sorted rows. */
  exportName?: string;
  toolbar?: ReactNode;
  maxHeight?: number;
  /** Optional `data-state` per row (for example a highlighted or stale row). */
  rowState?: (row: T) => string | undefined;
  dense?: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ? [{ id: initialSort.id, desc: initialSort.desc ?? false }] : []);
  const [filters, setFilters] = useState<ColumnFiltersState>([]);
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const definitions = useMemo<ColumnDef<T>[]>(() => columns.map(column => ({
    id: column.id,
    header: column.header,
    accessorFn: row => column.value(row) ?? null,
    size: column.size ?? (column.kind === 'number' ? 120 : 150),
    minSize: column.minSize ?? 64,
    sortingFn: column.kind === 'number' ? (a, b, id) => {
      const x = Number(a.getValue(id)), y = Number(b.getValue(id));
      const fx = Number.isFinite(x), fy = Number.isFinite(y);
      return fx && fy ? x - y : fx ? 1 : fy ? -1 : 0;
    } : 'alphanumeric',
    sortUndefined: 'last',
    filterFn: (column.kind === 'number' ? numberFilter : textFilter) as FilterFn<T>,
    meta: column,
  })), [columns]);
  const table = useReactTable({
    data: rows, columns: definitions, getRowId: rowId,
    state: { sorting, columnFilters: filters, globalFilter: search },
    onSortingChange: setSorting, onColumnFiltersChange: setFilters, onGlobalFilterChange: setSearch,
    globalFilterFn: globalFilter as FilterFn<T>,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(),
    enableColumnResizing: true, columnResizeMode: 'onChange',
  });
  const visible = table.getRowModel().rows;
  const shown = expanded ? visible : visible.slice(0, pageSize);
  const filtered = search.trim() !== '' || filters.length > 0;
  const exportCsv = () => {
    const header = columns.map(column => csvCell(column.header)).join(',');
    const body = visible.map(row => columns.map(column => csvCell(column.value(row.original))).join(','));
    const url = URL.createObjectURL(new Blob([[header, ...body].join('\n')], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url; link.download = exportName ?? 'table.csv'; link.click();
    URL.revokeObjectURL(url);
  };
  return <div className={`q-dt${dense ? ' q-dt--dense' : ''}`}>
    <div className="q-dt__bar">
      <input className="q-dt__search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search rows…" aria-label={`Search ${label}`} />
      <button type="button" className="q-chip" aria-pressed={showFilters} onClick={() => setShowFilters(value => !value)} title="Per-column filters. Number columns accept >, <, >=, <=, = and a..b.">Filters{filters.length ? ` · ${filters.length}` : ''}</button>
      {(filtered || sorting.length > 0) && <button type="button" className="q-chip" onClick={() => { setSearch(''); setFilters([]); setSorting(initialSort ? [{ id: initialSort.id, desc: initialSort.desc ?? false }] : []); table.resetColumnSizing(); }}>Reset</button>}
      {toolbar}
      <span className="q-dt__count">{filtered ? `${visible.length} of ${rows.length}` : rows.length} row{rows.length === 1 ? '' : 's'}</span>
      {exportName && <button type="button" className="q-chip" disabled={!visible.length} onClick={exportCsv}>Export CSV</button>}
    </div>
    <div className="q-dt__scroll" role="region" aria-label={label} tabIndex={0} style={maxHeight ? { maxHeight } : undefined}>
      <table style={{ width: `max(100%, ${table.getTotalSize()}px)` }}>
        <colgroup>{table.getVisibleLeafColumns().map(column => <col key={column.id} style={{ width: column.getSize() }} />)}</colgroup>
        <thead>
          {table.getHeaderGroups().map(group => <tr key={group.id}>
            {group.headers.map(header => {
              const meta = header.column.columnDef.meta as TableColumn<T>;
              const sorted = header.column.getIsSorted();
              return <th key={header.id} scope="col" data-kind={meta.kind ?? 'text'} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}>
                <button type="button" className="q-dt__sort" onClick={header.column.getToggleSortingHandler()} title={`Sort by ${meta.header}`}>
                  <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                  <i aria-hidden="true">{sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}</i>
                </button>
                {showFilters && <input className="q-dt__filter" value={String(header.column.getFilterValue() ?? '')} onChange={event => header.column.setFilterValue(event.target.value || undefined)} placeholder={meta.kind === 'number' ? '>0, 1..5' : 'contains'} aria-label={`Filter ${meta.header}`} />}
                <span role="separator" aria-orientation="vertical" aria-label={`Resize ${meta.header}`} className="q-dt__resize" data-active={header.column.getIsResizing()}
                  onMouseDown={header.getResizeHandler()} onTouchStart={header.getResizeHandler()} onDoubleClick={() => header.column.resetSize()} />
              </th>;
            })}
          </tr>)}
        </thead>
        <tbody>
          {shown.map(row => <tr key={row.id} data-state={rowState?.(row.original)}>
            {row.getVisibleCells().map(cell => {
              const meta = cell.column.columnDef.meta as TableColumn<T>;
              const content = meta.cell ? meta.cell(row.original) : String(cell.getValue() ?? '—');
              const raw = cell.getValue();
              const props = { 'data-kind': meta.kind ?? 'text', 'data-wrap': meta.wrap || undefined, title: meta.title?.(row.original) ?? (raw == null || raw === '' ? undefined : String(raw)), className: meta.className?.(row.original) };
              return meta.rowHeader ? <th key={cell.id} scope="row" {...props}>{content}</th> : <td key={cell.id} {...props}>{content}</td>;
            })}
          </tr>)}
          {!visible.length && <tr><td className="q-dt__empty" colSpan={columns.length}>{rows.length ? 'No rows match the search or filters.' : emptyText}</td></tr>}
        </tbody>
      </table>
    </div>
    {visible.length > pageSize && <button type="button" className="q-dt__more" onClick={() => setExpanded(value => !value)}>{expanded ? `Show first ${pageSize}` : `Show all ${visible.length} rows`}</button>}
  </div>;
}
