export type RecordData = Record<string, unknown>;
export interface ResearchEnvelope {
  data: RecordData;
  source: {
    owner: "research_os";
    server: string;
    fetched_at: string;
    read_only: true;
  };
}
export function object(value: unknown): RecordData {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordData)
    : {};
}
export function text(value: unknown, fallback = "Not recorded"): string {
  return typeof value === "string" && value ? value : fallback;
}
export function records(value: unknown): RecordData[] {
  return Array.isArray(value)
    ? (value.filter(
        (v) => v && typeof v === "object" && !Array.isArray(v),
      ) as RecordData[])
    : [];
}
export function researchPath(
  endpoint: string,
  server: string,
  params: Record<string, string> = {},
): string {
  if (
    !["overview", "nodes", "node", "graph", "comparisons", "clusters"].includes(
      endpoint,
    ) ||
    !server
  )
    throw new Error("Invalid research request");
  const query = new URLSearchParams({ server });
  for (const [key, value] of Object.entries(params))
    if (key !== "server") query.set(key, value);
  return `/api/v1/research/${endpoint}?${query.toString()}`;
}
export function parseResearchEnvelope(
  value: unknown,
  server: string,
): ResearchEnvelope {
  const v = object(value),
    s = object(v.source);
  if (
    !v.data ||
    typeof v.data !== "object" ||
    Array.isArray(v.data) ||
    s.owner !== "research_os" ||
    s.server !== server ||
    s.read_only !== true ||
    typeof s.fetched_at !== "string" ||
    !Number.isFinite(Date.parse(s.fetched_at))
  )
    throw new Error("Research source identity or response is invalid");
  return v as unknown as ResearchEnvelope;
}
export function catalogCount(counts: RecordData, key: string): number | null {
  const v = counts[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}
export function researchReadState(
  envelope: ResearchEnvelope | undefined,
  now: number,
  failed: boolean,
  receivedAt: number,
) {
  if (failed) return "error";
  if (!envelope) return "loading";
  // Both values use the client clock; the owner timestamp is provenance only.
  const age = now - receivedAt;
  return receivedAt > 0 && Number.isFinite(age) && age >= -5000 && age <= 60000
    ? "available"
    : "stale";
}
