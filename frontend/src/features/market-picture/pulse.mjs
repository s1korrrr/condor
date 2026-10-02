/**
 * Pure derivations for the single-page Market view. Everything here is computed from the observed
 * frame (breadth, pressure, asset indicators, predicates) and labelled with its basis; nothing is a
 * stored model output unless the frame itself carries one.
 */
import { HORIZONS, HORIZON_LABELS, marketPulseWindow } from "./model.mjs";

const MINUTES_PER_YEAR = 525_600;
export const VERDICT_THRESHOLD = 0.25;
const PERSISTENCE_HORIZONS = ["15", "60", "240", "1440"];
export const VERDICT_RULE =
  "Verdict = average of up to three equal-weight components, each scaled to -1…+1: " +
  "(1) breadth pressure at the selected horizon ÷ 3; " +
  "(2) mean breadth pressure over 15m, 1h, 4h and 24h ÷ 3; " +
  "(3) mean return at the selected horizon ÷ the volatility-implied move " +
  "(median 24h realized volatility × √(minutes ÷ 525 600)), clamped to ±2σ, ÷ 2. " +
  "Score ≥ +0.25 is Risk-on, ≤ −0.25 is Risk-off, otherwise Mixed. " +
  "Descriptive breadth balance of the observed universe, not a trade signal.";

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
export const horizonLabel = (horizon) =>
  HORIZON_LABELS[HORIZONS.indexOf(String(horizon))] ??
  (String(horizon) === "10080" ? "7d" : `${horizon}m`);

/** Expected move, in percent, for `minutes` given an annualized volatility fraction. */
export function impliedMove(annualVolatility, minutes) {
  if (!finite(annualVolatility) || annualVolatility <= 0) return null;
  return annualVolatility * Math.sqrt(minutes / MINUTES_PER_YEAR) * 100;
}

/**
 * Headline market state. Returns null when no component can be computed, so the page can skip the
 * block rather than print a placeholder.
 */
export function marketVerdict(frame, horizon) {
  if (!frame) return null;
  const pressure = (h) => {
    const value = frame.pressure?.[h]?.value;
    return finite(value) ? value : null;
  };
  const components = [];
  const now = pressure(horizon);
  if (now !== null)
    components.push({
      id: "breadth",
      label: `Breadth pressure · ${horizonLabel(horizon)}`,
      score: clamp(now / 3, -1, 1),
      detail: `${now > 0 ? "+" : ""}${now.toFixed(2)} on a −3…+3 scale`,
    });
  const persistence = PERSISTENCE_HORIZONS.map(pressure).filter((v) => v !== null);
  if (persistence.length >= 2) {
    const mean = persistence.reduce((a, b) => a + b, 0) / persistence.length;
    components.push({
      id: "persistence",
      label: "Persistence · 15m to 24h",
      score: clamp(mean / 3, -1, 1),
      detail: `mean pressure ${mean > 0 ? "+" : ""}${mean.toFixed(2)} over ${persistence.length} horizons`,
    });
  }
  const meanReturn = frame.distribution?.[horizon]?.mean?.value;
  const move = impliedMove(frame.summary?.realized_volatility_24h?.value, Number(horizon));
  if (finite(meanReturn) && move !== null && move > 0) {
    const z = meanReturn / move;
    components.push({
      id: "return",
      label: `Mean return · ${horizonLabel(horizon)}`,
      score: clamp(z, -2, 2) / 2,
      detail: `${meanReturn > 0 ? "+" : ""}${meanReturn.toFixed(2)}% vs ±${move.toFixed(2)}% implied move (${z > 0 ? "+" : ""}${z.toFixed(1)}σ)`,
    });
  }
  if (!components.length) return null;
  const score = components.reduce((sum, c) => sum + c.score, 0) / components.length;
  const state = score >= VERDICT_THRESHOLD ? "risk-on" : score <= -VERDICT_THRESHOLD ? "risk-off" : "mixed";
  const breadth = frame.breadth?.[horizon];
  return {
    state,
    label: state === "risk-on" ? "Risk-on" : state === "risk-off" ? "Risk-off" : "Mixed",
    score,
    horizon,
    components,
    rule: VERDICT_RULE,
    advancing: breadth?.advancing ?? null,
    declining: breadth?.declining ?? null,
    unchanged: breadth?.unchanged ?? null,
    valid: breadth?.valid ?? null,
    expected: breadth?.expected ?? frame.expected,
  };
}

