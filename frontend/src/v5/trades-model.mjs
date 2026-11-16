const DECIMAL = /^\d+(?:\.\d+)?$/;

function parts(value) {
  if (typeof value !== 'string' || value.length > 128 || !DECIMAL.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return { digits: BigInt(whole + fraction), scale: fraction.length };
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
  const left = parts(basis), right = parts(quantity);
  if (!left || !right || right.digits === 0n) return null;
  return quotient(left.digits * 10n ** BigInt(right.scale), right.digits * 10n ** BigInt(left.scale), 12);
}

export function targetFromBreakeven(basis, quantity, target) {
  const cost = parts(basis), amount = parts(quantity), goal = parts(target);
  if (!cost || !amount || !goal || cost.digits === 0n || amount.digits === 0n) return null;
  const targetValue = goal.digits * amount.digits * 10n ** BigInt(cost.scale);
  const costValue = cost.digits * 10n ** BigInt(goal.scale + amount.scale);
  return quotient((targetValue - costValue) * 100n, costValue, 2);
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
