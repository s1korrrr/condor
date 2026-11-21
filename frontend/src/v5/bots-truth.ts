import type { PaperRead } from "./contracts";
import { ownerCodeWords } from "./owner-codes.ts";
import { PAIRS } from "./paper-candles.ts";
import { phoneRecordTime } from "./phone-records.ts";
import { paperCompleteRead, paperOpenExecutorCount, paperReadState, paperRetainedRecords, paperSectionError, paperTime } from "./policy.ts";
import { PAPER_SNAPSHOT_FRESH_MS, paperTimestampIssue } from "./snapshot-presentation.ts";

/**
 * Display models for the Bots page truth fixes (W-T2). Display only: each figure is what the owner published, with its
 * time, or a statement of exactly what was not published. Nothing here counts, infers or fills a missing owner value.
 */

type Row = Record<string, unknown>;
const TERMINAL = new Set(["closed", "completed", "terminated"]);
const ACTIVE = new Set(["active", "running", "partial_close", "open", "not_started", "shutting_down"]);
const state = (row: Row) => String(row.state).toLowerCase();
const isActive = (row: Row) => row.terminal !== true && !TERMINAL.has(state(row)) && ACTIVE.has(state(row));
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const coinOf = (pair: unknown) => typeof pair === "string" && pair ? pair.split("-")[0] : null;

export interface ExecutorsRead {
  /** Rows the owner actually published in this (possibly partial) read. */
  rows: number;
  /** Rows of those that are active executors. */
  active: number;
  /** Active executors that name no trading pair. */
  unpaired: number;
  byPair: Record<string, number>;
  /** The owner's stated reason the read is not complete, in words. */
  why: string | null;
}

/**
 * What an executors read that is NOT a provable open set did publish: rows read and the active ones among them.
 * Null when the open set is provable (use paperOpenExecutorCount) or when no rows were published at all.
 */
export function executorsPartialRead(read: PaperRead | undefined, now: number): ExecutorsRead | null {
  if (!read || read.section !== "executors" || paperOpenExecutorCount(read, now) !== null) return null;
  // Only a current read: rows from a stale or undated read are history, not "the rows actually read" now.
  if (typeof read.generated_at_ms !== "number" || paperTimestampIssue(read.generated_at_ms, now) || now - read.generated_at_ms > PAPER_SNAPSHOT_FRESH_MS || !["available", "degraded"].includes(read.state)) return null;
  if (paperSectionError(read) || !Array.isArray(read.data) || read.data.some(row => !row || typeof row !== "object")) return null;
  const rows = read.data as Row[];
  const active = rows.filter(isActive);
  const byPair: Record<string, number> = {};
  for (const row of active) if (typeof row.trading_pair === "string" && row.trading_pair) byPair[row.trading_pair] = (byPair[row.trading_pair] ?? 0) + 1;
  const reason = read.stale_reason ?? read.reason;
  const known = ownerCodeWords(reason);
  return { rows: rows.length, active: active.length, unpaired: active.filter(row => typeof row.trading_pair !== "string" || !row.trading_pair).length, byPair, why: known ? known.words ?? known.code : null };
}

/** True when the executors read cannot prove the open set, so no executor or sell-order figure may be presented as a count. */
export const executorsOpenSetUnknown = (read: PaperRead | undefined, now: number) => paperOpenExecutorCount(read, now) === null;

/** Open executors tile when the open set is not provable: "partial · not published" plus the count actually read. */
export function openExecutorsPartial(read: PaperRead | undefined, now: number): { value: string; note: string } | null {
  if (!executorsOpenSetUnknown(read, now)) return null;
  const partial = executorsPartialRead(read, now);
  const when = typeof read?.generated_at_ms === "number" ? ` · owner read ${paperTime(read.generated_at_ms, now)}` : "";
  if (!partial) return { value: "Not published", note: `Executors read unavailable or not current · no executor count is inferred${when}` };
  return {
    value: "partial · not published",
    note: `${plural(partial.active, "active executor", "active executors")} among the ${plural(partial.rows, "row", "rows")} actually read · the owner's list is incomplete${partial.why ? `: ${partial.why}` : ""} · not a total${when}`,
  };
}

/** "Sell orders placed" text when the executors read cannot prove the open set (never "0 of N"). */
export function sellOrdersPartial(read: PaperRead | undefined, pair: string, now: number): string {
  const partial = executorsPartialRead(read, now);
  if (!partial) return "partial · not published · no executor rows read";
  const coin = coinOf(pair) ?? pair;
  const mine = partial.byPair[pair] ?? 0;
  const read_ = `${mine ? plural(mine, "active executor", "active executors") : "no active executor"} for ${coin} among the ${plural(partial.rows, "row", "rows")} read`;
  return `partial · not published · ${read_}${partial.unpaired ? ` (+${plural(partial.unpaired, "active executor", "active executors")} with no pair)` : ""}`;
}

/**
 * Fills newest first by qualified time, then by the owner's order and trade IDs descending. Undated fills stay in owner order.
 */
export function newestFirstFills(rows: Row[] | null, timeOf: (row: Row) => number | null = row => typeof row.event_at_ms === "number" && Number.isFinite(row.event_at_ms) ? row.event_at_ms : null): Row[] | null {
  if (!rows) return rows;
  const descendingId = (first: unknown, second: unknown) => typeof first === "string" && typeof second === "string" && first !== second ? (first < second ? 1 : -1) : 0;
  const dated = rows.filter(row => timeOf(row) !== null).sort((first, second) => timeOf(second)! - timeOf(first)!
    || descendingId(first.order_id, second.order_id) || descendingId(first.trade_id, second.trade_id));
  return [...dated, ...rows.filter(row => timeOf(row) === null)];
}

