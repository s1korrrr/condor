import { useSyncExternalStore } from 'react';

export function createPaperClock(readNow: () => number = Date.now) {
  let highWater = readNow();
  let cached = false;
  const listeners = new Set<() => void>();
  let timer: number | undefined;
  const sample = () => { highWater = Math.max(highWater, readNow()); };
  const update = () => { sample(); listeners.forEach(notify => notify()); };
  const getSnapshot = () => {
    if (!cached) {
      clock.observe();
      cached = true;
      queueMicrotask(() => { cached = false; });
    }
    return highWater;
  };
  const subscribe = (notify: () => void) => {
    listeners.add(notify);
    if (timer === undefined) {
      timer = window.setInterval(update, 1000);
      window.addEventListener('focus', update);
      document.addEventListener('visibilitychange', update);
    }
    update();
    return () => {
      listeners.delete(notify);
      if (!listeners.size) {
        window.clearInterval(timer);
        timer = undefined;
        window.removeEventListener('focus', update);
        document.removeEventListener('visibilitychange', update);
      }
    };
  };
  const clock = {subscribe, getSnapshot, observe:sample};
  return clock;
}

let documentClock: ReturnType<typeof createPaperClock> | undefined;

export function usePaperClock() {
  const clock = documentClock ??= createPaperClock(() => Date.now());
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
