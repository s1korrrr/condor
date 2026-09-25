import { useLayoutEffect, useRef, useState } from 'react';

/** Observed content-box size of one element. Starts at `fallback` (also the server-render size). */
export function useElementSize<T extends HTMLElement>(fallback: { width: number; height: number } = { width: 0, height: 0 }) {
  const ref = useRef<T>(null);
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const width = Math.round(node.clientWidth), height = Math.round(node.clientHeight);
      setSize(current => current.width === width && current.height === height ? current : { width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}