export interface LastFill { pair: string; side: string | null; at: number | null; price: string | null; rows: number }

/** Newest fill per pair among the rows this read actually published; a pair with none says so. */
export function lastFillPerPair(read: PaperRead | undefined, pairs: readonly string[], now: number): { complete: boolean; rows: LastFill[] } | null {
  const fills = paperRetainedRecords(read, now);
  if (!read || !fills) return null;
  const timeOf = (row: Row) => phoneRecordTime(row, now, read.generated_at_ms);
  const rows = pairs.map(pair => {
    const mine = fills.filter(row => row.trading_pair === pair);
    const newest = newestFirstFills(mine, timeOf)?.[0];
    return { pair, rows: mine.length, side: typeof newest?.side === "string" ? newest.side : null, at: newest ? timeOf(newest) : null, price: typeof newest?.price === "string" ? newest.price : null };
  });
  return { complete: paperCompleteRead(read, now), rows };
}

interface EntryPause {
  state: "paused";
  paused: number;
  unknown: number;
  updated: [earliest: number, latest: number] | null;
  reasons: string[];
  noUpdate: number;
  noReason: number;
  unread: string | null;
}

type EntryPauseState = EntryPause | { state: "not-paused" } | { state: "unknown"; unknown: number | null };

function ownerTime(value: unknown, now: number): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(number) || number <= 0) return null;
  // The owner publishes epoch seconds or milliseconds; a count below 1e11 can only be seconds.
  const ms = typeof value === "string" && !/^\d+(\.\d+)?$/.test(value.trim()) ? number : number < 1e11 ? Math.round(number * 1000) : number;
  return paperTimestampIssue(ms, now) === null ? ms : null;
}

/**
 * Current decisions report individual pair states. Current risk can witness a pause but cannot prove its scope or a clear.
 */
export function entryPause(decisions: PaperRead | undefined, now: number, riskPaused = false, retained = false): EntryPauseState {
  const controllers = (decisions?.data as { controllers?: Row[] } | null)?.controllers;
  const usable = !retained && decisions?.section === "decisions" && paperCompleteRead(decisions, now) && Array.isArray(controllers);
  const reports = new Map<string, Row | null>();
  for (const row of usable ? controllers : []) {
    const pair = Array.isArray(row.pair) ? row.pair[0] : row.pair;
    if (typeof pair !== "string" || !PAIRS.includes(pair)) continue;
    const info = row.custom_info && typeof row.custom_info === "object" && !Array.isArray(row.custom_info) ? row.custom_info as Row : {};
    const operator = info.operator && typeof info.operator === "object" && !Array.isArray(info.operator) ? info.operator as Row : null;
    reports.set(pair, reports.has(pair) ? null : operator);
  }
  const paused = [...reports.values()].flatMap(report => report?.entry_paused === true ? [report] : []);
  const unknown = PAIRS.length - paused.length - [...reports.values()].filter(report => report?.entry_paused === false).length;
  if (!paused.length) {
    if (!riskPaused) return unknown ? { state: "unknown", unknown: usable ? unknown : null } : { state: "not-paused" };
    const unread = !decisions ? "decisions read not available" : retained ? "decisions read retained" : !usable ? `decisions read ${paperReadState(decisions, now) === "stale" ? "stale" : "incomplete"}` : "no controller in the decisions read reports it";
    return { state: "paused", paused: 0, unknown, updated: null, reasons: [], noUpdate: 0, noReason: 0, unread };
  }
  const times = paused.map(report => ownerTime(report.updated_at, now)).filter((time): time is number => time !== null);
  const reasons = paused.flatMap(({ reason }) => typeof reason === "string" && reason.trim() ? [reason.trim().slice(0, 200)] : []);
  return {
    state: "paused", paused: paused.length, unknown,
    updated: times.length ? [Math.min(...times), Math.max(...times)] : null,
    reasons: [...new Set(reasons)], noUpdate: paused.length - times.length, noReason: paused.length - reasons.length,
    unread: null,
  };
}

/** The banner sentence: what is paused, when it was updated and why. */
export function entryPauseText(pause: EntryPause, now: number): { lead: string; reasons: string[]; missing: string | null } {
  const scope = pause.paused ? ` (${pause.paused} of ${PAIRS.length}${pause.unknown ? ` paused · ${pause.unknown} unknown` : " pairs"})` : "";
  const update = pause.updated ? ` · updated ${paperTime(pause.updated[0], now)}${pause.updated[0] === pause.updated[1] ? "" : ` – ${paperTime(pause.updated[1], now)}`}` : "";
  const lead = `Entries paused${scope}${update}`;
  const parts: string[] = [];
  if (!pause.updated || pause.noUpdate) parts.push(!pause.updated ? "update time not published (owner field custom_info.operator.updated_at)" : `update time not published for ${plural(pause.noUpdate, "pair", "pairs")}`);
  if (!pause.reasons.length || pause.noReason) parts.push(!pause.reasons.length ? "reason not published (owner field custom_info.operator.reason)" : `reason not published for ${plural(pause.noReason, "pair", "pairs")}`);
  if (pause.unread) parts.push(pause.unread);
  return { lead, reasons: pause.reasons, missing: parts.join(" · ") || null };
}
