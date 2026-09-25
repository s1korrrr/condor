/** Pure tile-grid arithmetic shared by TileGrid and its tests. */
/**
 * Column count that keeps every row as full as possible: first the most tiles that fit at `minTile`,
 * then the fewest rows, then the column count that spreads tiles evenly across those rows.
 */
export function balancedColumns(count: number, width: number, minTile: number, gap: number, maxColumns = Infinity): number {
  if (count <= 1) return 1;
  // Phones: two compact columns read better than one tall stack; tile text scales with the cell.
  if (width > 0 && width < 560) return 2;
  const fit = width > 0 ? Math.max(1, Math.floor((width + gap) / (minTile + gap))) : Math.min(count, 5);
  const cap = Math.max(1, Math.min(fit, maxColumns, count));
  const rows = Math.ceil(count / cap);
  return Math.ceil(count / rows);
}

const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;

/**
 * Grid spans that fill every row edge to edge. Full rows use `columns` tiles; a shorter last row
 * stretches its tiles so the grid never ends with an empty cell.
 */
export function tileSpans(count: number, columns: number): { tracks: number; spans: number[] } {
  if (count <= 0) return { tracks: 1, spans: [] };
  const last = count % columns;
  if (last === 0) return { tracks: columns, spans: Array(count).fill(1) };
  const tracks = (columns * last) / gcd(columns, last);
  return { tracks, spans: Array.from({ length: count }, (_, index) => index < count - last ? tracks / columns : tracks / last) };
}
