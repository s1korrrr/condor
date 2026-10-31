import { useState, useSyncExternalStore } from 'react';

export function createPaperClock(readNow: () => number = Date.now) {
  let highWater = readNow();
  const observe = () => { highWater = Math.max(highWater, readNow()); return highWater; };
  const subscribe = (notify: () => void) => {
    const update = () => { observe(); notify(); };
    const timer = window.setInterval(update, 1000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  };
  return {subscribe, getSnapshot:() => highWater, observe};
}

export function usePaperClock() {
  const [clock] = useState(() => createPaperClock(() => Date.now()));
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.observe);
}
