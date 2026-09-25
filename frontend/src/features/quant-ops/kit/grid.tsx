import { Children, isValidElement, type ReactNode } from 'react';
import { useElementWidth } from './useElementWidth';
import { balancedColumns, tileSpans } from './layout';
import './kit.css';

/**
 * Adaptive tile grid shared by every dashboard page. Tiles never shrink below `min` pixels, rows stay
 * full, and each cell is a size container so tile text can scale to the cell (see `.q-tile-cell`).
 */
export function TileGrid({ children, min = 190, max, gap = 10, label, className, panelId }: {
  children: ReactNode; min?: number; max?: number; gap?: number; label?: string; className?: string; panelId?: string;
}) {
  const [ref, width] = useElementWidth<HTMLElement>();
  const items = Children.toArray(children).filter(isValidElement);
  const columns = balancedColumns(items.length, width, min, gap, max);
  const { tracks, spans } = tileSpans(items.length, columns);
  return <section ref={ref} className={`q-tile-grid${className ? ` ${className}` : ''}`} aria-label={label} data-panel-id={panelId} data-columns={columns}
    style={{ gridTemplateColumns: `repeat(${tracks}, minmax(0, 1fr))`, gap }}>
    {items.map((item, index) => <div key={item.key ?? index} className="q-tile-cell" style={spans[index] > 1 ? { gridColumn: `span ${spans[index]}` } : undefined}>{item}</div>)}
  </section>;
}
