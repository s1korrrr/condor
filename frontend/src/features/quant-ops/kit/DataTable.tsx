import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flexRender, getCoreRowModel, getFilteredRowModel, getSortedRowModel, sortingFns, useReactTable, type ColumnDef, type ColumnFiltersState, type FilterFn, type SortingState } from '@tanstack/react-table';
import { numericFilterMatch, searchMatch } from './table-filter';
import { cleanFloat } from '../decimal-display';
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
  /** Fixed ascending group key; sorted values stay inside their group in either direction. */
  sortGroup?: (row: T) => string | number;
};

export type TableSelection<T> = {
  /** Stable row IDs from `rowId`; selection remains controlled by the caller across filtering. */
  selected: ReadonlySet<string>;
  onSelect: (keys: string[], selected: boolean) => void;
  label: (row: T) => string;
};

function compareSortGroup(left: string | number, right: string | number): number {
  if (left === right) return 0;
  if (typeof left === 'number' && Number.isFinite(left) && typeof right === 'number' && Number.isFinite(right)) {
    return left < right ? -1 : 1;
  }
  return String(left).localeCompare(String(right));
}

const textFilter: FilterFn<unknown> = (row, columnId, filter) => String(row.getValue(columnId) ?? '').toLowerCase().includes(String(filter).trim().toLowerCase());
const numberFilter: FilterFn<unknown> = (row, columnId, filter) => numericFilterMatch(row.getValue(columnId), String(filter));

const numeric = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};
/** CSV cell with quoting and formula-injection protection; signed numbers stay numbers. */
const csvCell = (value: unknown) => {
  // Float-math numbers must not export binary noise (see cleanFloat); strings stay exact.
  let text = typeof value === 'number' && Number.isFinite(value) ? cleanFloat(value) : String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text) && numeric(text) === null) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const RESIZE_STEP = 16;