/** One row per horizon for the breadth ladder; rows without a valid share are dropped. */
export function breadthLadder(frame) {
  return HORIZONS.flatMap((h, index) => {
    const b = frame?.breadth?.[h];
    const up = b?.positive?.value,
      down = b?.negative?.value,
      flat = b?.flat?.value;
    if (!b || ![up, down, flat].every(finite)) return [];
    return [
      {
        horizon: h,
        label: HORIZON_LABELS[index],
        advancing: b.advancing,
        declining: b.declining,
        unchanged: b.unchanged,
        valid: b.valid,
        expected: b.expected,
        up,
        down,
        flat,
        pressure: frame.pressure?.[h]?.value ?? null,
      },
    ];
  });
}

/** Per-horizon return heat: colour intensity is the move in units of the asset's own implied move. */
export function returnHeat(asset, horizon) {
  const value = asset.returns?.[horizon]?.value;
  if (!finite(value)) return { value: null, intensity: 0 };
  const move = impliedMove(asset.indicators?.realized_volatility_24h?.value, Number(horizon));
  return { value, intensity: move ? clamp(Math.abs(value) / (2 * move), 0, 1) : clamp(Math.abs(value) / 2, 0, 1) };
}

const metricValue = (asset, group, key) => {
  const value = asset[group]?.[key]?.value;
  return finite(value) ? value : null;
};

/** Trend and momentum read from observed EMA21, ADX14 and RSI14. */
export function assetState(asset) {
  const price = asset.price?.value,
    ema = metricValue(asset, "indicators", "ema21"),
    adx = metricValue(asset, "indicators", "adx14"),
    rsi = metricValue(asset, "indicators", "rsi14");
  const emaDistance = finite(price) && ema ? ((price - ema) / ema) * 100 : null;
  const trending = metricValue(asset, "predicates", "trending");
  let trend = null;
  if (trending === 1) trend = emaDistance === null ? "Trending" : emaDistance >= 0 ? "Uptrend" : "Downtrend";
  else if (trending === 0) trend = "Range";
  const rsiZone = rsi === null ? null : rsi >= 70 ? "Overbought" : rsi <= 30 ? "Oversold" : rsi >= 50 ? "Bullish" : "Bearish";
  return { trend, adx, rsi, rsiZone, emaDistance };
}

/**
 * Regime per asset. A stored regime observation wins; otherwise the label is derived from the
 * observed ADX14 / ATR14 / EMA21 / realized-volatility predicates and says so.
 */
export function derivedRegime(asset) {
  const stored = asset.regimes?.[0];
  if (stored)
    return { label: stored.label, basis: "stored", tags: [], detail: `${stored.origin} · ${stored.model ?? "model not named"}` };
  const flag = (key) => metricValue(asset, "predicates", key);
  const { trend, emaDistance } = assetState(asset);
  if (trend === null && flag("compression") === null && flag("high_volatility") === null) return null;
  const tags = [];
  if (flag("compression") === 1) tags.push("Compression");
  if (flag("high_volatility") === 1) tags.push("High volatility");
  if (flag("elevated_rvol") === 1) tags.push("Elevated volume");
  let label;
  if (trend === "Uptrend") label = "Trend up";
  else if (trend === "Downtrend") label = "Trend down";
  else if (trend === "Trending") label = "Trending";
  else if (flag("high_volatility") === 1) label = "Volatile range";
  else if (flag("compression") === 1) label = "Compression";
  else label = "Range";
  return {
    label,
    basis: "derived",
    tags: tags.filter((tag) => tag.toLowerCase() !== label.toLowerCase()),
    detail:
      emaDistance === null
        ? "derived from observed ADX14, ATR14 and RSI14"
        : `derived from observed ADX14, ATR14, EMA21 (${emaDistance >= 0 ? "+" : ""}${emaDistance.toFixed(2)}% vs EMA21)`,
  };
}

