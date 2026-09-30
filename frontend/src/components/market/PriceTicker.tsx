import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { candleStore } from "@/lib/candle-store";

interface PriceTickerProps {
  server: string;
  connector: string;
  pair: string;
  /** Candle interval to track — defaults to "1m" for most responsive updates */
  interval?: string;
}

export function PriceTicker({ server, connector, pair, interval = "1m" }: PriceTickerProps) {
  const prevPriceRef = useRef<number>(0);
  const [direction, setDirection] = useState<"up" | "down" | "flat">("flat");
  const candleKey = server && connector && pair
    ? `candles:${server}:${connector}:${pair}:${interval}` : "";
  const subscribeToCandle = useCallback((notify: () => void) => {
    if (!candleKey) return () => {};
    const cached = candleStore.subscribe(candleKey);
    prevPriceRef.current = cached.at(-1)?.close ?? 0;
    const removeListener = candleStore.onUpdate(candleKey, (candles) => {
      const nextPrice = candles.at(-1)?.close;
      if (nextPrice && nextPrice !== prevPriceRef.current) {
        const previousPrice = prevPriceRef.current;
        setDirection(previousPrice > 0
          ? nextPrice > previousPrice ? "up" : "down"
          : "flat");
        prevPriceRef.current = nextPrice;
      }
      notify();
    });
    return () => {
      removeListener();
      candleStore.unsubscribe(candleKey);
    };
  }, [candleKey]);
  const getCandleSnapshot = useCallback(
    () => candleKey ? candleStore.getLastClose(candleKey) ?? 0 : 0,
    [candleKey],
  );
  const candlePrice = useSyncExternalStore(subscribeToCandle, getCandleSnapshot, () => 0);

  // REST fallback for bid/ask/spread (less frequent)
  const { data: price } = useQuery({
    queryKey: ["price", server, connector, pair],
    queryFn: () => api.getPrice(server, connector, pair),
    enabled: !!server && !!connector && !!pair,
    refetchInterval: 15_000,
  });

  // Use candle close as primary price, fall back to REST mid_price
  const displayPrice = candlePrice > 0 ? candlePrice : (price?.mid_price ?? 0);

  if (!displayPrice || !pair) return null;

  const spread = price?.best_ask && price?.best_bid
    ? price.best_ask - price.best_bid
    : 0;
  const mid = price ? (price.best_ask + price.best_bid) / 2 : 0;
  const spreadPct = mid > 0 ? (spread / mid) * 100 : 0;

  const dirColor =
    direction === "up"
      ? "text-[var(--color-green)]"
      : direction === "down"
        ? "text-[var(--color-red)]"
        : "text-[var(--color-text)]";

  return (
    <div className="flex items-center gap-5">
      {/* Mark price */}
      <div>
        <p className={`text-lg font-bold tabular-nums leading-tight ${dirColor}`}>
          {displayPrice.toLocaleString("en-US", { maximumFractionDigits: 8 })}
        </p>
      </div>

      {price && price.best_bid > 0 && (
        <>
          {/* Bid */}
          <div className="hidden sm:block">
            <p className="text-[10px] leading-tight text-[var(--color-text-muted)]">Bid</p>
            <p className="text-xs font-medium tabular-nums leading-tight text-[var(--color-green)]">
              {price.best_bid.toLocaleString("en-US", { maximumFractionDigits: 8 })}
            </p>
          </div>

          {/* Ask */}
          <div className="hidden sm:block">
            <p className="text-[10px] leading-tight text-[var(--color-text-muted)]">Ask</p>
            <p className="text-xs font-medium tabular-nums leading-tight text-[var(--color-red)]">
              {price.best_ask.toLocaleString("en-US", { maximumFractionDigits: 8 })}
            </p>
          </div>

          {/* Spread */}
          <div className="hidden md:block">
            <p className="text-[10px] leading-tight text-[var(--color-text-muted)]">Spread</p>
            <p className="text-xs font-medium tabular-nums leading-tight text-[var(--color-text)]">
              {spreadPct.toFixed(3)}%
            </p>
          </div>
        </>
      )}
    </div>
  );
}