export function DataTable<T>({ rows, columns, rowId, label, initialSort, pageSize = 12, emptyText = 'No rows.', exportName, exportMetadata, maxHeight = 480, rowState, pinned, dense = false, searchable = true, selection, onRowsChange }: {
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
  /** Per-export values or row-specific provenance appended without changing the table view. */
  exportMetadata?: Record<string, string | number | null | ((row: T) => string | number | null)>;
  /** Scroll height; the header row stays visible while the body scrolls. */
  maxHeight?: number;
  /** Optional `data-state` per row (for example a highlighted or stale row). */
  rowState?: (row: T) => string | undefined;
  /** Rows kept at the top in any sort and never hidden behind "Show all" (for example a selected asset). */
  pinned?: (row: T) => boolean;
  dense?: boolean;
  /** Show the built-in global search input. Defaults to true. */
  searchable?: boolean;
  /** Controlled checkboxes keyed by the stable ID returned from `rowId`. */
  selection?: TableSelection<T>;
  /** All rows after search, column filtering and sorting, before pinning or pagination. */
  onRowsChange?: (rows: T[]) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ? [{ id: initialSort.id, desc: initialSort.desc ?? false }] : []);
  const [filters, setFilters] = useState<ColumnFiltersState>([]);
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const effectiveSearch = searchable ? search : '';
  const definitions = useMemo<ColumnDef<T>[]>(() => columns.map(column => ({
    id: column.id,
    header: column.header,
    // Missing values are undefined so `sortUndefined: 'last'` keeps them last in either direction.
    accessorFn: row => {
      const value = column.value(row);
      return column.sortGroup && value == null ? null : value ?? undefined;
    },
    size: column.size ?? (column.kind === 'number' ? 120 : 150),
    minSize: column.minSize ?? 64,
    sortingFn: column.sortGroup ? (a, b, id) => {
      const groupOrder = compareSortGroup(column.sortGroup!(a.original), column.sortGroup!(b.original));
      if (groupOrder !== 0) {
        // TanStack reverses the comparator for descending sorts; compensate so groups stay fixed.
        return sorting.find(item => item.id === id)?.desc ? -groupOrder : groupOrder;
      }
      const descending = sorting.find(item => item.id === id)?.desc ?? false;
      if (column.kind !== 'number') {
        const x = a.getValue(id), y = b.getValue(id);
        return x != null && y != null ? sortingFns.alphanumeric(a, b, id)
          : x != null ? (descending ? 1 : -1) : y != null ? (descending ? -1 : 1) : 0;
      }
      const x = numeric(a.getValue(id)), y = numeric(b.getValue(id));
      return x !== null && y !== null ? x - y : x !== null ? (descending ? 1 : -1) : y !== null ? (descending ? -1 : 1) : 0;
    } : column.kind === 'number' ? (a, b, id) => {
      const x = numeric(a.getValue(id)), y = numeric(b.getValue(id));
      return x !== null && y !== null ? x - y : x !== null ? 1 : y !== null ? -1 : 0;
    } : 'alphanumeric',
    sortUndefined: column.sortGroup ? false : 'last',
    filterFn: (column.kind === 'number' ? numberFilter : textFilter) as FilterFn<T>,
    meta: column,
  })), [columns, sorting]);
  // Search runs before the table so it can match displayed text as well as raw values.
  const searched = useMemo(() => effectiveSearch.trim() ? rows.filter(row => searchMatch(columns.flatMap(column => {
    const shown = column.cell?.(row);
    return [column.value(row), typeof shown === 'string' || typeof shown === 'number' ? shown : null];
  }), effectiveSearch)) : rows, [rows, columns, effectiveSearch]);
  const table = useReactTable({
    data: searched, columns: definitions, getRowId: rowId,
    state: { sorting, columnFilters: filters },
    onSortingChange: setSorting, onColumnFiltersChange: setFilters,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(),
    enableColumnResizing: true, columnResizeMode: 'onChange',
  });
  const sortedRows = table.getRowModel().rows;
  const onRowsChangeRef = useRef(onRowsChange);
  const reportedRows = useRef<T[] | null>(null);
  const hasRowsChange = typeof onRowsChange === 'function';
  useEffect(() => {
    onRowsChangeRef.current = onRowsChange;
    if (!onRowsChange) reportedRows.current = null;
  }, [onRowsChange]);
  useEffect(() => {
    const callback = onRowsChangeRef.current;
    if (!callback) return;
    const nextRows = sortedRows.map(row => row.original);
    const previous = reportedRows.current;
    if (previous?.length === nextRows.length && previous.every((row, index) => row === nextRows[index])) return;
    reportedRows.current = nextRows;
    callback(nextRows);
  }, [sortedRows, hasRowsChange]);
  const visible = useMemo(() => pinned ? [...sortedRows.filter(row => pinned(row.original)), ...sortedRows.filter(row => !pinned(row.original))] : sortedRows,
    [pinned, sortedRows]);
  const pinnedCount = pinned ? visible.filter(row => pinned(row.original)).length : 0;
  const shown = expanded ? visible : visible.slice(0, Math.max(pageSize, pinnedCount));
  const filtered = effectiveSearch.trim() !== '' || filters.length > 0;
  const initialSorting = initialSort ? `${initialSort.id}:${initialSort.desc ? 'desc' : 'asc'}` : '';
  const changed = filtered || sorting.map(item => `${item.id}:${item.desc ? 'desc' : 'asc'}`).join(',') !== initialSorting || Object.keys(table.getState().columnSizing).length > 0;
  const exportCsv = () => {
    const metadata = Object.entries(exportMetadata ?? {});
    const exportStateHeaders = exportMetadata === undefined ? [] : [
      'table_search', 'table_column_filters', 'table_sort', 'table_exported_count', 'table_row_id',
    ];
    const header = [...columns.map(column => column.header), ...metadata.map(([key]) => key), ...exportStateHeaders].map(csvCell).join(',');
    const body = visible.map(row => [
      ...columns.map(column => column.value(row.original)),
      ...metadata.map(([, value]) => typeof value === 'function' ? value(row.original) : value),
      ...(exportMetadata === undefined ? [] : [effectiveSearch, JSON.stringify(filters), JSON.stringify(sorting), visible.length, row.id]),
    ].map(csvCell).join(','));
    const url = URL.createObjectURL(new Blob([[header, ...body].join('\n')], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url; link.download = exportName ?? 'table.csv'; link.click();
    URL.revokeObjectURL(url);
  };
  return <div className={`q-dt${dense ? ' q-dt--dense' : ''}`}>
    <div className="q-dt__bar">
      {searchable && <input className="q-dt__search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search rows…" aria-label={`Search ${label}`} />}
      <button type="button" className="q-chip" aria-pressed={showFilters} onClick={() => setShowFilters(value => !value)} title="Per-column filters. Number columns accept >, <, >=, <=, = and a..b.">Filters{filters.length ? ` · ${filters.length}` : ''}</button>
      {changed && <button type="button" className="q-chip" onClick={() => { setSearch(''); setFilters([]); setSorting(initialSort ? [{ id: initialSort.id, desc: initialSort.desc ?? false }] : []); table.resetColumnSizing(); }}>Reset</button>}
      <span className="q-dt__count">{filtered ? `${visible.length} of ${rows.length}` : rows.length} row{rows.length === 1 ? '' : 's'}</span>
      {exportName && <button type="button" className="q-chip" disabled={!visible.length} onClick={exportCsv}>Export CSV</button>}
    </div>
    <div className="q-dt__scroll" role="region" aria-label={label} tabIndex={0} style={{ maxHeight }}>
      <table style={{ width: `max(100%, ${table.getTotalSize()}px)` }}>
        <colgroup>{selection && <col style={{ width: 40 }} />}{table.getVisibleLeafColumns().map(column => <col key={column.id} style={{ width: column.getSize() }} />)}</colgroup>
        <thead>
          {table.getHeaderGroups().map(group => <tr key={group.id}>
            {selection && <th scope="col" aria-label="Select rows" />}
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
          {shown.map(row => <tr key={row.id} data-state={rowState?.(row.original)} data-selected={selection?.selected.has(row.id) || undefined}>
            {selection && <td data-kind="text"><input type="checkbox" checked={selection.selected.has(row.id)} aria-label={`Select ${selection.label(row.original)}`}
              onChange={event => selection.onSelect([row.id], event.currentTarget.checked)} /></td>}
            {row.getVisibleCells().map(cell => {
              const meta = cell.column.columnDef.meta as TableColumn<T>;
              const content = meta.cell ? meta.cell(row.original) : String(cell.getValue() ?? '—');
              const raw = cell.getValue();
              const props = { 'data-kind': meta.kind ?? 'text', 'data-wrap': meta.wrap || undefined, title: meta.title?.(row.original) ?? (raw == null || raw === '' ? undefined : String(raw)), className: meta.className?.(row.original) };
              return meta.rowHeader ? <th key={cell.id} scope="row" {...props}>{content}</th> : <td key={cell.id} {...props}>{content}</td>;
            })}
          </tr>)}
          {!visible.length && <tr><td className="q-dt__empty" colSpan={columns.length + (selection ? 1 : 0)}>{rows.length ? 'No rows match the search or filters.' : emptyText}</td></tr>}
        </tbody>
      </table>
    </div>
    {visible.length > shown.length || expanded && visible.length > pageSize ? <button type="button" className="q-dt__more" onClick={() => setExpanded(value => !value)}>{expanded ? `Show first ${pageSize}` : `Show all ${visible.length} rows`}</button> : null}
  </div>;
}