export const REGIME_BASIS =
  "Derived from observed ADX14 / ATR14 / EMA21 / RSI14 and the frame's participation predicates, not a stored regime model.";

/** Market-level regime read-out from the predicate shares. */
export function regimeSummary(frame) {
  const part = (key) => frame?.participation?.[key];
  const items = [
    ["trending", "Trending", "ADX14 > 25"],
    ["compression", "Compressed", "ATR14 percentile ≤ 20"],
    ["high_volatility", "High volatility", "realized vol > 80%"],
    ["elevated_rvol", "Elevated volume", "RVOL > 1.5×"],
  ].flatMap(([key, label, rule]) => {
    const metric = part(key);
    if (!metric || !finite(metric.value)) return [];
    return [{ key, label, rule, share: metric.value, count: Math.round(metric.value * metric.valid), valid: metric.valid }];
  });
  return items;
}

const BUCKETS = [1, 2, 5, 10, 15, 30, 60];
/** Smallest standard bucket (minutes) that keeps a window near `target` plotted points. */
export function bucketMinutes(spanMs, target = 240) {
  const wanted = spanMs / 60_000 / target;
  return BUCKETS.find((m) => m >= wanted) ?? BUCKETS.at(-1);
}

/**
 * Hero series from stored history. One-minute breadth flips constantly on a small universe, so
 * long windows are shown as the mean of fixed buckets (disclosed in the label); a coverage break
 * stays an explicit gap and a bucket never spans it. Nothing is interpolated.
 */
export function pulseSeries(history, window, horizon) {
  const coverage = marketPulseWindow(history, window);
  const samples = coverage.samples;
  const span = samples.length ? samples[samples.length - 1].time - samples[0].time : 0;
  const minutes = bucketMinutes(Math.max(span, 1));
  const size = minutes * 60_000;
  const advancing = [],
    declining = [],
    pressure = [];
  let bucket = null;
  const flush = () => {
    if (!bucket) return;
    const mean = (key) => {
      const values = bucket[key];
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };
    advancing.push({ time: bucket.time, value: mean("up") });
    declining.push({ time: bucket.time, value: mean("down") });
    pressure.push({ time: bucket.time, value: mean("pressure") });
    bucket = null;
  };
  let gapAt = null;
  for (const point of samples) {
    const index = Math.floor(point.time / size);
    if (point.gapBefore || (bucket && bucket.index !== index)) {
      const hadGap = point.gapBefore && (bucket !== null || advancing.length > 0);
      flush();
      if (hadGap) gapAt = point.time;
    }
    if (gapAt !== null && advancing.length) {
      // A null sample just before the first point after a break splits the line.
      for (const list of [advancing, declining, pressure]) list.push({ time: gapAt - 1, value: null });
      gapAt = null;
    }
    const h = point.breadth?.[horizon];
    bucket ??= { index, time: point.time, up: [], down: [], pressure: [] };
    bucket.time = point.time;
    if (finite(h?.positive)) bucket.up.push(h.positive * 100);
    if (finite(h?.negative)) bucket.down.push(h.negative * 100);
    if (finite(h?.pressure)) bucket.pressure.push(h.pressure);
  }
  flush();
  const aggregated = minutes > 1 ? ` · ${minutes}-minute means` : "";
  return { advancing, declining, pressure, label: `${coverage.label}${aggregated}`, samples, bucketMinutes: minutes };
}

/** Whether a stored correlation page carries at least one coefficient worth drawing. */
export function hasCorrelationValues(correlations) {
  return correlations.some((c) => c.instrument_id !== c.benchmark_id && finite(c.value));
}

/**
 * The 40-bin histogram is only informative with enough instruments; small universes are shown as
 * per-instrument bars instead.
 */
export const MIN_DISTRIBUTION_POPULATION = 12;
export function showDistribution(frame, horizon = "1440") {
  return (frame?.distribution?.[horizon]?.total ?? 0) >= MIN_DISTRIBUTION_POPULATION;
}
