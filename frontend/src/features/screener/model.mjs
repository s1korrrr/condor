export const SCREENS = [
  ["all", "All available"], ["rsi_low", "RSI low"], ["rsi_high", "RSI high"],
  ["rsi_recovery", "RSI recovery"], ["rising_momentum", "Rising momentum"],
  ["falling_momentum", "Falling momentum"], ["volume_expansion", "Volume expansion"],
  ["volatility_leaders", "Volatility leaders"], ["compression", "Compression"], ["watchlist", "Watchlist"],
];

export const COLUMNS = [
  ["price", "Price", ["price"]],
  ["return_1h", "1h", ["return_1h", "return_60m"]],
  ["rsi_14", "RSI 14", ["rsi_14"]],
  ["atr_pct_14", "ATR %", ["atr_pct_14"]],
  ["rvol_20", "RVOL 20", ["rvol_20"]],
  ["turnover_24h", "Turnover · USDC", ["turnover_24h"]],
];

export function scopeKey(user, server, bot, lane = "spot", quote = "USDC", interval = "1m") {
  return `condor.screener.v1:${encodeURIComponent(user || "anonymous")}:${encodeURIComponent(server || "none")}:${encodeURIComponent(bot || "none")}:${lane}:${quote}:${interval}`;
}

// Saved views, notes and the watchlist belong to the user/source market scope;
// changing the observation interval must not make them disappear.
export function storageScopeKey(user, server, bot, lane = "spot", quote = "USDC") {
  return `condor.screener.v1:${encodeURIComponent(user || "anonymous")}:${encodeURIComponent(server || "none")}:${encodeURIComponent(bot || "none")}:${lane}:${quote}`;
}

export function storageRead(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { value: null, error: null };
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.views) || !Array.isArray(parsed.watchlist) || !Array.isArray(parsed.notes)
      || parsed.views.some(view => !view || typeof view.name !== "string" || !SCREENS.some(([id]) => id === view.screen) || !["1m", "5m", "15m"].includes(view.interval) || typeof view.search !== "string" || !Array.isArray(view.columns) || view.columns.some(column => typeof column !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(column)) || (view.filters && !validFilter(view.filters)) || (view.sortMetric !== undefined && (typeof view.sortMetric !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(view.sortMetric))) || (view.sortDirection !== undefined && !["asc", "desc"].includes(view.sortDirection)) || (view.display !== undefined && !["table", "heatmap"].includes(view.display)) || (view.compareIds !== undefined && (!Array.isArray(view.compareIds) || view.compareIds.length > 4 || view.compareIds.some(id => typeof id !== "string" || !/^okx:spot:[A-Z0-9]{2,20}-[A-Z0-9]{2,20}$/.test(id)))))
      || parsed.watchlist.some(id => typeof id !== "string" || !/^okx:spot:[A-Z0-9]{2,20}-[A-Z0-9]{2,20}$/.test(id))
      || parsed.notes.some(note => !note || typeof note.instrument_id !== "string" || !/^okx:spot:[A-Z0-9]{2,20}-[A-Z0-9]{2,20}$/.test(note.instrument_id) || typeof note.text !== "string" || typeof note.updated_at !== "string")) return { value: null, error: "Saved screener data was invalid and has been ignored." };
    return { value: parsed, error: null };
  } catch {
    return { value: null, error: "Browser storage is unavailable. This screener session can still be used." };
  }
}

export function storageWrite(storage, key, value) {
  try { storage.setItem(key, JSON.stringify({ version: 1, ...value })); return null; }
  catch { return "This change is only available until the page closes because browser storage is unavailable."; }
}

export function metricFor(row, aliases) {
  for (const name of aliases) if (row?.metrics?.[name]) return row.metrics[name];
  return null;
}

export function metricSortValue(metric) {
  if (!metric || metric.status !== "valid" || metric.value == null) return null;
  const n = Number(metric.value);
  return Number.isFinite(n) ? n : null;
}

