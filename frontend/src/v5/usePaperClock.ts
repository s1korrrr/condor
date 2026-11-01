import { useSyncExternalStore } from 'react';

export function createPaperClock(readNow: () => number = Date.now) {
  let published = readNow();
  const listeners = new Set<() => void>();
  let timer: number | undefined;
  const update = () => { published = Math.max(published, readNow()); listeners.forEach(notify => notify()); };
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
  return {subscribe, getSnapshot:() => published};
}

const documentClock = createPaperClock(() => Date.now());

export function usePaperClock() {
  return useSyncExternalStore(documentClock.subscribe, documentClock.getSnapshot, documentClock.getSnapshot);
}
