import type { ScreenerCandlesEnvelope } from "./contracts";

/** Presentation only: original decimal strings remain in every candle tooltip. */
export function CandleChart({ candles }: { candles: ScreenerCandlesEnvelope | null }) {
  if (!candles?.candles.length) return <div className="chart-empty"><span>Price history unavailable</span><small>Only qualified recorded candles appear here.</small></div>;
  const points = candles.candles;
  const intervalMs = ({"1m":60_000,"5m":300_000,"15m":900_000} as Record<string, number>)[candles.interval];
  const first = points[0]!;
  const last = points.at(-1)!;
  const duration = Math.max(intervalMs, last.timestamp - first.timestamp + intervalMs);
  const low = Math.min(...points.map(point => Number(point.low)));
  const high = Math.max(...points.map(point => Number(point.high)));
  const range = high - low || Math.max(high * .001, .000001);
  const volume = points.filter(point => point.volume !== null).map(point => Number(point.volume));
  const maximumVolume = Math.max(0, ...volume);
  const x = (timestamp: number) => 8 + (timestamp - first.timestamp + intervalMs / 2) / duration * 384;
  const y = (price: string) => 106 - (Number(price) - low) / range * 94;
  const width = Math.min(8, Math.max(.5, intervalMs / duration * 280));
  const gaps = points.some((point, index) => index > 0 && point.timestamp - points[index-1]!.timestamp !== intervalMs);
  return <figure className="candle-chart">
    <svg className="ohlcv-chart" viewBox="0 0 400 165" role="img" aria-label={`${points.length} recorded ${candles.interval} OHLC candles and base volume; gaps are not filled`}>
      <line x1="8" y1="110" x2="392" y2="110"/>
      {points.map(point => {
        const rising = Number(point.close) >= Number(point.open);
        const volumeHeight = point.volume !== null && maximumVolume > 0 ? Number(point.volume) / maximumVolume * 32 : 0;
        return <g key={point.timestamp} className={rising ? "candle-up" : "candle-down"}>
          <title>{new Date(point.timestamp).toISOString()} · Open {point.open} · High {point.high} · Low {point.low} · Close {point.close} {candles.quote_asset} · Base volume {point.volume ?? "Unavailable"}</title>
          <path d={`M ${x(point.timestamp)} ${y(point.high)} V ${y(point.low)}`} />
          <rect x={x(point.timestamp)-width/2} y={Math.min(y(point.open), y(point.close))} width={width} height={Math.max(.6, Math.abs(y(point.open)-y(point.close)))}/>
          {point.volume !== null && <rect className="candle-volume" x={x(point.timestamp)-width/2} y={150-volumeHeight} width={width} height={volumeHeight}/>}</g>;
      })}
      <text x="8" y="162">{new Date(first.timestamp).toISOString().slice(11,16)} UTC</text>
      <text x="392" y="162" textAnchor="end">{new Date(last.timestamp).toISOString().slice(11,16)} UTC</text>
    </svg>
    <figcaption><span>{candles.availability} · {candles.interval} · {gaps ? "Gaps present" : "Closed bars"}</span><span>{last.close} {candles.quote_asset}</span></figcaption>
    <small className="chart-volume-label">{volume.length ? `Base volume · ${volume.length}/${points.length} observations` : "Base volume unavailable"}. Hover a candle for recorded values.</small>
  </figure>;
}
