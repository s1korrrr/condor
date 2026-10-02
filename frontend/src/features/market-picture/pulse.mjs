/**
 * Pure derivations for the single-page Market view. Everything here is computed from the observed
 * frame (breadth, pressure, asset indicators, predicates) and labelled with its basis; nothing is a
 * stored model output unless the frame itself carries one.
 */
import { correlationDefinitionId } from "./contract.mjs";
import { HORIZONS, HORIZON_LABELS, marketPulseWindow } from "./model.mjs";

const MINUTES_PER_YEAR = 525_600;
/** Score at which a state is entered. */
export const VERDICT_THRESHOLD = 0.25;
/** A held state is only left once the score falls back inside this band around zero. */
export const VERDICT_HOLD = 0.1;
/** Trailing window of the optional pressure and verdict smoothing. */
export const SMOOTHING_MINUTES = 15;
/** Stored history replayed to establish the state the hysteresis band starts from. */
const STATE_LOOKBACK_MS = 6 * 3_600_000;
const PERSISTENCE_HORIZONS = ["15", "60", "240", "1440"];
export const VERDICT_RULE =
  "Verdict = average of up to three equal-weight components, each scaled to -1…+1: " +
  "(1) breadth pressure at the selected horizon ÷ 3; " +
  "(2) mean breadth pressure over 15m, 1h, 4h and 24h ÷ 3; " +
  "(3) mean return at the selected horizon ÷ the volatility-implied move " +
  "(median 24h realized volatility × √(minutes ÷ 525 600)), clamped to ±2σ, ÷ 2. " +
  "With smoothing on, components (1) and (2) use their mean over the trailing 15 minutes of stored frames and the return component stays the latest frame; with it off, every component is the latest frame. " +
  "Score ≥ +0.25 enters Risk-on and ≤ −0.25 enters Risk-off; a state is held until the score is back inside ±0.10, " +
  "and anything else is Mixed. The held state is replayed from the last six hours of stored breadth. " +
  "Descriptive breadth balance of the observed universe, not a trade signal.";

