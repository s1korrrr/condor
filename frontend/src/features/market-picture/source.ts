import { api } from "@/lib/api";
import { projectFrame, projectMicrostructureResponse, validateFrame } from "./contract.mjs";
import { observationErrorMessage } from "./source-errors";
import {
  pinned,
  projectHistory,
  projectCorrelations,
  projectEvents,
} from "./stored.mjs";
export { projectCorrelations, projectEvents } from "./stored.mjs";
import type {
  DisplayCorrelation,
  DisplayEvent,
  DisplayFrame,
  HistoryPoint,
} from "./presentation";

export interface FrameBundle {
  frame: DisplayFrame;
  history: HistoryPoint[];
  /** Fixed six-hour history used only to replay the canonical descriptive market state. */
  canonicalHistory: HistoryPoint[] | null;
  canonicalHistoryFault: string | null;
  correlations: DisplayCorrelation[];
  events: DisplayEvent[];
  eventCursor: string | null;
  faults: Record<string, string>;
  components: Record<string, unknown>;
  etag: string | null;
}
const LIMIT = 2 * 1024 * 1024;
const STATE_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
const HISTORY_STEP_MS = 60_000;
const STATE_HISTORY_POINTS = STATE_HISTORY_WINDOW_MS / HISTORY_STEP_MS;
const SNAPSHOT_ID = /^[0-9a-f]{64}$/;
const DEFINITION_REGISTRY_HASH = /^[0-9a-f]{64}$/;
const HISTORY_HORIZONS = ["1", "5", "15", "60", "240", "1440"];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid stored observation response.");
  return value as Record<string, unknown>;
}
function canonicalHistoryFault(history: HistoryPoint[], frame: DisplayFrame): string | null {
  const cutoff = frame.cutoff_ms;
  if (!Number.isSafeInteger(cutoff) || cutoff % HISTORY_STEP_MS !== 0)
    return "Canonical history requires a minute-aligned frame cutoff.";
  const predecessor = history.filter((point) => point.time < cutoff);
  if (history.some((point) => point.time < cutoff - STATE_HISTORY_WINDOW_MS || point.time > cutoff))
    return "Canonical history contains a point outside the pinned six-hour window.";
  if (predecessor.length !== STATE_HISTORY_POINTS)
    return `Canonical history is incomplete (${predecessor.length} of ${STATE_HISTORY_POINTS} one-minute points).`;
  const expectedMembership = frame.membershipHash;
  const expectedDefinitions = frame.raw.definition_registry_hash;
  if (!SNAPSHOT_ID.test(expectedMembership ?? "") || !DEFINITION_REGISTRY_HASH.test(String(expectedDefinitions ?? "")))
    return "Canonical history cannot verify the current membership and definition basis.";
  for (let index = 0; index < STATE_HISTORY_POINTS; index++) {
    const point = predecessor[index];
    const expectedTime = cutoff - STATE_HISTORY_WINDOW_MS + index * HISTORY_STEP_MS;
    if (point.time !== expectedTime)
      return "Canonical history has a missing, duplicate, or unordered one-minute point.";
    if (point.gapBefore)
      return "Canonical history contains a stored coverage gap.";
    if (!SNAPSHOT_ID.test(point.snapshot_id ?? ""))
      return "Canonical history is missing a retained snapshot identity.";
    if (point.membership !== expectedMembership || point.definitionRegistryHash !== expectedDefinitions)
      return "Canonical history crosses a membership or definition basis change.";
  }
  const atCutoff = history.filter((point) => point.time === cutoff);
  // A retained same-cutoff history revision is allowed to have its own snapshot ID. The
  // replay filters it out (`time < cutoff`); only the selected frame supplies the current row.
  if (
    atCutoff.length > 1 ||
    atCutoff.some((point) =>
      point.membership !== expectedMembership ||
      point.definitionRegistryHash !== expectedDefinitions
    )
  )
    return "Canonical history has an ambiguous current-cutoff identity.";
  return null;
}

function canonicalEnvelope(body: Record<string, unknown>, frame: DisplayFrame): void {
  if (
    body.schema_version !== "market-picture.v1" ||
    body.snapshot_id !== frame.snapshot_id ||
    body.stream_id !== frame.stream_id ||
    body.projection !== "canonical_state" ||
    body.window !== "6h" ||
    body.resolution !== "1m" ||
    body.next_cursor !== null ||
    !Number.isSafeInteger(body.read_at_ms)
  )
    throw new Error("Canonical history does not match the pinned six-hour state projection.");
}

