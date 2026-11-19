import type { PaperRead } from './contracts';
import { coin as formatCoin, decimalPercentChange, pct, ownerTitleText, rationalPercent } from './format.mjs';
import { ageSeconds, MARKET_COINS, STALE_AFTER_S, type CandleRead } from './market-model.mjs';
import { paperCompleteRead, paperPairBag, paperPairHoldings, paperSectionError, paperSnapshotsAgree } from './policy.ts';

const SCALE = 10n ** 30n;
const ranges: Record<string, string> = { '1h': '1 hour', '6h': '6 hours', '24h': '24 hours', '7d': '7 days' };

function decimal(value: unknown): bigint | null {
  if (typeof value !== 'string' || value.length > 128 || !/^-?\d+(?:\.\d{1,30})?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const result = BigInt(whole + fraction.padEnd(30, '0'));
  return negative ? -result : result;
}

function rounded(numerator: bigint, denominator: bigint, places: number): string {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const units = (magnitude * 10n ** BigInt(places) * 2n + denominator) / (2n * denominator);
  const digits = units.toString().padStart(places + 1, '0');
  return `${negative && units !== 0n ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

function change(value: number, base: number | string, places = 2): string | null {
  const last = decimal(String(value)), first = decimal(String(base));
  return last != null && last >= 0n && first != null && first > 0n ? rounded((last - first) * 100n, first, places) : null;
}

export function candleCurrent(read: CandleRead | null | undefined, received: number, now: number): boolean {
  const row = read?.buckets.findLast(row => row[6] === 1 && row[4] != null);
  if (!read || !row) return false;
  const age = ageSeconds(row[0]!, read, received, now);
  return Number.isFinite(age) && age >= 0 && age <= STALE_AFTER_S;
}

export function windowChange(read: CandleRead | null | undefined): string | null {
  const first = read?.buckets[0], last = read?.buckets.at(-1);
  return first?.[6] === 1 && last?.[6] === 1 && first[4] != null && last[4] != null ? change(last[4], first[4]) : null;
}

export function marketAverageTitle(changes: Record<string, string | null>): string | undefined {
  const measured = MARKET_COINS.flatMap(coin => {
    const value = decimal(changes[coin]);
    return value === null ? [] : [{ coin, value, text: changes[coin]! }];
  });
  if (!measured.length) return undefined;
  const sum = measured.reduce((total, row) => total + row.value, 0n);
  const exact = rationalPercent(sum, BigInt(measured.length) * SCALE)!.exact;
  return `${measured.map(row => `${row.coin} ${ownerTitleText(row.text)}%`).join(', ')} · exact average ${ownerTitleText(exact)}`;
}

export function marketSentence(changes: Record<string, string | null>, range: string): string {
  const measured = MARKET_COINS.flatMap(coin => {
    const value = decimal(changes[coin]);
    return value == null ? [] : [{ coin, value, text: changes[coin]! }];
  });
  const missing = MARKET_COINS.filter(coin => !measured.some(row => row.coin === coin));
  const period = ranges[range];
  if (!measured.length) return `No price changes available for the last ${period}.`;
  const up = measured.filter(row => row.value > 0n).length, down = measured.filter(row => row.value < 0n).length;
  const subject = measured.length === 1 ? measured[0].coin : missing.length ? `All ${measured.length} published coins` : 'All five coins';
  const verb = measured.length === 1 ? 'is' : 'are';
  const direction = up === measured.length ? `${subject} ${verb} up` : down === measured.length ? `${subject} ${verb} down` : !up && !down ? `${subject} ${verb} unchanged` : `${up} up, ${down} down, ${measured.length - up - down} unchanged`;
  const mean = rounded(measured.reduce((sum, row) => sum + row.value, 0n), BigInt(measured.length) * SCALE, 35);
  const weakest = [...measured].sort((left, right) => left.value < right.value ? -1 : left.value > right.value ? 1 : 0)[0];
  const strongest = [...measured].sort((left, right) => left.value > right.value ? -1 : left.value < right.value ? 1 : 0)[0];
  const extreme = down ? `${weakest.coin} is weakest at ${pct(weakest.text)}.` : up ? `${strongest.coin} is strongest at ${pct(strongest.text)}.` : '';
  return `${direction} over ${period}, on average ${pct(mean)}.${extreme ? ` ${extreme}` : ''}${missing.length ? ` The average excludes ${missing.join(', ')} because their changes are unavailable.` : ''}`;
}

export function hourlyReturns(read: CandleRead | null | undefined): { from: number; to: number; change: string | null; inputs?: string }[] {
  if (!read?.buckets.length) return [];
  const byTime = new Map(read.buckets.map(row => [row[0], row]));
  const result: { from: number; to: number; change: string | null; inputs?: string }[] = [];
  for (let from = Math.floor(read.start / 3600) * 3600; from <= read.end; from += 3600) {
    const to = from + 3600;
    const rows = Array.from({ length: 61 }, (_, index) => byTime.get(from - 60 + index * 60));
    const complete = rows.every(row => row?.[6] === 1 && row[4] != null);
    result.push({ from, to, change: complete ? change(rows[60]![4]!, rows[0]![4]!) : null, ...(complete ? { inputs: `first close ${ownerTitleText(rows[0]![4])}; last close ${ownerTitleText(rows[60]![4])}` } : {}) });
  }
  return result;
}

export function marketHolding(coin: string, reads: PaperRead[] | undefined, bot: string | null | undefined, last: number | null, quote: string, now: number): { text: string; exact?: string; title?: string; reason: string | null; asOf: number | null } {
  const unavailable = (reason: string) => ({ text: 'V5 holds —', reason, asOf: null });
  if (!bot || !reads || reads.length !== 3 || !['status', 'positions', 'decisions'].every(section => reads.some(read => read.section === section)) ||
      reads.some(read => read.bot_id !== bot || paperSectionError(read) || read.section !== 'status' && !paperCompleteRead(read, now)) || !paperSnapshotsAgree(reads)) return unavailable('The latest paper reports do not give a complete view of holdings.');
  const positions = reads.find(read => read.section === 'positions')!, decisions = reads.find(read => read.section === 'decisions')!;
  const controllers = (decisions.data as { controllers?: { pair?: string }[] } | null)?.controllers;
  const pairs = [...new Set((controllers ?? []).map(row => row.pair).filter((pair): pair is string => typeof pair === 'string' && pair.startsWith(`${coin}-`)))];
  if (pairs.length !== 1) return unavailable('V5 needs to report one trading pair for this coin.');
  const pair = pairs[0], holdings = paperPairHoldings(pair, positions, now), bag = paperPairBag(pair, decisions, positions, now);
  if (!holdings || (positions.data as Record<string, unknown>[]).filter(row => row.trading_pair === pair).some(row => decimal(row.quantity) == null)) return unavailable('V5 has not reported exact amounts for all positions.');
  let reason: string | null = null, gap: string | null = null;
  if (!bag?.heldAmount || decimal(bag.heldAmount) == null) reason = 'Breakeven comparison needs an exact amount from the strategy.';
  else if (decimal(bag.heldAmount) !== decimal(holdings.total)) reason = 'Breakeven comparison unavailable because the strategy and position reports list different amounts.';
  else if (pair.split('-')[1] !== quote) reason = `The market price is in ${quote}. Breakeven is in ${pair.split('-')[1]}.`;
  else if (last == null) reason = 'Breakeven comparison needs a recent price.';
  else if (decimal(bag.breakevenPrice) == null || decimal(bag.breakevenPrice)! <= 0n) reason = 'V5 has not reported a usable breakeven price.';
  else gap = change(last, bag.breakevenPrice!, 1);
  if (!gap && !reason) reason = 'A complete price comparison is unavailable.';
  const comparison = gap && last != null ? decimalPercentChange(last, bag?.breakevenPrice, 1) : null;
  const exact = comparison ? `holding ${holdings.total} · (${last} − ${bag!.breakevenPrice}) × 100 / ${bag!.breakevenPrice} = ${comparison.exact}` : holdings.total;
  const title = comparison ? `holding ${ownerTitleText(holdings.total)} · (${ownerTitleText(last)} − ${ownerTitleText(bag!.breakevenPrice)}) × 100 / ${ownerTitleText(bag!.breakevenPrice)} = ${ownerTitleText(comparison.exact)}` : ownerTitleText(holdings.total);
  return { text: `V5 holds ${formatCoin(holdings.total)} · ${gap ? pct(gap, 1) : '—'} to breakeven`, exact, title, reason, asOf: positions.generated_at_ms };
}
