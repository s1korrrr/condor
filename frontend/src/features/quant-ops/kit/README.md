# Dashboard kit

Shared layout, chart and table building blocks for every Condor dashboard page
(Capital, Bots, Fleet, Trading Visuals, Operations, Research). New panels use
these parts instead of page-local markup, so every page stays adaptive,
consistent and short.

| Need | Use | Library |
| --- | --- | --- |
| Row of KPI or stat tiles | `TileGrid` (`grid.tsx`) with `MetricCard` / `StatStrip` | — |
| Time series (one or more lines, secondary scale, markers) | `TimeSeriesChart` (`charts.tsx`) | Recharts |
| Daily bars, histograms, signed bars with a line | `BarsChart` | Recharts |
| Composition | `DonutChart` (or `Donut` in `primitives.tsx` for asset colors) | Recharts |
| Share of a population as a ring ("2 of 5 above EMA21") | `RingGauge` (`gauges.tsx`) in a `TileGrid` | SVG |
| Trend inside a tile | `SparkChart` / `Sparkline` | Recharts |
| Any table | `DataTable` (`DataTable.tsx`) | TanStack Table |

Pure logic lives in `.ts` files (`layout.ts`, `series.ts`, `table-filter.ts`)
so it is unit-tested in `test/quant-kit.test.mjs` without a browser.

## Rules

1. **Tiles fill their rows.** `TileGrid` picks the column count from the
   measured width and the tile minimum, then balances rows (10 tiles become
   2 × 5, 6 become 2 × 3). A short last row stretches edge to edge. Phones
   use two compact columns. Choose tile counts that divide well (6, 10, 12).
2. **Text never leaves its tile.** Each tile cell is a size container: values
   scale with `cqi` units, labels wrap before they truncate, and any truncated
   value or note carries its full text in `title`.
3. **Every plot is hoverable.** Charts show a crosshair and one tooltip style
   with the UTC time and each series' value. No sliders for inspection.
4. **Gaps stay gaps.** Null values split lines; the tooltip reports a gap, or
   the latest sample with an "as of" time when the cursor is between samples.
   Never interpolate or draw a missing value as zero.
5. **Tables are DataTables.** Sortable headers, per-column filters (numbers
   accept `>`, `<`, `>=`, `<=`, `=`, `a..b`), global search (optional per
   table), drag-to-resize columns (double-click resets), sticky headers and
   CSV export of the raw filtered and sorted values. Optional controlled row
   selection uses stable `rowId` values and does not narrow CSV exports.
   `sortGroup` keeps related values together in a fixed group order, even when
   the value sort is descending. `onRowsChange` reports all sorted and filtered
   rows before pinning and pagination, after render. Sort and filter on raw
   values; format in `cell`. `exportMetadata` appends constant or row-specific
   provenance without changing the visible columns or the exported row scope.
6. **Truth states stay visible.** Every tile and panel keeps its `PanelState`
   glyph. Unavailable, stale and collecting values are labelled, never zero.
7. **Colors come from tokens.** Use `CHART` / `--q-*` tokens and `assetColor`
   for assets, so a symbol keeps its color on every page.

## Table options added for Tradepad

- `selection` adds a leading checkbox column. The page owns the selected ids (`selected`) and receives the ids to add
  or remove (`onSelect`); the header box selects or clears every filtered row. Selected rows carry `data-selected`.
- `sortGroup` on a column keeps groups in a fixed order in both sort directions and sorts rows inside each group, so
  values that must not be ranked together (returns on different bases) are never interleaved.
- `onRowsChange` receives the filtered, sorted rows whenever they change, so tiles beside the table summarize exactly
  what the table shows, column filters included.
- `searchable={false}` hides the table search on a page that has its own search; column filters stay.
- `rowState` may return `muted` for rows that lack full evidence (for example metrics-only backtests).

## Time-series options added for the Market home

- `signSplit` on a series draws one signed value green above zero and red below it (breadth pressure,
  net flow); the tooltip still shows a single row. `fillOpacity` tunes the area strength.
- `tooltipOnly` lists a series in the tooltip (with its own axis scale) without drawing it.
- `domains` on `TimeSeriesChart` fixes an axis range, for example pressure -3..+3 beside a 0..100% share.
- `zoom` / `onZoom` on `TimeSeriesChart` turn on drag-to-zoom: a drag across the plot selects a UTC range,
  a double-click resets it. The caller owns the range, so several charts can share one zoom. The value
  axis fits what is visible. Offer a visible reset control as well; double-click is not discoverable.
- `TooltipCard` is exported so custom plots (scatter, SVG timelines) use the same tooltip as the kit.
