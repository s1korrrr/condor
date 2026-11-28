import { ownerTitleText, rationalPercent } from './format.mjs';

const DECIMAL = /^(\d+)(?:\.(\d+))?(?:[Ee]([+-]?\d+))?$/;
export const receiptAmountFields = ['entry_gross_base', 'entry_gross_quote', 'exit_gross_base', 'exit_gross_quote', 'fees_quote', 'remaining_owned_base', 'residual_dust_base'];

export function receiptDecimalParts(value) {
  if (typeof value !== 'string' || value.length > 128 || value.trim() !== value) return null;
  const match = DECIMAL.exec(value);
  if (!match) return null;
  const [, whole, fraction = '', exponent = '0'] = match;
  const shift = BigInt(exponent);
  if (shift < -64n || shift > 64n) return null;
  const scale = BigInt(fraction.length) - shift;
  const digits = BigInt(whole + fraction);
  return scale < 0n ? { digits: digits * 10n ** -scale, scale: 0n } : { digits, scale };
}

function quotient(numerator, denominator, places) {
  if (denominator === 0n) return null;
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const scaled = absolute * 10n ** BigInt(places);
  let rounded = scaled / denominator;
  if (scaled % denominator * 2n >= denominator) rounded += 1n;
  const digits = rounded.toString().padStart(places + 1, '0');
  const text = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
  return `${negative && rounded !== 0n ? '-' : ''}${text}`;
}

export function lotBreakeven(basis, quantity) {
  const left = receiptDecimalParts(basis), right = receiptDecimalParts(quantity);
  if (!left || !right || right.digits === 0n) return null;
  return quotient(left.digits * 10n ** BigInt(right.scale), right.digits * 10n ** BigInt(left.scale), 12);
}

export function targetFromBreakeven(basis, quantity, target) {
  const cost = receiptDecimalParts(basis), amount = receiptDecimalParts(quantity), goal = receiptDecimalParts(target);
  if (!cost || !amount || !goal || cost.digits === 0n || amount.digits === 0n) return null;
  const targetValue = goal.digits * amount.digits * 10n ** BigInt(cost.scale);
  const costValue = cost.digits * 10n ** BigInt(goal.scale + amount.scale);
  return quotient((targetValue - costValue) * 100n, costValue, 2);
}

function signedParts(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const negative = value.startsWith('-');
  const parsed = receiptDecimalParts(negative ? value.slice(1) : value);
  return parsed ? { ...parsed, digits: negative ? -parsed.digits : parsed.digits } : null;
}

function receiptRatio(numerator, denominator, percent = false) {
  const left = signedParts(numerator), right = receiptDecimalParts(denominator);
  if (!left || !right || right.digits === 0n) return null;
  const top = left.digits * 10n ** BigInt(right.scale) * (percent ? 100n : 1n);
  const bottom = right.digits * 10n ** BigInt(left.scale);
  const result = rationalPercent(top, bottom);
  const rounded = result.exact.startsWith('≈');
  const detail = percent ? result.exact : result.exact.replace(/ ?%/, '');
  const magnitude = top < 0n ? -top : top;
  const truncated = (magnitude * 100000n / bottom).toString().padStart(6, '0');
  const value = rounded
    ? `${top < 0n ? '-' : ''}${truncated.slice(0, -5)}.${truncated.slice(-5)}`
    : result.exact.replace(/%$/, '').replace('−', '-');
  return { value, rounded, exact: `${numerator} / ${denominator}${percent ? ' × 100' : ''} = ${detail}`, title: `${ownerTitleText(numerator)} / ${ownerTitleText(denominator)}${percent ? ' × 100' : ''} = ${ownerTitleText(detail)}` };
}

export function tradeCosts(row) {
  const unavailable = {
    grossEntryCost: null, grossSaleProceeds: null, averageEntryPrice: null,
    averageExitPrice: null, realizedReturn: null, notSold: false,
    feesQuote: signedParts(row?.cum_fees_quote) ? row.cum_fees_quote : null,
    reason: 'A valid execution receipt is unavailable; these costs are not known.',
  };
  const receipt = row?.custom_info?.execution_receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || typeof receipt.accounting_owner !== 'string') return unavailable;
  const amounts = Object.fromEntries(receiptAmountFields.map(key => [key, receiptDecimalParts(receipt[key])]));
  if (receiptAmountFields.some(key => !amounts[key]) || amounts.entry_gross_base.digits === 0n || amounts.entry_gross_quote.digits === 0n) return unavailable;
  const entry = {
    ...unavailable,
    grossEntryCost: receipt.entry_gross_quote,
    averageEntryPrice: receiptRatio(receipt.entry_gross_quote, receipt.entry_gross_base),
  };
  if (receipt.accounting_owner !== 'executor') return {
    ...entry,
    reason: "Recovery sales are allocated across held bags in owner accounting and are not reflected in this executor's receipt. Lifetime sale proceeds, exit price and return are withheld.",
  };
  return {
    ...entry,
    grossSaleProceeds: receipt.exit_gross_quote,
    averageExitPrice: receiptRatio(receipt.exit_gross_quote, receipt.exit_gross_base),
    notSold: amounts.exit_gross_base.digits === 0n,
    realizedReturn: amounts.remaining_owned_base.digits === 0n
      ? receiptRatio(row.realized_pnl_quote, receipt.entry_gross_quote, true) : null,
    reason: 'Realized return is shown only for a fully closed direct executor with known owner realized profit or loss.',
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function reconcileFills(fills) {
  const identities = new Map();
  const withheldExecutors = new Set();
  let conflicts = 0;
  for (const fill of fills) {
    if (typeof fill.order_id !== 'string' || !fill.order_id || typeof fill.trade_id !== 'string' || !fill.trade_id) {
      if (typeof fill.executor_id === 'string') withheldExecutors.add(fill.executor_id);
      conflicts += 1;
      continue;
    }
    const key = JSON.stringify([fill.order_id, fill.trade_id]);
    const records = identities.get(key) ?? [];
    records.push(fill);
    identities.set(key, records);
  }
  const unique = [];
  for (const records of identities.values()) {
    const versions = new Set(records.map(record => JSON.stringify(canonical(record))));
    if (versions.size > 1) {
      conflicts += 1;
      for (const record of records) if (typeof record.executor_id === 'string') withheldExecutors.add(record.executor_id);
    } else unique.push(records[0]);
  }
  return { fills: unique.filter(fill => !withheldExecutors.has(fill.executor_id)), withheldExecutors, conflicts };
}

export function groupTrades(executors, history, fills) {
  const rows = new Map();
  for (const row of history) if (typeof row.executor_id === 'string') rows.set(row.executor_id, { ...row, terminal: true });
  for (const row of executors) if (typeof row.executor_id === 'string') rows.set(row.executor_id, row);
  const reconciled = reconcileFills(fills);
  return [...rows.values()].filter(row => !reconciled.withheldExecutors.has(row.executor_id)).map(row => ({
    ...row,
    fills: reconciled.fills.filter(fill => fill.executor_id === row.executor_id),
  }));
}

export function tradeWindow(fills, closed, hasMoreFills, hasMoreHistory) {
  return `Showing the newest ${fills} retained fills and ${closed} closed trades${hasMoreFills || hasMoreHistory ? '; more retained records are outside this view' : ''}. Older trades need the owner's lifetime export. Fill counts may be incomplete.`;
}
