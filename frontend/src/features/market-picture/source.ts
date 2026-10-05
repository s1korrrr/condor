import { api } from "@/lib/api";
import { projectFrame, validateFrame } from "./contract.mjs";
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
  correlations: DisplayCorrelation[];
  events: DisplayEvent[];
  eventCursor: string | null;
  faults: Record<string, string>;
  components: Record<string, unknown>;
  etag: string | null;
}
const LIMIT = 2 * 1024 * 1024;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid stored observation response.");
  return value as Record<string, unknown>;
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
    const reason = Array.isArray(reasons)
      ? reasons
          .filter((r) => typeof r === "string" && /^[A-Z_]+$/.test(r))
          .join(", ")
      : "";
    throw Object.assign(
      new Error(
        reason || `Observation source unavailable (${response.status}).`,
      ),
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
  if (revalidated && Object.keys(previous.faults).length === 0) return previous;
  const frame = revalidated
    ? previous.frame
    : projectFrame(await validateFrame(await boundedJson(response)));
  if (snapshotId && frame.snapshot_id !== snapshotId)
    throw new Error("Requested replay frame identity does not match.");
  const queries = {
    history: {
      snapshot_id: frame.snapshot_id,
      window,
      limit: "1500",
      resolution: "1m",
    },
    correlations: { snapshot_id: frame.snapshot_id, benchmark, limit: "300" },
    events: { snapshot_id: frame.snapshot_id, limit: "50" },
  };
  const projectors = {
    history: projectHistory,
    correlations: projectCorrelations,
    events: projectEvents,
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
      const values = projectors[path as keyof typeof projectors](body, frame);
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
  return {
    frame,
    history:
      projected[0].status === "fulfilled"
        ? (projected[0].value as HistoryPoint[])
        : (sameFrame?.history ?? []),
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
