/**
 * Per-bot card facts the fleet summary (`fleet-summary.v1`) already computed: the day change and the
 * trading capability. This module only reads and words them; it never recomputes a number. Wording and
 * expiry follow the iPhone app (`FleetTrading.swift`, `BotCardModel.make` in `FleetHome.swift`) so one
 * summary reads the same on both.
 */

export type TradingLevel = 'ok' | 'unverified' | 'restricted' | 'blocked';
const RANK: Record<TradingLevel, number> = { ok: 0, unverified: 1, restricted: 2, blocked: 3 };

export type TradingRestriction = {
  /** "ETH-USDC buying", or "Trading" for the whole bot (server-written words). */
  subject: string;
  /** "not enough USDC". */
  why: string;
  pair: string | null; side: string; state: string; reasonCode: string; sinceMs: number | null;
  /** The owner marks a real inability as alerting; a policy limit (sell-only mode) is not. */
  alert: boolean;
};

export type BotTrading = {
  buy: TradingLevel; sell: TradingLevel; restrictions: TradingRestriction[];
  /** The owner's count before the server's bound. */
  restrictionsTotal: number;
  /** The glance view's single word: which side is affected is unknown. */
  sideUnknown: boolean;
  /** The server's last valid capability after this build's read failed: both sides unverified, restrictions last known. */
  held: boolean;
  /** The owner runtime observation this capability was computed from. */
  observedMs: number | null;
};

/** A capability older than this (by the bot's report age) is no longer a current claim. */
export const TRADING_MAX_AGE_MS = 300_000;

