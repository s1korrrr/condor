/** Validate and project immutable stored reads. No browser estimator or imputation. */
import { decimal } from "./contract.mjs";
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
      value.every((r) => typeof r === "string" && /^[A-Z_]+$/.test(r)),
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
    const breadth = record(row.breadth);
    check(
      Object.keys(breadth).length === 6 && HORIZONS.every((h) => h in breadth),
    );
    return {
      time: cutoff,
      snapshot_id: row.snapshot_id,
      source_kind: row.source_kind,
      valid,
      expected,
      membership: row.membership_hash,
      gapBefore: row.gap_before === true,
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
  return rows(body.items, 1500).map((row) => {
    check(
      ids.has(row.instrument_a_id) && ids.has(row.instrument_b_id),
      "Correlation contains an unbound instrument.",
    );
    const samples = integer(row.paired_sample_count),
      expected = integer(row.expected_sample_count);
    check(samples <= expected && expected > 0);
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
