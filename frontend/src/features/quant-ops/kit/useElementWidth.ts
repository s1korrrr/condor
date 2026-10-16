import { useCallback, useLayoutEffect, useState } from 'react';

/**
 * Observed content width of one element; 0 until measured (and on the server). The ref is a callback,
 * so an element that mounts later (after a loading or empty state) is still observed.
 */
export function useElementWidth<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  const ref = useCallback((element: T | null) => setNode(element), []);
  useLayoutEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return;
    const update = () => setWidth(Math.round(node.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [ref, width] as const;
}
