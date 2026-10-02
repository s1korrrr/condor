import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { stepIndex, tooltipPlacement } from './heat-strip';
import './heat-strip.css';

export type HeatCell = {
  key: string;
  /** Any CSS color or token expression. Empty cells use the neutral track color instead. */
  color: string;
  empty?: boolean;
  /** Plain-text description announced for the active cell (screen readers and keyboard users). */
  label: string;
};

/**
 * One row of equal cells, index 0 at the LEFT edge. Hover, keyboard focus (arrow keys, Home/End) and touch
 * (tap or drag across the strip) show the same tooltip, so the strip is inspectable on every input type.
 * `onSelect` fires on click, tap or Enter/Space with the cell index.
 */
export function HeatStrip({ cells, ariaLabel, renderTooltip, onSelect, height = 22, maxCellWidth = 28 }: {
  cells: HeatCell[]; ariaLabel: string; renderTooltip: (index: number) => ReactNode; onSelect?: (index: number) => void; height?: number; maxCellWidth?: number;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number; side: 'top' | 'bottom' } | null>(null);
  const touchRef = useRef(false);
  const tipId = useId();
  const count = cells.length;
  const shown = active !== null && active < count ? active : null;

  const indexAt = (target: EventTarget | null) => {
    const node = (target as HTMLElement | null)?.closest?.('[data-i]') as HTMLElement | null;
    return node ? Number(node.dataset.i) : null;
  };
  const move = (event: PointerEvent) => {
    const index = indexAt(document.elementFromPoint(event.clientX, event.clientY) ?? event.target);
    if (index !== null) setActive(index);
  };
  const leave = (event: PointerEvent) => { if (event.pointerType !== 'touch' && document.activeElement !== stripRef.current) setActive(null); };
  const key = (event: KeyboardEvent) => {
    if ((event.key === 'Enter' || event.key === ' ') && shown !== null) { event.preventDefault(); onSelect?.(shown); return; }
    if (event.key === 'Escape') { setActive(null); return; }
    const next = stepIndex(event.key, shown ?? 0, count);
    if (next !== null) { event.preventDefault(); setActive(next); }
  };

  const reposition = useCallback(() => {
    const strip = stripRef.current, tip = tipRef.current;
    if (!strip || !tip || shown === null) return;
    const cell = strip.children[shown] as HTMLElement | undefined;
    if (!cell) return;
    const rect = cell.getBoundingClientRect(), size = tip.getBoundingClientRect();
    setPlace(tooltipPlacement(rect, { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [shown]);
  useLayoutEffect(() => { reposition(); }, [reposition, renderTooltip, count]);
  useEffect(() => {
    if (shown === null) { setPlace(null); return; }
    window.addEventListener('scroll', reposition, true); window.addEventListener('resize', reposition);
    // A touch has no pointerleave: a tap elsewhere dismisses the tooltip.
    const outside = (event: globalThis.PointerEvent) => { if (!stripRef.current?.contains(event.target as Node)) setActive(null); };
    document.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); document.removeEventListener('pointerdown', outside); };
  }, [shown, reposition]);

  return <>
    <div ref={stripRef} className="q-heat" role="group" aria-roledescription="timeline" aria-label={`${ariaLabel}. Newest on the left. Arrow keys move between cells.`} aria-describedby={shown !== null ? tipId : undefined}
      tabIndex={0} data-count={count}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`, height, maxWidth: count * maxCellWidth }}
      onPointerDown={event => { touchRef.current = event.pointerType === 'touch'; move(event); }}
      onPointerMove={move} onPointerLeave={leave}
      onClick={event => { const index = indexAt(event.target); if (index !== null) onSelect?.(index); }}
      onFocus={() => setActive(current => current ?? 0)} onBlur={() => setActive(null)} onKeyDown={key}>
      {cells.map((cell, index) => <i key={cell.key} data-i={index} data-empty={cell.empty ? '' : undefined} data-active={index === shown ? '' : undefined} aria-hidden="true"
        style={cell.empty ? undefined : { background: cell.color }} />)}
    </div>
    <span id={tipId} className="q-heat-sr" role="status" aria-live="polite">{shown !== null ? cells[shown].label : ''}</span>
    {shown !== null && createPortal(
      <div ref={tipRef} className="q-heat-tip" data-side={place?.side} style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: 'hidden' }}>{renderTooltip(shown)}</div>,
      document.body)}
  </>;
}
