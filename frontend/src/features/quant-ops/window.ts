export type CapitalPeriod = '1D' | '7D' | '30D' | '90D' | 'YTD' | 'ALL' | 'CUSTOM';
export type CapitalWindow = { start: string; end: string };
export function capitalWindow(period: CapitalPeriod, now: number, custom?: CapitalWindow): CapitalWindow | undefined {
  if (period === 'ALL') return undefined;
  if (period === 'CUSTOM') {
    if (!custom || !Number.isFinite(Date.parse(custom.start)) || !Number.isFinite(Date.parse(custom.end)) || Date.parse(custom.start) >= Date.parse(custom.end)) throw new Error('Choose a start before the end.');
    if (Date.parse(custom.end) - Date.parse(custom.start) > 3650 * 86400000) throw new Error('Choose a window of ten years or less.');
    return { start: new Date(custom.start).toISOString(), end: new Date(custom.end).toISOString() };
  }
  const end = new Date(now);
  const days = { '1D': 1, '7D': 7, '30D': 30, '90D': 90 };
  const start = period === 'YTD' ? Date.UTC(end.getUTCFullYear(), 0, 1) : now - days[period] * 86400000;
  return { start: new Date(start).toISOString(), end: end.toISOString() };
}
export function parseCapitalPeriod(value: string | null): CapitalPeriod {
  if (value === '1W') return '7D';
  if (value === '1M') return '30D';
  if (value === '3M') return '90D';
  return ['1D', '7D', '30D', '90D', 'YTD', 'ALL', 'CUSTOM'].includes(value ?? '') ? value as CapitalPeriod : '1D';
}