function canonicalHistoryRows(body: Record<string, unknown>, frame: DisplayFrame): HistoryPoint[] {
  const items = body.items;
  if (!Array.isArray(items) || items.length > STATE_HISTORY_POINTS + 1)
    throw new Error("Canonical history exceeds its bounded projection.");
  const decimal = (value: unknown): number | null => {
    if (value === null) return null;
    if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))
      throw new Error("Canonical history contains an invalid pressure value.");
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < -3 || parsed > 3)
      throw new Error("Canonical history contains an out-of-range pressure value.");
    return parsed;
  };
  const rows = items.map((item): HistoryPoint => {
    const row = record(item);
    if (
      Object.keys(row).sort().join("|") !==
      ["available_at_ms", "breadth", "coverage", "cutoff_ms", "definition_registry_hash", "gap_before", "membership_hash", "snapshot_id", "source_kind"].sort().join("|")
    ) throw new Error("Canonical history point has an invalid shape.");
    const time = row.cutoff_ms, available = row.available_at_ms;
    if (
      !Number.isSafeInteger(time) || !Number.isSafeInteger(available) ||
      (time as number) > frame.cutoff_ms || (time as number) > (available as number) ||
      (available as number) > frame.available_at_ms
    ) throw new Error("Canonical history contains a future or incoherent observation.");
    if (
      typeof row.snapshot_id !== "string" || !SNAPSHOT_ID.test(row.snapshot_id) ||
      typeof row.membership_hash !== "string" || !SNAPSHOT_ID.test(row.membership_hash) ||
      typeof row.definition_registry_hash !== "string" || !DEFINITION_REGISTRY_HASH.test(row.definition_registry_hash) ||
      !["observed", "reconstructed"].includes(String(row.source_kind)) || typeof row.gap_before !== "boolean"
    ) throw new Error("Canonical history provenance is invalid.");
    const coverage = record(row.coverage);
    if (Object.keys(coverage).sort().join("|") !== "expected_instruments|valid_instruments")
      throw new Error("Canonical history coverage has an invalid shape.");
    const valid = coverage.valid_instruments, expected = coverage.expected_instruments;
    if (!Number.isSafeInteger(valid) || !Number.isSafeInteger(expected) || (valid as number) <= 0 || (valid as number) > (expected as number) || expected !== frame.expected)
      throw new Error("Canonical history coverage does not match the frame universe.");
    const breadth = record(row.breadth);
    if (Object.keys(breadth).sort().join("|") !== [...HISTORY_HORIZONS].sort().join("|"))
      throw new Error("Canonical history breadth horizons are incomplete.");
    const projectedBreadth = Object.fromEntries(HISTORY_HORIZONS.map((horizon) => {
      const point = record(breadth[horizon]);
      if (Object.keys(point).join("|") !== "pressure")
        throw new Error("Canonical history pressure has an invalid shape.");
      return [horizon, { positive: null, negative: null, flat: null, pressure: decimal(point.pressure) }];
    }));
    return {
      time: time as number, snapshot_id: row.snapshot_id, source_kind: row.source_kind as string,
      valid: valid as number, expected: expected as number, membership: row.membership_hash,
      definitionRegistryHash: row.definition_registry_hash, gapBefore: row.gap_before,
      flowHistory: null, normalizedBreadth: {}, breadthTrajectory: {}, summary: {}, breadth: projectedBreadth,
    };
  });
  if (new Set(rows.map((point) => point.snapshot_id)).size !== rows.length)
    throw new Error("Canonical history repeats a retained snapshot identity.");
  return rows;
}
export async function boundedJson(
  response: Response,
): Promise<Record<string, unknown>> {
  if (Number(response.headers.get("Content-Length")) > LIMIT)
    throw new Error("Observation response is too large.");
  if (!response.body) throw new Error("Observation response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > LIMIT) {
        await reader.cancel();
        throw new Error("Observation response is too large.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!response.ok) {
    const body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const detail = body.detail;
    const reasons =
      detail && typeof detail === "object" && !Array.isArray(detail)
        ? (detail as Record<string, unknown>).reasons
        : undefined;
    throw Object.assign(
      new Error(observationErrorMessage(response.status, Array.isArray(reasons) ? reasons : [])),
      { status: response.status },
    );
  }
  return record(parsed);
}

export async function fetchBundle(
  server: string,
  window: string,
  benchmark: string,
  signal: AbortSignal,
  previous?: FrameBundle | null,
  snapshotId?: string,
): Promise<FrameBundle> {
  const timedSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  const response = await api.getMarketPicture(
    server,
    snapshotId ? `snapshots/${snapshotId}` : "latest",
    {},
    timedSignal,
    snapshotId ? undefined : (previous?.etag ?? undefined),
  );
  const revalidated = response.status === 304 && previous;
  if (
    revalidated &&
    Object.keys(previous.faults).length === 0 &&
    previous.canonicalHistoryFault === null &&
    previous.canonicalHistory !== null &&
    canonicalHistoryFault(previous.canonicalHistory, previous.frame) === null
  ) return previous;
  const frame = revalidated
    ? previous.frame
    : projectFrame(await validateFrame(await boundedJson(response)));
  if (snapshotId && frame.snapshot_id !== snapshotId)
    throw new Error("Requested replay frame identity does not match.");
  const microstructureRef = frame.raw.microstructure_ref as { status?: string } | undefined;
  const queries = {
    history: {
      snapshot_id: frame.snapshot_id,
      window,
      limit: "1500",
      resolution: "1m",
    },
    correlations: { snapshot_id: frame.snapshot_id, benchmark, limit: "300" },
    events: { snapshot_id: frame.snapshot_id, limit: "50" },
    ...(microstructureRef?.status === "available"
      ? { microstructure: { snapshot_id: frame.snapshot_id } }
      : {}),
  };
  const projectors = {
    history: projectHistory,
    correlations: projectCorrelations,
    events: projectEvents,
    microstructure: projectMicrostructureResponse,
  };
  const sameFrame = previous?.frame.snapshot_id === frame.snapshot_id ? previous : null;
  const components: Record<string, unknown> = { ...(sameFrame?.components ?? {}) },
    faults: Record<string, string> = {};
  const projected = await Promise.allSettled(
    Object.entries(queries).map(async ([path, query]) => {
      const body = await boundedJson(
        await api.getMarketPicture(server, path, query, timedSignal),
      );
      pinned(body, frame);
      const values = await projectors[path as keyof typeof projectors](body, frame);
      components[path] = body;
      return values;
    }),
  );
  Object.keys(queries).forEach((key, i) => {
    const result = projected[i];
    if (result.status === "rejected")
      faults[key] =
        result.reason instanceof Error
          ? result.reason.message
          : "Stored component unavailable.";
  });
  const microstructureResult = projected[Object.keys(queries).indexOf("microstructure")];
  let canonicalHistory: HistoryPoint[] | null = null;
  let canonicalHistoryError: string | null = null;
  try {
    const body = await boundedJson(await api.getMarketPicture(
      server,
      "history",
      { snapshot_id: frame.snapshot_id, window: "6h", limit: "1500", resolution: "1m", projection: "canonical_state" },
      timedSignal,
    ));
    pinned(body, frame);
    canonicalEnvelope(body, frame);
    const values = canonicalHistoryRows(body, frame);
    components.canonical_history = body;
    canonicalHistoryError = canonicalHistoryFault(values, frame);
    if (canonicalHistoryError) throw new Error(canonicalHistoryError);
    canonicalHistory = values;
  } catch (error) {
    canonicalHistoryError = error instanceof Error ? error.message : "Canonical history unavailable.";
    faults.canonical_history = canonicalHistoryError;
  }
  return {
    frame: microstructureResult?.status === "fulfilled"
      ? { ...frame, ...(microstructureResult.value as Pick<DisplayFrame, "microstructure" | "sourceCapabilities" | "flow">) }
      : frame,
    history:
      projected[0].status === "fulfilled"
        ? (projected[0].value as HistoryPoint[])
        : (sameFrame?.history ?? []),
    canonicalHistory,
    canonicalHistoryFault: canonicalHistoryError,
    correlations:
      projected[1].status === "fulfilled"
        ? (projected[1].value as DisplayCorrelation[])
        : (sameFrame?.correlations ?? []),
    events:
      projected[2].status === "fulfilled"
        ? (projected[2].value as DisplayEvent[])
        : (sameFrame?.events ?? []),
    eventCursor:
      components.events &&
      typeof (components.events as Record<string, unknown>).next_cursor ===
        "string"
        ? ((components.events as Record<string, unknown>).next_cursor as string)
        : null,
    faults,
    components,
    etag: revalidated ? previous.etag : response.headers.get("ETag"),
  };
}