export function snapshotFreshness(snapshot, now, intervalMs, failed = false) {
  if (!snapshot) return "Unavailable";
  const observed = snapshot.observed_at ? Date.parse(snapshot.observed_at) : NaN;
  if (!Number.isFinite(observed)) return "Freshness unavailable · observation timestamp missing";
  const age = now - observed;
  if (age < -2000) return "Invalid future observation";
  if (age > intervalMs * 2) return "Unavailable · observation aged out";
  if (failed) return "Read failed · last snapshot retained";
  if (snapshot.completeness === "unavailable") return "Unavailable";
  if (snapshot.completeness === "partial") return "Partial coverage";
  if (age > intervalMs + 10000) return "Stale";
  return "Recorded candles";
}

export function formatDisplayNumber(value, digits = 2, price = false) {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const exactSmall = number !== 0 && Math.abs(number) < 10 ** -digits;
  return new Intl.NumberFormat(undefined, price || exactSmall ? { maximumSignificantDigits: price ? 8 : 4 } : { maximumFractionDigits: digits }).format(number);
}

export function sortRows(rows, metricId, direction = "desc") {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = metricSortValue(a.metrics?.[metricId]);
    const bv = metricSortValue(b.metrics?.[metricId]);
    if (av == null || bv == null) return av == null && bv == null ? a.instrument_id.localeCompare(b.instrument_id) : av == null ? 1 : -1;
    return (av - bv) * sign || a.instrument_id.localeCompare(b.instrument_id);
  });
}

export function scopeMatches(expected, current) {
  return expected === current;
}