const signedScore = (value) => `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
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

/** Breadth components shared by the latest frame and by stored history points. */
function breadthComponents(pressure, horizon) {
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
  return components;
}

const meanScore = (components) =>
  components.length ? components.reduce((sum, c) => sum + c.score, 0) / components.length : null;

/** Next state under the entry threshold and the hold band. */
export function nextVerdictState(previous, score) {
  if (score >= VERDICT_THRESHOLD) return "risk-on";
  if (score <= -VERDICT_THRESHOLD) return "risk-off";
  if (previous === "risk-on" && score > VERDICT_HOLD) return "risk-on";
  if (previous === "risk-off" && score < -VERDICT_HOLD) return "risk-off";
  return "mixed";
}

/**
 * Trailing mean of `valueOf` over `minutes`, per stored point. Windows restart after a coverage
 * break, null values are skipped, and nothing is interpolated.
 */
export function rollingMean(samples, valueOf, minutes = SMOOTHING_MINUTES) {
  const span = minutes * 60_000;
  const out = [];
  let window = [];
  let sum = 0;
  for (const point of samples) {
    if (point.gapBefore) {
      window = [];
      sum = 0;
    }
    const value = valueOf(point);
    if (finite(value)) {
      window.push({ time: point.time, value });
      sum += value;
    }
    while (window.length && window[0].time <= point.time - span) sum -= window.shift().value;
    out.push(window.length ? sum / window.length : null);
  }
  return out;
}

/**
 * The state the hold band carries into the latest frame: stored breadth-only scores at `horizon`
 * (their trailing mean when `smooth`) replayed over the last six hours, with a coverage break
 * resetting it, so the same history always yields the same state. Also returns each stored point's
 * component scores for the smoothing window.
 */
function replayState(history, horizon, until, smooth) {
  const points = history.filter((p) => p.time < until && p.time >= until - STATE_LOOKBACK_MS);
  const scored = points.map((p) => {
    const components = breadthComponents(
      (h) => (finite(p.breadth?.[h]?.pressure) ? p.breadth[h].pressure : null),
      horizon,
    );
    return { ...p, components: Object.fromEntries(components.map((c) => [c.id, c.score])), score: meanScore(components) };
  });
  const basis = smooth ? rollingMean(scored, (p) => p.score) : scored.map((p) => p.score);
  let state = "mixed";
  scored.forEach((p, i) => {
    if (p.gapBefore) state = "mixed";
    if (basis[i] !== null) state = nextVerdictState(state, basis[i]);
  });
  return { state, scored };
}

/** Stored points inside the trailing smoothing window before `until`, newest first, stopping at a break. */
function trailingWindow(scored, until) {
  const span = SMOOTHING_MINUTES * 60_000;
  const window = [];
  for (let i = scored.length - 1; i >= 0; i--) {
    const p = scored[i];
    if (until - p.time >= span) break;
    window.push(p);
    if (p.gapBefore) break;
  }
  return window;
}

/**
 * Headline market state. Returns null when no component can be computed, so the page can skip the
 * block rather than print a placeholder. With `context.history` the breadth components use their
 * trailing 15-minute mean (unless `context.smooth` is false) and a hold band keeps the word from
 * flipping around zero; without it the latest frame alone decides.
 */
export function marketVerdict(frame, horizon, context = {}) {
  if (!frame) return null;
  const pressure = (h) => {
    const value = frame.pressure?.[h]?.value;
    return finite(value) ? value : null;
  };
  const components = breadthComponents(pressure, horizon);
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
  const instantScore = meanScore(components);
  const hasHistory = Array.isArray(context.history);
  const smooth = context.smooth !== false && hasHistory;
  const until = Number.isFinite(frame.cutoff_ms) ? frame.cutoff_ms : Infinity;
  const replay = hasHistory ? replayState(context.history, horizon, until, smooth) : { state: "mixed", scored: [] };
  let shown = components;
  let smoothedFrames = 1;
  if (smooth) {
    const window = trailingWindow(replay.scored, until);
    smoothedFrames = window.length + 1;
    if (window.length)
      shown = components.map((c) => {
        if (c.id === "return") return c;
        const values = [...window.map((p) => p.components[c.id]).filter(finite), c.score];
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        return {
          ...c,
          label: `${c.label} · ${SMOOTHING_MINUTES}m mean`,
          score: mean,
          detail: `${c.detail} · latest score ${signedScore(c.score)}, ${SMOOTHING_MINUTES}-min mean ${signedScore(mean)}`,
        };
      });
  }
  const score = meanScore(shown);
  const state = nextVerdictState(replay.state, score);
  const entered = score >= VERDICT_THRESHOLD ? "risk-on" : score <= -VERDICT_THRESHOLD ? "risk-off" : "mixed";
  const breadth = frame.breadth?.[horizon];
  return {
    state,
    label: state === "risk-on" ? "Risk-on" : state === "risk-off" ? "Risk-off" : "Mixed",
    score,
    instantScore,
    smoothed: smoothedFrames > 1,
    smoothedFrames,
    smoothingMinutes: SMOOTHING_MINUTES,
    held: state !== entered,
    horizon,
    components: shown,
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
  if (flag("elevated_rvol") === 1) tags.push("Volume burst");
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
    ["elevated_rvol", "Volume burst", "1m volume > 1.5× prior 20-bar mean"],
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
 * stays an explicit gap and a bucket never spans it. Nothing is interpolated. `smoothed` is the
 * trailing 15-minute mean of the one-minute pressure (computed before bucketing); `pressure` stays raw.
 */
export function pulseSeries(history, window, horizon) {
  const coverage = marketPulseWindow(history, window);
  const samples = coverage.samples;
  const rolled = rollingMean(samples, (p) => p.breadth?.[horizon]?.pressure ?? null);
  const span = samples.length ? samples[samples.length - 1].time - samples[0].time : 0;
  const minutes = bucketMinutes(Math.max(span, 1));
  const size = minutes * 60_000;
  const advancing = [],
    declining = [],
    pressure = [],
    smoothed = [];
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
    smoothed.push({ time: bucket.time, value: mean("smoothed") });
    bucket = null;
  };
  let gapAt = null;
  for (const [position, point] of samples.entries()) {
    const index = Math.floor(point.time / size);
    if (point.gapBefore || (bucket && bucket.index !== index)) {
      const hadGap = point.gapBefore && (bucket !== null || advancing.length > 0);
      flush();
      if (hadGap) gapAt = point.time;
    }
    if (gapAt !== null && advancing.length) {
      // A null sample just before the first point after a break splits the line.
      for (const list of [advancing, declining, pressure, smoothed]) list.push({ time: gapAt - 1, value: null });
      gapAt = null;
    }
    const h = point.breadth?.[horizon];
    bucket ??= { index, time: point.time, up: [], down: [], pressure: [], smoothed: [] };
    bucket.time = point.time;
    if (finite(h?.positive)) bucket.up.push(h.positive * 100);
    if (finite(h?.negative)) bucket.down.push(h.negative * 100);
    if (finite(h?.pressure)) bucket.pressure.push(h.pressure);
    if (finite(rolled[position])) bucket.smoothed.push(rolled[position]);
  }
  flush();
  const aggregated = minutes > 1 ? ` · ${minutes}-minute means` : "";
  return {
    advancing,
    declining,
    pressure,
    smoothed,
    label: `${coverage.label}${aggregated}`,
    samples,
    bucketMinutes: minutes,
  };
}

/**
 * Owner v1 relative-volume definitions divide the latest single 1-minute quote volume by a longer
 * mean. A minute's volume is zero-inflated and heavy-tailed on thin USDC books, so the typical
 * reading is far below 1× (live: median per instrument 0.06–0.3×, 0 for BNB-USDC) while the mean is
 * about 1×. Showing that as "relative volume" reads like a volume collapse, so the tile is dropped
 * until the owner publishes an aggregated (for example 1-hour) definition.
 */
const SINGLE_BAR_VOLUME_DEFINITIONS = ["median_relative_volume_24h", "rvol24h", "rvol20"];
export function isSingleBarRelativeVolume(metric) {
  const [id, version = ""] = String(metric?.definition ?? "").split(" ");
  return SINGLE_BAR_VOLUME_DEFINITIONS.includes(id) && /^v1(\.|$)/.test(version);
}

/**
 * The hourly definition (last 60 closed minutes over the mean of the prior 24 hourly sums) is the
 * aggregated reading the single-minute definitions lacked, so it is shown, with its basis spelled out.
 */
const HOURLY_VOLUME_DEFINITIONS = ["median_relative_volume_1h", "rvol1h"];
export function isHourlyRelativeVolume(metric) {
  const [id, version = ""] = String(metric?.definition ?? "").split(" ");
  return HOURLY_VOLUME_DEFINITIONS.includes(id) && /^v1(\.|$)/.test(version);
}

const NULL_REASON_LABELS = {
  ZERO_BASELINE: "no volume in the 24h baseline",
  INSUFFICIENT_HISTORY: "history still building",
  INSUFFICIENT_COVERAGE: "too few instruments with a value",
};
/** A withheld value is labelled with its owner reason code; it is never replaced by a generic word. */
export function nullReasonLabel(metric) {
  const codes = metric?.reasons ?? [];
  if (metric?.value != null || !codes.length) return null;
  return codes.map((code) => (NULL_REASON_LABELS[code] ? `${NULL_REASON_LABELS[code]} (${code})` : code)).join(", ");
}

/**
 * On a five-instrument universe every 1m and 5m breadth crossing is one instrument changing sign, so
 * they arrive every minute or two and bury the rest of the alert feed. The feed folds them behind a
 * count instead of deleting them.
 */
export const SHORT_BREADTH_MINUTES = 15;
export const isShortBreadthCrossing = (event) =>
  event.type === "breadth_threshold_crossing" && event.horizon_minutes !== null && event.horizon_minutes < SHORT_BREADTH_MINUTES;

/** Whether a stored correlation page carries at least one coefficient worth drawing. */
export function hasCorrelationValues(correlations) {
  return correlations.some((c) => c.instrument_id !== c.benchmark_id && finite(c.value));
}

/** `2160` hourly returns read as "90D", `168` as "7D"; anything that is not whole days stays in hours. */
export function correlationWindowLabel(hours) {
  return hours % 24 === 0 ? `${hours / 24}D` : `${hours}h`;
}

/**
 * What the stored correlation set can say. `values`: at least one coefficient, labelled with the
 * window its owner computed it over (the longest window among drawn coefficients, with the real
 * paired count). `building`: every coefficient is withheld, so the real history size is shown against
 * the 95% needed. `none`: nothing is attached. Coefficients are never estimated here.
 */
export function correlationReadout(correlations) {
  const pairs = correlations.filter((c) => c.instrument_id !== c.benchmark_id);
  const drawn = pairs.filter((c) => finite(c.value));
  if (drawn.length) {
    const expected = Math.max(...drawn.map((c) => c.expected));
    const samples = Math.min(...drawn.filter((c) => c.expected === expected).map((c) => c.samples));
    return {
      kind: "values", expected, samples, window: correlationWindowLabel(expected),
      definition: correlationDefinitionId(expected), partial: expected < 2160,
    };
  }
  if (!pairs.length) return { kind: "none" };
  const expected = Math.max(...pairs.map((c) => c.expected));
  const samples = Math.max(...pairs.map((c) => c.samples));
  const needed = Math.ceil(expected * 0.95);
  return {
    kind: "building",
    expected,
    definition: correlationDefinitionId(expected),
    samples,
    needed,
    window: correlationWindowLabel(expected),
    share: expected > 0 ? samples / expected : 0,
  };
}

/**
 * The 40-bin histogram is only informative with enough instruments; small universes are shown as
 * per-instrument bars instead.
 */
export const MIN_DISTRIBUTION_POPULATION = 12;
export function showDistribution(frame, horizon = "1440") {
  return (frame?.distribution?.[horizon]?.total ?? 0) >= MIN_DISTRIBUTION_POPULATION;
}
