import { useSyncExternalStore } from 'react';

export function createPaperClock(readNow: () => number = Date.now) {
  let highWater = readNow();
  let published = highWater;
  const observe = () => { highWater = Math.max(highWater, readNow()); return highWater; };
  const listeners = new Set<() => void>();
  let timer: number | undefined;
  const update = () => { published = observe(); listeners.forEach(notify => notify()); };
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
  return {subscribe, getSnapshot:() => published, observe};
}

let documentClock: ReturnType<typeof createPaperClock> | undefined;

export function usePaperClock() {
  const clock = documentClock ??= createPaperClock(() => Date.now());
  useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  return clock.observe();
}
