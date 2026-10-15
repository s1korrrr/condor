/** Validate and project immutable stored reads. No browser estimator or imputation. */
import { correlationDefinitionId, decimal } from "./contract.mjs";
const HASH = /^[0-9a-f]{64}$/;
const HORIZONS = ["1", "5", "15", "60", "240", "1440"];
function check(value, message = "Invalid stored observation response.") {
  if (!value) throw new Error(message);
}
function record(value) {
  check(value && typeof value === "object" && !Array.isArray(value));
  return value;
}
function rows(value, maximum) {
  check(Array.isArray(value) && value.length <= maximum);
  return value.map(record);
}
function integer(value) {
  check(Number.isSafeInteger(value) && value >= 0);
  return value;
}
function number(value, min = -Infinity, max = Infinity) {
  if (value === null) return null;
  const result = decimal(value);
  check(result >= min && result <= max);
  return result;
}
function text(value, max = 128) {
  check(typeof value === "string" && value.length > 0 && value.length <= max);
  return value;
}
function reasons(value) {
  check(
    Array.isArray(value) &&
      value.length <= 32 &&
      value.every((r) => typeof r === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(r)),
  );
  return value;
}
export function pinned(body, frame) {
  record(body);
  check(
    body.schema_version === "market-picture.v1" &&
      body.snapshot_id === frame.snapshot_id,
    "Mixed-snapshot observation rejected.",
  );
  integer(body.read_at_ms);
  if (body.stream_id != null)
    check(
      body.stream_id === frame.stream_id,
      "Mixed-source observation rejected.",
    );
}

export function projectHistory(body, frame) {
  pinned(body, frame);
  const items = rows(body.items, 1500).map((row) => {
    const cutoff = integer(row.cutoff_ms),
      available = integer(row.available_at_ms);
    check(
      cutoff <= frame.cutoff_ms &&
        cutoff <= available &&
        available <= frame.available_at_ms,
      "History contains future observations.",
    );
    check(row.snapshot_id === null || HASH.test(row.snapshot_id));
    check(["observed", "reconstructed"].includes(row.source_kind));
    const coverage = record(row.coverage);
    const valid = integer(coverage.valid_instruments),
      expected = integer(coverage.expected_instruments);
    check(valid <= expected && HASH.test(row.membership_hash));
    const summaryKeys = Object.keys(record(row.summary ?? {}));
    check(
      !(summaryKeys.includes("relative_volume_24h") && summaryKeys.includes("relative_volume_1h")),
      "History point mixes relative-volume generations.",
    );
    const breadth = record(row.breadth);
    check(
      Object.keys(breadth).length === 6 && HORIZONS.every((h) => h in breadth),
    );
    const normalizedRaw = record(row.normalized_breadth ?? {});
    const normalizedBreadth = {};
    if (Object.keys(normalizedRaw).length) {
      check(Object.keys(normalizedRaw).length === 6 && HORIZONS.every(h => h in normalizedRaw), "History normalized breadth must cover all six horizons.");
      for (const horizon of HORIZONS) {
        const normalized = record(normalizedRaw[horizon]);
        check(Object.keys(normalized).sort().join("|") === ["advances", "declines", "unchanged", "pressure"].sort().join("|"), "History normalized breadth fields are invalid.");
        const count = value => {
          const parsed = number(value, 0);
          check(parsed === null || Number.isInteger(parsed), "History breadth counts must be whole instruments.");
          return parsed;
        };
        normalizedBreadth[horizon] = {
          advances: count(normalized.advances), declines: count(normalized.declines),
          unchanged: count(normalized.unchanged), pressure: number(normalized.pressure, -1, 1),
        };
      }
    }
    const trajectoryRaw = record(row.breadth_trajectory ?? {});
    const breadthTrajectory = {};
    if (Object.keys(trajectoryRaw).length) {
      const expectedKeys = [5, 15, 60].flatMap(h => [5, 15, 60].map(t => `${h}/${t}`));
      check(Object.keys(trajectoryRaw).length === 9 && expectedKeys.every(key => key in trajectoryRaw), "History breadth trajectory must cover all nine intervals.");
      for (const key of expectedKeys) {
        const trajectory = record(trajectoryRaw[key]);
        const required = ["level", "change", "velocity", "acceleration", "matched_count", "expected_count", "matched_membership_hash"];
        const keys = Object.keys(trajectory).sort();
        check(keys.join("|") === [...required].sort().join("|") || keys.join("|") === [...required, "share_change"].sort().join("|"), "History trajectory fields are invalid.");
        const matched = integer(trajectory.matched_count), expectedMatched = integer(trajectory.expected_count);
        const membership = trajectory.matched_membership_hash;
        check(matched <= expectedMatched && (membership === null || HASH.test(membership)), "History matched cohort is invalid.");
        breadthTrajectory[key] = {
          level: number(trajectory.level, -1, 1), change: number(trajectory.change, -2, 2),
          velocity: number(trajectory.velocity), acceleration: number(trajectory.acceleration),
          shareChange: number(trajectory.share_change, -100, 100),
          matched, expected: expectedMatched, membership,
        };
      }
    }
    let flowHistory = null;
    if (row.flow_history != null) {
      const flow = record(row.flow_history);
      const componentId = text(flow.component_id, 64),
        scopeHash = text(flow.scope_hash, 64),
        quoteAsset = text(flow.quote_asset, 16),
        expectedInstruments = integer(flow.expected_instruments),
        observedInstruments = integer(flow.observed_instruments),
        completeInstruments = integer(flow.complete_instruments),
        buyQuote = text(flow.buy_quote, 128),
        sellQuote = text(flow.sell_quote, 128),
        unknownQuote = text(flow.unknown_quote, 128),
        cumulativeDeltaQuote = flow.cumulative_delta_quote == null ? null : text(flow.cumulative_delta_quote, 128),
        resetAt = flow.reset_at_ms == null ? null : integer(flow.reset_at_ms),
        flowReasons = reasons(flow.reason_codes);
      check(flowReasons.length <= 16);
      check(HASH.test(componentId) && HASH.test(scopeHash));
      check(/^[A-Z0-9]{2,16}$/.test(quoteAsset));
      check(expectedInstruments > 0 && expectedInstruments <= 300 &&
        observedInstruments > 0 && observedInstruments <= expectedInstruments && completeInstruments <= observedInstruments);
      check(number(buyQuote, 0) !== null && number(sellQuote, 0) !== null && number(unknownQuote, 0) !== null);
      check(resetAt == null || resetAt <= cutoff, "Flow history reset occurs after its stored point.");
      if (cumulativeDeltaQuote != null) {
        check(resetAt != null && observedInstruments === expectedInstruments &&
          completeInstruments === expectedInstruments && number(unknownQuote, 0) === 0 && flowReasons.length === 0,
        "Unqualified flow history cannot publish cumulative delta.");
        number(cumulativeDeltaQuote);
      } else {
        check(flowReasons.length > 0, "Unavailable cumulative delta needs an owner reason.");
      }
      flowHistory = {
        componentId, quoteAsset, scopeHash, expectedInstruments, observedInstruments,
        completeInstruments, buyQuote, sellQuote, unknownQuote, cumulativeDeltaQuote,
        resetAt, reasons: flowReasons,
      };
    }
    return {
      time: cutoff,
      snapshot_id: row.snapshot_id,
      source_kind: row.source_kind,
      valid,
      expected,
      membership: row.membership_hash,
      gapBefore: row.gap_before === true,
      flowHistory,
      normalizedBreadth,
      breadthTrajectory,
      summary: Object.fromEntries(
        Object.entries(record(row.summary ?? {})).map(([key, value]) => [
          key,
          number(value),
        ]),
      ),
      breadth: Object.fromEntries(
        HORIZONS.map((h) => {
          const v = record(breadth[h]);
          return [
            h,
            {
              positive: number(v.positive, 0, 1),
              negative: number(v.negative, 0, 1),
              flat: number(v.flat, 0, 1),
              pressure: number(v.pressure, -3, 3),
            },
          ];
        }),
      ),
    };
  });
  // Stored pages may arrive newest first; presentation has one deterministic time order.
  items.sort(
    (a, b) =>
      a.time - b.time ||
      String(a.snapshot_id).localeCompare(String(b.snapshot_id)),
  );
  check(
    new Set(items.map((p) => p.time)).size === items.length,
    "Ambiguous history revisions rejected.",
  );
  return items;
}

