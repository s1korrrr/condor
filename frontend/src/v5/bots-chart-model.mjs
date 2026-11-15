export function tradeMarkers(fills, pair, start, end, buckets) {
  const available = new Set(buckets.filter(row => row[6] === 1).map(row => row[0]));
  const trades = fills.filter(row => row.trading_pair === pair && (row.side === 'BUY' || row.side === 'SELL') && typeof row.event_at_ms === 'number' && Number.isFinite(row.event_at_ms) && row.event_at_ms >= start * 1000 && row.event_at_ms < (end + 60) * 1000);
  return {
    entries: trades.filter(row => row.side === 'BUY').length,
    exits: trades.filter(row => row.side === 'SELL').length,
    markers: trades.map(row => ({ time: Math.floor(row.event_at_ms / 60000) * 60, side: row.side, price: row.price, quantity: row.quantity })).filter(row => available.has(row.time)).sort((left, right) => left.time - right.time),
  };
}
