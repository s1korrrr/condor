/** Pure helpers for the HeatStrip primitive (kept free of React so they are unit-tested without a browser). */
export type Box = { left: number; right: number; top: number; bottom: number };

/**
 * Place a tooltip next to its anchor cell: above when it fits, below otherwise, always inside the viewport.
 * The horizontal position follows the cell and is clamped to `margin` px from each viewport edge.
 */
export function tooltipPlacement(anchor: Box, size: { width: number; height: number }, viewport: { width: number; height: number }, gap = 8, margin = 8) {
  const above = anchor.top - gap - size.height >= margin;
  const top = above ? anchor.top - gap - size.height : Math.min(anchor.bottom + gap, Math.max(margin, viewport.height - size.height - margin));
  const centre = (anchor.left + anchor.right) / 2;
  const left = Math.min(Math.max(margin, centre - size.width / 2), Math.max(margin, viewport.width - size.width - margin));
  return { left, top, side: above ? 'top' as const : 'bottom' as const };
}

/** Keyboard navigation over cells: index 0 is the newest cell on the left, so ArrowRight goes back in time. */
export function stepIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  if (key === 'ArrowRight') return Math.min(last, index + 1);
  if (key === 'ArrowLeft') return Math.max(0, index - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  if (key === 'PageDown') return Math.min(last, index + 10);
  if (key === 'PageUp') return Math.max(0, index - 10);
  return null;
}
