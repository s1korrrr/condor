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
   accept `>`, `<`, `>=`, `<=`, `=`, `a..b`), global search, drag-to-resize
   columns (double-click resets), sticky headers and CSV export of the raw
   values. Sort and filter on raw values; format in `cell`.
6. **Truth states stay visible.** Every tile and panel keeps its `PanelState`
   glyph. Unavailable, stale and collecting values are labelled, never zero.
7. **Colors come from tokens.** Use `CHART` / `--q-*` tokens and `assetColor`
   for assets, so a symbol keeps its color on every page.
