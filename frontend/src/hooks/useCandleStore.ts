import { useEffect, useState } from "react";

import type { CandleData } from "@/lib/api";
import { candleStore } from "@/lib/candle-store";

const EMPTY_CANDLES: CandleData[] = [];

/** Staleness thresholds by interval category */
const STALE_THRESHOLD_SUB_1H_MS = 30_000; // 30s for intervals < 1h
const STALE_THRESHOLD_1H_PLUS_MS = 120_000; // 2min for intervals >= 1h
const STALE_CHECK_INTERVAL_MS = 10_000; // check every 10s

function getStaleThreshold(interval: string): number {
  const hourPlus = ["1h", "2h", "4h", "1d", "1w"];
  return hourPlus.includes(interval) ? STALE_THRESHOLD_1H_PLUS_MS : STALE_THRESHOLD_SUB_1H_MS;
}

/**
 * React hook bridging the singleton candle store to components.
 *
 * On mount: subscribes to the candle channel and registers an update listener.
 * On unmount: unsubscribes (old data stays in store for 5 min).
 * On key change: unsubscribes old, subscribes new.
 */
export function useCandleStore(
  server: string | null,
  connector: string,
  pair: string,
  interval: string,
): {
  candles: CandleData[];
  isStale: boolean;
  mergeCandles: (c: CandleData[]) => void;
  setDuration: (seconds: number) => void;
} {
  const key = server
    ? `candles:${server}:${connector}:${pair}:${interval}`
    : "";

  const [snapshot, setSnapshot] = useState<{
    key: string;
    candles: CandleData[];
    isStale: boolean;
  }>({ key: "", candles: [], isStale: false });

  useEffect(() => {
    if (!key) {
      setSnapshot({ key: "", candles: [], isStale: false });
      return;
    }

    let active = true;
    const threshold = getStaleThreshold(interval);
    const cached = candleStore.subscribe(key);
    const publish = (candles: CandleData[]) => {
      if (!active) return;
      setSnapshot({
        key,
        candles,
        isStale: candleStore.getLastUpdateAge(key) > threshold,
      });
    };
    const removeListener = candleStore.onUpdate(key, publish);
    // Empty target caches must replace the previous market, not inherit it.
    publish(cached);

    const timer = setInterval(() => {
      if (!active) return;
      const isStale = candleStore.getLastUpdateAge(key) > threshold;
      setSnapshot(previous => previous.key === key && previous.isStale !== isStale
        ? { ...previous, isStale }
        : previous);
    }, STALE_CHECK_INTERVAL_MS);

    return () => {
      active = false;
      removeListener();
      clearInterval(timer);
      candleStore.unsubscribe(key);
    };
  }, [key, interval]);

  const mergeCandles = (c: CandleData[]) => {
    if (key) candleStore.mergeCandles(key, c);
  };

  const setDuration = (seconds: number) => {
    if (key) candleStore.setDuration(key, seconds);
  };

  // Effects run after render: do not expose another market under the new label.
  const matches = Boolean(key) && snapshot.key === key;
  return {
    candles: matches ? snapshot.candles : EMPTY_CANDLES,
    isStale: key ? !matches || snapshot.isStale : false,
    mergeCandles,
    setDuration,
  };
}
