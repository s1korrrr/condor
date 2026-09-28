/** Presentation only. All financial values and denominators come from owner frames. */
export const HORIZONS = ["1", "5", "15", "60", "240", "1440"];
export const HORIZON_LABELS = ["1m", "5m", "15m", "1h", "4h", "24h"];
export const BENCHMARKS = ["BTC", "ETH", "BNB", "SOL"];
const INSTRUMENT = /^okx:spot:[A-Z0-9]{1,30}-[A-Z0-9]{1,12}$/;

export function acceptFrame(previous, incoming) {
  if (!previous) return incoming;
  if (previous.stream_id !== incoming.stream_id)
    throw new Error("Market Picture source changed. Reopen the source.");
  if (previous.epoch === incoming.epoch) {
    if (incoming.sequence < previous.sequence)
      throw new Error("Market Picture sequence regressed.");
    if (incoming.sequence === previous.sequence) {
      if (
        incoming.payload_digest !== previous.payload_digest ||
        incoming.snapshot_id !== previous.snapshot_id
      )
        throw new Error("Market Picture same-sequence mutation rejected.");
      return previous;
    }
  }
  if (incoming.available_at_ms < previous.available_at_ms)
    throw new Error("Market Picture availability regressed.");
  if (incoming.cutoff_ms < previous.cutoff_ms)
    throw new Error("Market Picture observation cutoff regressed.");
  return incoming;
}

export function ageState(frame, now, frozen) {
  if (!frame) return { mode: "UNAVAILABLE", freshness: "STALE", ageMs: null };
  return {
    mode: frozen
      ? "FROZEN"
      : frame.fixture_marker
        ? "FIXTURE"
        : frame.source_kind === "reconstructed"
          ? "RECONSTRUCTED"
          : "LIVE",
    freshness:
      now < frame.available_at_ms
        ? "FUTURE"
        : now >= frame.expires_at_ms
        ? "STALE"
        : now - frame.cutoff_ms > 90_000
          ? "LAGGING"
          : "FRESH",
    ageMs: Math.max(0, now - frame.cutoff_ms),
  };
}

export function normalizeView(value = {}) {
  return {
    horizon: HORIZONS.includes(value.horizon) ? value.horizon : "15",
    window: ["6h", "24h", "7d"].includes(value.window) ? value.window : "24h",
    benchmark: BENCHMARKS.includes(value.benchmark) ? value.benchmark : "BTC",
    sector:
      typeof value.sector === "string" &&
      /^[A-Za-z0-9 .&_-]{1,40}$/.test(value.sector)
        ? value.sector
        : "All",
    selected:
      typeof value.selected === "string" && INSTRUMENT.test(value.selected)
        ? value.selected
        : null,
  };
}
export function parseView(search) {
  const params = new URLSearchParams(search);
  return normalizeView(
    Object.fromEntries(
      ["horizon", "window", "benchmark", "sector", "selected"].map((key) => [
        key,
        params.get(key),
      ]),
    ),
  );
}
export function viewQuery(value) {
  return (
    "?" +
    new URLSearchParams(
      Object.entries(normalizeView(value)).filter(([, v]) => v != null),
    ).toString()
  );
}
export function rankAssets(assets, valueFor, limit = 5) {
  const valid = assets
    .map((asset) => ({ asset, value: valueFor(asset) }))
    .filter(({ value }) => typeof value === "number" && Number.isFinite(value));
  const tie = (a, b) =>
    a.asset.instrument_id.localeCompare(b.asset.instrument_id);
  return {
    leaders: valid
      .filter((a) => a.value > 0)
      .sort((a, b) => b.value - a.value || tie(a, b))
      .slice(0, limit)
      .map((a) => a.asset),
    laggards: valid
      .filter((a) => a.value < 0)
      .sort((a, b) => a.value - b.value || tie(a, b))
      .slice(0, limit)
      .map((a) => a.asset),
  };
}
export function csvCell(value) {
  const text = value == null ? "" : String(value);
  const safe =
    /^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}
export function heatmapColor(value) {
  if (value == null || !Number.isFinite(value)) return "#182b3d";
  if (value === 0) return "#536b80";
  const intensity = Math.min(Math.abs(value) / 10, 1);
  return value > 0
    ? `hsl(162 83% ${18 + 24 * intensity}%)`
    : `hsl(351 70% ${22 + 29 * intensity}%)`;
}
/** Layout area only. Owner weights are prior-day quote-volume shares. */
export function heatmapAreas(weights, equal = false) {
  const positive = weights.filter(v => v != null && Number.isFinite(v) && v > 0)
    .map(v => Math.sqrt(v)).sort((a, b) => a - b);
  const equalSize = equal || positive.length === 0;
  const minimum = positive.length ? .05 * (positive[Math.floor((positive.length - 1) / 2)]
    + positive[Math.ceil((positive.length - 1) / 2)]) / 2 : 1;
  return { equalSize, minimum, areas: weights.map(v => equalSize ? 1
    : Math.max(v != null && Number.isFinite(v) && v > 0 ? Math.sqrt(v) : minimum, minimum)) };
}
export function histogramMembers(assets, valueFor, low, high, includeUpper) {
  return assets
    .filter((asset) => {
      const value = valueFor(asset);
      // The last interior bin owns +10 exactly; the overflow tail is strictly greater.
      return (
        value != null &&
        Number.isFinite(value) &&
        (high === Infinity ? value > low : value >= low) &&
        (value < high || (includeUpper && value === high))
      );
    })
    .map((asset) => asset.instrument_id);
}
/** Display bin index, including the explicit tails; no return is recomputed. */
export function histogramBinIndex(value, edges) {
  if (value < edges[0]) return 0;
  if (value > edges.at(-1)) return edges.length;
  const upper = edges.findIndex(edge => edge > value);
  return upper < 0 ? edges.length - 1 : upper;
}
export function stableAssetOrder(assets, sort, previousIds = null) {
  const ordered = assets.slice().sort((a, b) => {
    if (sort === "return") {
      const av = a.returns["1440"]?.value,
        bv = b.returns["1440"]?.value;
      if (av == null && bv != null) return 1;
      if (av != null && bv == null) return -1;
      if (av != null && bv != null && av !== bv) return bv - av;
    }
    return a.instrument_id.localeCompare(b.instrument_id);
  });
  if (!previousIds) return ordered;
  const positions = new Map(previousIds.map((id, index) => [id, index]));
  return ordered.sort(
    (a, b) =>
      (positions.get(a.instrument_id) ?? Infinity) -
      (positions.get(b.instrument_id) ?? Infinity),
  );
}

export function pollDelay(failures, random = Math.random()) {
  return failures
    ? Math.min(30_000, 2000 * 2 ** Math.min(failures, 4) * (0.9 + random * 0.2))
    : 2000;
}
export function formatNumber(value, digits = 1, sign = false) {
  if (value == null || !Number.isFinite(Number(value))) return "Unavailable";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    signDisplay: sign ? "exceptZero" : "auto",
  }).format(Number(value));
}
export function downloadFile(filename, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Existing screener links keep their original parser and authorization scope. */
export function nativeViewSearch(search) {
  const params = new URLSearchParams(search);
  return ["screen", "interval", "search", "filters", "server", "bot", "sort", "direction"].some(key => params.has(key)) ? search : "";
}
