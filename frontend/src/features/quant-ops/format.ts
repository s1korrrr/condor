/** Quant-ops display. Missing stays Unavailable; tiny nonzero stays nonzero. */
import { displayDecimal } from './decimal-display';
export function formatDecimal(value: string | number | null | undefined, digits = 2): string {
  return displayDecimal(value, digits);
}

export function formatSigned(value: string | number | null | undefined, digits = 2): string {
  return displayDecimal(value, digits, true);
}

export function metricTone(value: string | number | null | undefined): 'positive' | 'negative' | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return undefined;
  return n > 0 ? 'positive' : 'negative';
}

export const ASSET_COLORS = ['#49b7ff', '#2cdea0', '#b291ff', '#f2bd55', '#ff647d', '#7dd3fc', '#a78bfa'];

/** Keep a symbol's color stable when holdings are sorted, filtered or added. */
export function assetColor(label: string): string {
  const name = label.trim().toUpperCase();
  const common: Record<string, number> = { BTC: 0, ETH: 1, USDC: 2, USDT: 3, BNB: 4, SOL: 5 };
  if (Object.hasOwn(common, name)) return ASSET_COLORS[common[name]];
  let hash = 2166136261;
  for (const character of name) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return ASSET_COLORS[hash % ASSET_COLORS.length];
}