export function projectCorrelations(body, frame) {
  pinned(body, frame);
  const ids = new Set(frame.assets.map((a) => a.instrument_id));
  const items = rows(body.items, 1500);
  // One stored snapshot publishes one window; its owner definition id is derived from that window.
  check(new Set(items.map((row) => row.expected_sample_count)).size <= 1, "Correlation page mixes sample windows.");
  return items.map((row) => {
    check(
      ids.has(row.instrument_a_id) && ids.has(row.instrument_b_id),
      "Correlation contains an unbound instrument.",
    );
    const samples = integer(row.paired_sample_count),
      expected = integer(row.expected_sample_count);
    check(samples <= expected && expected > 0);
    const definition = correlationDefinitionId(expected);
    const value = number(row.correlation, -1, 1),
      reasonCodes = reasons(row.reason_codes);
    check(
      value === null
        ? reasonCodes.length > 0
        : samples >= Math.ceil(expected * 0.95),
    );
    const cutoff = integer(row.window_end_ms);
    check(cutoff <= frame.cutoff_ms);
    const trend =
      row.trend == null
        ? []
        : rows(row.trend, 30).map((p) => {
            const time = integer(p.cutoff_ms);
            check(time <= cutoff);
            return { time, value: number(p.correlation, -1, 1) };
          });
    check(trend.every((p, i) => i === 0 || p.time > trend[i - 1].time));
    return {
      instrument_id: row.instrument_a_id,
      benchmark_id: row.instrument_b_id,
      value,
      samples,
      expected,
      definition,
      cutoff,
      reasons: reasonCodes,
      trend,
    };
  });
}

export function projectEvents(body, frame) {
  pinned(body, frame);
  return rows(body.items, 100).map((row) => {
    const available = integer(row.available_at_ms),
      observed = integer(row.observed_at_ms);
    check(
      observed <= available && available <= frame.available_at_ms,
      "Event arrived after the selected frame.",
    );
    check(HASH.test(row.snapshot_id));
    check(typeof row.is_historical_reconstruction === "boolean");
    const values = record(row.value);
    check(
      Object.keys(values).length <= 64 &&
        Object.values(values).every((v) => v === null || typeof v === "string"),
    );
    return {
      event_id: text(row.event_id),
      instrument_id: row.instrument_id == null ? null : text(row.instrument_id),
      type: text(row.event_type),
      severity: text(row.severity),
      observed,
      available,
      status: text(row.status),
      reconstructed: row.is_historical_reconstruction,
      snapshot_id: row.snapshot_id,
      horizon_minutes: /^[0-9]{1,5}$/.test(values.horizon_minutes ?? "") ? Number(values.horizon_minutes) : null,
      value: Object.entries(values)
        .map(
          ([key, value]) =>
            `${key.replaceAll("_", " ")}: ${value ?? "—"}`,
        )
        .join(" · "),
    };
  });
}
