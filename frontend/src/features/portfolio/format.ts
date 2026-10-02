import { displayDecimal } from '@/features/quant-ops/decimal-display';

/** Same house format as every other page: locale-independent, no float noise, and a tiny nonzero never rounds to -0.00. */
export const formatValue = (value: number | null) => displayDecimal(value, 2);
export const utc = (value: string) => new Date(value).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'medium' });