export function csvEscape(value) {
  const text = value == null ? "" : String(value);
  const formula = /^[\s]*[=+@]/.test(text) || /^[\s]*-(?!\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$)/.test(text);
  const safe = formula ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function snapshotCsv(snapshot) {
  const fields = ["snapshot_id", "query_hash", "source_revision", "feature_set_version", "rank", "instrument_id", "venue", "lane", "exchange_symbol", "base_asset", "quote_asset", "match_reasons"];
  const metricIds = [...new Set(snapshot.rows.flatMap(row => Object.keys(row.metrics || {})))].sort();
  const metricFields = ["value", "status", "unit", "definition_id", "definition_version", "source_id", "source_revision", "observed_at", "available_at", "window_start", "window_end", "sample_count", "required_samples", "reason_codes"];
  const header = [...fields, ...metricIds.flatMap(id => metricFields.map(field => `${id}.${field}`))];
  const lines = [header.map(csvEscape).join(",")];
  for (const row of snapshot.rows) {
    const values = [snapshot.snapshot_id, snapshot.query_hash, snapshot.source_revision, snapshot.feature_set_version, row.rank, row.instrument_id, row.venue, row.lane, row.exchange_symbol, row.base_asset, row.quote_asset, (row.match_reasons || []).join("; ")];
    for (const id of metricIds) {
      const m = row.metrics?.[id]; values.push(...metricFields.map(field => field === "reason_codes" ? (m?.reason_codes || []).join("; ") : m?.[field] ?? (field === "status" ? "unavailable" : "")));
    }
    lines.push(values.map(csvEscape).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function makeViewUrl(view) {
  const params = new URLSearchParams();
  params.set("screen", view.screen);
  params.set("interval", view.interval);
  if (view.search) params.set("search", view.search);
  if (view.filters) params.set("filters", JSON.stringify(view.filters));
  for (const key of ["server", "bot", "sort", "direction"]) if (view[key]) params.set(key, view[key]);
  return `/screener?${params.toString()}`;
}

export function parseViewParams(search) {
  const params = new URLSearchParams(search);
  const keys = new Set(["screen", "interval", "search", "filters", "server", "bot", "sort", "direction"]);
  if (search.length > 16384 || [...params.keys()].some(key => !keys.has(key) || params.getAll(key).length !== 1)) return { error: "The shared view has unsupported, duplicate, or oversized parameters." };
  const allowed = new Set(SCREENS.map(([id]) => id));
  const screen = params.get("screen") || "all";
  const interval = params.get("interval") || "1m";
  let filters = null;
  const rawFilters = params.get("filters");
  if (rawFilters && rawFilters.length > 8192) return { error: "The shared filter definition is too large." };
  try { filters = rawFilters ? JSON.parse(rawFilters) : null; } catch { return { error: "The shared filter definition is not valid JSON." }; }
  if (!allowed.has(screen) || !["1m", "5m", "15m"].includes(interval) || (filters && !validFilter(filters))) return { error: "The shared view contains an unsupported screen, interval, or filter." };
  const extra = Object.fromEntries(["server", "bot", "sort", "direction"].filter(key => params.has(key)).map(key => [key, params.get(key)]));
  if ((extra.server && (extra.server.length > 100 || /[\x00-\x1f]/.test(extra.server))) || (extra.bot && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(extra.bot)) || (extra.sort && !/^[a-z][a-z0-9_]{0,79}$/.test(extra.sort)) || (extra.direction && !["asc", "desc"].includes(extra.direction)) || (params.get("search") || "").length > 80) return { error: "The shared source, sort, or search is invalid." };
  return { value: { screen, interval, search: params.get("search") || "", filters, ...extra } };
}

function validFilter(filters) {
  return filters && ["and", "or"].includes(filters.op) && Array.isArray(filters.predicates) && filters.predicates.length <= 32
    && filters.predicates.every(predicate => predicate && typeof predicate.metric === "string" && ["eq", "neq", "lt", "lte", "gt", "gte", "is_unavailable"].includes(predicate.operator)
      && (predicate.operator === "is_unavailable" || (typeof predicate.value === "string" && /^-?\d+(\.\d+)?$/.test(predicate.value) && Number.isFinite(Number(predicate.value)))));
}

export function makeResearchPacket(snapshot, query, selected, annotations = []) {
  return {
    packet_version: "condor-screener-research.v1",
    intent: "descriptive_screen_export_only",
    execution_authorized: false,
    screen: query.screen,
    interval: query.interval,
    query: { ...query },
    feature_set_version: snapshot.feature_set_version,
    query_hash: snapshot.query_hash,
    snapshot_id: snapshot.snapshot_id,
    source: { id: snapshot.source_id, revision: snapshot.source_revision },
    universe: { id: snapshot.universe_id, revision: snapshot.universe_revision },
    generated_at: snapshot.generated_at,
    observed_at: snapshot.observed_at,
    coverage: snapshot.counts,
    selected_instrument: snapshot.rows.find(row => row.instrument_id === selected?.instrument_id) || null,
    annotations: annotations.map(note => ({ instrument_id: note.instrument_id, text: note.text, updated_at: note.updated_at })),
    rows: snapshot.rows,
  };
}

export function matchTransitions(before, after) {
  const complete = snapshot => snapshot?.completeness === "complete" && !snapshot.next_cursor && snapshot.counts.matched === snapshot.rows.length && !snapshot.counts.stale && snapshot.rows.every(row => Object.values(row.metrics).every(metric => !["stale", "invalid"].includes(metric.status)));
  if (!complete(before) || !complete(after) || before.query_hash !== after.query_hash || before.source_id !== after.source_id) return [];
  const old = new Map(before.rows.map(row => [row.instrument_id, row.exchange_symbol]));
  const next = new Map(after.rows.map(row => [row.instrument_id, row.exchange_symbol]));
  return [...[...next].filter(([id]) => !old.has(id)).map(([instrumentId, symbol]) => ({kind:"entered",instrumentId,symbol})), ...[...old].filter(([id]) => !next.has(id)).map(([instrumentId, symbol]) => ({kind:"left",instrumentId,symbol}))].slice(0,30);
}
