/** Quant-ops display. Missing stays Unavailable; tiny nonzero stays nonzero. */
export function formatDecimal(value: string | number | null | undefined, digits = 2): string {
  if (value == null || value === '') return 'Unavailable';
  const text = String(value);
  if (!Number.isFinite(Number(text))) return 'Unavailable';
  const frac = text.replace(/^\+/, '').split('.')[1] ?? '';
  if (Number(text) === 0) return '0';
  if (frac.replace(/0+$/, '').length > digits && Math.abs(Number(text)) < 1 && Number(text) !== 0) {
    return Number(text).toLocaleString('en', { maximumSignificantDigits: 8 });
  }
  return Number(text).toLocaleString('en', { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 2) });
}

export function formatSigned(value: string | number | null | undefined, digits = 2): string {
  if (value == null || value === '') return 'Unavailable';
  if (!Number.isFinite(Number(value))) return 'Unavailable';
  return Number(value).toLocaleString('en', { maximumFractionDigits: digits, minimumFractionDigits: 2, signDisplay: 'exceptZero' });
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