/** Unknown words read as unverified, never as able to trade. */
export function tradingWord(word: unknown): TradingLevel {
  return word === 'can_trade' || word === 'ok' ? 'ok' : word === 'restricted' ? 'restricted' : word === 'blocked' ? 'blocked' : 'unverified';
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';

function restriction(raw: unknown): TradingRestriction | null {
  if (!object(raw) || !text(raw.subject) || !text(raw.why) || !text(raw.side) || !text(raw.state) || !text(raw.reason_code) || typeof raw.alert !== 'boolean') return null;
  if (!(raw.pair == null || text(raw.pair)) || !(raw.since_ms == null || Number.isSafeInteger(raw.since_ms))) return null;
  return { subject: raw.subject, why: raw.why, pair: raw.pair ?? null, side: raw.side, state: raw.state, reasonCode: raw.reason_code, sinceMs: (raw.since_ms as number | null | undefined) ?? null, alert: raw.alert };
}

/** The card's `trading` field, full object or glance word. `null` when absent or malformed: no claim, never healthy. */
export function parseBotTrading(raw: unknown): BotTrading | null {
  if (typeof raw === 'string') {
    const level = tradingWord(raw);
    return { buy: level, sell: level, restrictions: [], restrictionsTotal: 0, sideUnknown: true, held: false, observedMs: null };
  }
  if (!object(raw)) return null;
  if (raw.restrictions !== undefined && raw.restrictions !== null && !Array.isArray(raw.restrictions)) return null;
  const rows = ((raw.restrictions as unknown[] | null | undefined) ?? []).map(restriction);
  if (rows.some(row => row === null)) return null;
  const restrictions = rows as TradingRestriction[];
  const total = Number.isSafeInteger(raw.restrictions_total) ? raw.restrictions_total as number : 0;
  // Additive fields (2026-10-27): an older sender omits them; a held capability is never current.
  const held = raw.held === true;
  const observedMs = Number.isSafeInteger(raw.observed_ms) ? raw.observed_ms as number : null;
  return {
    buy: held ? 'unverified' : tradingWord(raw.buy), sell: held ? 'unverified' : tradingWord(raw.sell),
    restrictions, restrictionsTotal: Math.max(total, restrictions.length), sideUnknown: false, held, observedMs,
  };
}

/** The worse of the two sides. */
export function tradingLevel(trading: BotTrading): TradingLevel {
  return RANK[trading.buy] >= RANK[trading.sell] ? trading.buy : trading.sell;
}

/** A real inability: an alerting restriction, or the glance's word for one (it carries no rows). */
export function tradingNeedsAttention(trading: BotTrading): boolean {
  return trading.restrictions.some(row => row.alert) || (trading.sideUnknown && RANK[tradingLevel(trading)] >= RANK.restricted);
}

/** The same restrictions as last known, with neither side claimed current. */
export function expiredTrading(trading: BotTrading): BotTrading {
  return { ...trading, buy: 'unverified', sell: 'unverified' };
}

const blockedWord = (level: TradingLevel) => level === 'blocked' ? 'blocked' : 'restricted';

/** One line for a bot card: the first real inability, or the side state when no row explains it. `null` when it can trade. */
export function tradingSummary(trading: BotTrading): string | null {
  const level = tradingLevel(trading);
  if (level === 'ok') return null;
  const first = trading.restrictions.find(row => row.alert) ?? trading.restrictions[0];
  if (first) {
    const more = trading.restrictionsTotal - 1;
    return `${first.subject} ${first.state === 'blocked' ? 'blocked' : 'restricted'}${more > 0 ? ` · +${more} more` : ''}`;
  }
  if (level === 'unverified') return 'Trading status unknown';
  if (trading.sideUnknown) return `Trading ${blockedWord(level)}`;
  return RANK[trading.buy] >= RANK[trading.sell] ? `Buying ${blockedWord(level)}` : `Selling ${blockedWord(level)}`;
}

export type BotTradingView = {
  /** Level after expiry; drives the pill tone. */
  level: TradingLevel;
  /** App wording; `null` when the bot can trade and the claim is current. */
  text: string | null;
  /** Cannot trade now, or could not at its last report and nothing has cleared it since. */
  attention: boolean;
  /** The first restriction's reason, for a tooltip. */
  why: string | null;
};

type CardClock = { trading?: unknown; report_at_ms: number | null; report_stale: boolean };

/**
 * The capability as the app shows it at `nowMs`. It is a current claim only while the bot's own report is
 * current (at most five minutes old and not flagged stale); after that "can trade" turns unverified, while a
 * last-known inability stays and says "stale". `null` when the summary carries no usable capability.
 */
export function botTradingView(card: CardClock, nowMs: number, generatedAtMs: number): BotTradingView | null {
  const raw = parseBotTrading(card.trading);
  if (!raw) return null;
  const reportAt = card.report_at_ms;
  const validReport = reportAt != null && Number.isSafeInteger(reportAt) && reportAt <= generatedAtMs + 5_000 && reportAt <= nowMs + 5_000;
  const ageMs = validReport ? Math.max(0, nowMs - reportAt!) : null;
  const observedAgeMs = raw.observedMs != null && raw.observedMs <= generatedAtMs + 5_000 && raw.observedMs <= nowMs + 5_000
    ? Math.max(0, nowMs - raw.observedMs) : null;
  const expired = card.report_stale || raw.held || ageMs == null || Math.floor(ageMs / 1000) * 1000 > TRADING_MAX_AGE_MS
    || (observedAgeMs != null && Math.floor(observedAgeMs / 1000) * 1000 > TRADING_MAX_AGE_MS);
  const trading = expired ? expiredTrading(raw) : raw;
  const rawAttention = tradingNeedsAttention(raw);
  const summary = tradingSummary(trading);
  const rawSummary = tradingSummary(raw);
  return {
    level: tradingLevel(trading),
    text: expired && rawAttention && rawSummary ? `${rawSummary} · ${raw.held ? 'last known' : 'stale'}` : summary,
    attention: tradingNeedsAttention(trading) || rawAttention,
    why: (raw.restrictions.find(row => row.alert) ?? raw.restrictions[0])?.why ?? null,
  };
}

/** What a summary reason code means, in the app's words (`ReasonText.describe`). Unknown codes are shown as given. */
export function summaryReasonText(code: string): string {
  switch (code) {
    case 'SOURCE_UNAVAILABLE': return 'The source could not be read.';
    case 'NOT_CONFIGURED': return 'No reporting source is registered.';
    case 'FORBIDDEN': return 'Needs administrator access.';
    case 'NO_REGISTRY': return 'No bots are registered.';
    case 'REGISTRY_FROM_STATUS': return 'Bots come from the status feed.';
    case 'NO_SAMPLES': return 'No history yet.';
    case 'NEEDS_TWO_SAMPLES': return 'Needs two samples in the window.';
    case 'QUOTE_MISMATCH': return 'Quote currency differs; not summed.';
    case 'HISTORY_INVALID': return 'Stored history failed validation.';
    case 'HISTORY_READ_FAILED': case 'NOT_READ': return 'History could not be read.';
    case 'OWNER_NOT_CURRENT': return 'Bot report out of date.';
    case 'INVALID': return 'The source returned an invalid answer.';
    case 'PARTIAL_COVERAGE': return 'Some bots are not counted.';
    case 'FIELDS_MISSING': return 'Some fields are missing.';
    case 'PAPER_EXCLUDED': return 'Paper bot, not counted in capital.';
    default: return code;
  }
}

/** `AgeText.compact`: 45s, 12m, 23h, 3d. */
export function compactAge(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  if (value < 48 * 3600) return `${Math.floor(value / 3600)}h`;
  return `${Math.floor(value / 86400)}d`;
}

export type BotDayView = { change: string | null; unit: string | null; note: string | null; reason: string | null };

type CardDay = {
  paper?: boolean;
  pnl_day: { change: string | null; unit: string | null; partial: boolean; stale: boolean; uncovered_ms?: number } | null;
  missing?: { field: string; reason: string }[];
};

/**
 * This bot's 24h change exactly as the summary computed it (`pnl_day`), with the app's note: "stale" or
 * "partial", then "Xm unrecorded" when the change sums across unrecorded time, then "paper". A missing day
 * change keeps the server's reason; it is never shown as zero.
 */
export function botDayView(card: CardDay): BotDayView {
  const day = card.pnl_day;
  if (!day) {
    const reason = card.missing?.find(item => item.field === 'pnl_day')?.reason;
    return { change: null, unit: null, note: card.paper ? 'paper' : null, reason: reason ? summaryReasonText(reason) : null };
  }
  const parts: string[] = [];
  if (day.stale) parts.push('stale'); else if (day.partial) parts.push('partial');
  const gap = day.uncovered_ms;
  if (gap !== undefined && gap !== null) parts.push(...(Number.isSafeInteger(gap) && gap >= 0 ? gap > 0 ? [`${compactAge(gap / 1000)} unrecorded`] : [] : ['unrecorded time unknown']));
  if (card.paper) parts.push('paper');
  return { change: day.change, unit: day.unit, note: parts.length ? parts.join(' · ') : null, reason: null };
}
