import { useMemo, useState, type ReactNode } from 'react';
import { flexRender, getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable, type ColumnDef, type ColumnFiltersState, type FilterFn, type SortingState } from '@tanstack/react-table';
import { numericFilterMatch, searchMatch } from './table-filter';
import './kit.css';

/**
 * Shared data table for every dashboard page (TanStack Table). Columns sort from their header,
 * filter per column (text contains, or numeric `>`, `<`, `>=`, `<=`, `=`, `a..b`), resize by
 * dragging the header edge or with the arrow keys on it (double-click resets), and the whole
 * table is searchable. Sorting and column filters use the raw value; search also matches the
 * displayed text. Keep `value` in the unit the cell shows, so a filter reads like the screen.
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

const numeric = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};
/** CSV cell with quoting and formula-injection protection; signed numbers stay numbers. */
const csvCell = (value: unknown) => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text) && numeric(text) === null) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const RESIZE_STEP = 16;

export function DataTable<T>({ rows, columns, rowId, label, initialSort, pageSize = 12, emptyText = 'No rows.', exportName, maxHeight = 480, rowState, pinned, dense = false }: {
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
  /** Scroll height; the header row stays visible while the body scrolls. */
  maxHeight?: number;
  /** Optional `data-state` per row (for example a highlighted or stale row). */
  rowState?: (row: T) => string | undefined;
  /** Rows kept at the top in any sort and never hidden behind "Show all" (for example a selected asset). */
  pinned?: (row: T) => boolean;
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
    // Missing values are undefined so `sortUndefined: 'last'` keeps them last in either direction.
    accessorFn: row => column.value(row) ?? undefined,
    size: column.size ?? (column.kind === 'number' ? 120 : 150),
    minSize: column.minSize ?? 64,
    sortingFn: column.kind === 'number' ? (a, b, id) => {
      const x = numeric(a.getValue(id)), y = numeric(b.getValue(id));
      return x !== null && y !== null ? x - y : x !== null ? 1 : y !== null ? -1 : 0;
    } : 'alphanumeric',
    sortUndefined: 'last',
    filterFn: (column.kind === 'number' ? numberFilter : textFilter) as FilterFn<T>,
    meta: column,
  })), [columns]);
  // Search runs before the table so it can match displayed text as well as raw values.
  const searched = useMemo(() => search.trim() ? rows.filter(row => searchMatch(columns.flatMap(column => {
    const shown = column.cell?.(row);
    return [column.value(row), typeof shown === 'string' || typeof shown === 'number' ? shown : null];
  }), search)) : rows, [rows, columns, search]);
  const table = useReactTable({
    data: searched, columns: definitions, getRowId: rowId,
    state: { sorting, columnFilters: filters },
    onSortingChange: setSorting, onColumnFiltersChange: setFilters,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(),
    enableColumnResizing: true, columnResizeMode: 'onChange',
  });
  const sortedRows = table.getRowModel().rows;
  const visible = pinned ? [...sortedRows.filter(row => pinned(row.original)), ...sortedRows.filter(row => !pinned(row.original))] : sortedRows;
  const pinnedCount = pinned ? visible.filter(row => pinned(row.original)).length : 0;
  const shown = expanded ? visible : visible.slice(0, Math.max(pageSize, pinnedCount));
  const filtered = search.trim() !== '' || filters.length > 0;
  const initialSorting = initialSort ? `${initialSort.id}:${initialSort.desc ? 'desc' : 'asc'}` : '';
  const changed = filtered || sorting.map(item => `${item.id}:${item.desc ? 'desc' : 'asc'}`).join(',') !== initialSorting || Object.keys(table.getState().columnSizing).length > 0;
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
      {changed && <button type="button" className="q-chip" onClick={() => { setSearch(''); setFilters([]); setSorting(initialSort ? [{ id: initialSort.id, desc: initialSort.desc ?? false }] : []); table.resetColumnSizing(); }}>Reset</button>}
      <span className="q-dt__count">{filtered ? `${visible.length} of ${rows.length}` : rows.length} row{rows.length === 1 ? '' : 's'}</span>
      {exportName && <button type="button" className="q-chip" disabled={!visible.length} onClick={exportCsv}>Export CSV</button>}
    </div>
    <div className="q-dt__scroll" role="region" aria-label={label} tabIndex={0} style={{ maxHeight }}>
      <table style={{ width: `max(100%, ${table.getTotalSize()}px)` }}>
        <colgroup>{table.getVisibleLeafColumns().map(column => <col key={column.id} style={{ width: column.getSize() }} />)}</colgroup>
        <thead>
          {table.getHeaderGroups().map(group => <tr key={group.id}>
            {group.headers.map(header => {
              const meta = header.column.columnDef.meta as TableColumn<T>;
              const sorted = header.column.getIsSorted();
              const resizeBy = (delta: number) => table.setColumnSizing(sizes => ({ ...sizes, [header.column.id]: Math.max(meta.minSize ?? 64, header.column.getSize() + delta) }));
              return <th key={header.id} scope="col" data-kind={meta.kind ?? 'text'} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}>
                <button type="button" className="q-dt__sort" onClick={header.column.getToggleSortingHandler()} title={`Sort by ${meta.header}`}>
                  <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                  <i aria-hidden="true">{sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}</i>
                </button>
                {showFilters && <input className="q-dt__filter" value={String(header.column.getFilterValue() ?? '')} onChange={event => header.column.setFilterValue(event.target.value || undefined)} placeholder={meta.kind === 'number' ? '>0, 1..5' : 'contains'} aria-label={`Filter ${meta.header}`} />}
                <span role="separator" tabIndex={0} aria-orientation="vertical" aria-valuenow={Math.round(header.column.getSize())} aria-label={`Resize ${meta.header}`} className="q-dt__resize" data-active={header.column.getIsResizing()}
                  onMouseDown={header.getResizeHandler()} onTouchStart={header.getResizeHandler()} onDoubleClick={() => header.column.resetSize()}
                  onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeBy(event.key === 'ArrowLeft' ? -RESIZE_STEP : RESIZE_STEP); } else if (event.key === 'Home') { event.preventDefault(); header.column.resetSize(); } }} />
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
    {visible.length > shown.length || expanded && visible.length > pageSize ? <button type="button" className="q-dt__more" onClick={() => setExpanded(value => !value)}>{expanded ? `Show first ${pageSize}` : `Show all ${visible.length} rows`}</button> : null}
  </div>;
}
