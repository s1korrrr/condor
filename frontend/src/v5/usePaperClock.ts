import { useSyncExternalStore } from 'react';

function subscribe(notify: () => void) {
  const timer = window.setInterval(notify, 1000);
  window.addEventListener('focus', notify);
  document.addEventListener('visibilitychange', notify);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('focus', notify);
    document.removeEventListener('visibilitychange', notify);
  };
}

const clockSnapshot = () => Math.floor(Date.now() / 1000) * 1000;

export function usePaperClock() {
  return useSyncExternalStore(subscribe, clockSnapshot, clockSnapshot);
}
