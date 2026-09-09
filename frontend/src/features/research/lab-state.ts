import { object, text } from "./model.ts";
export const LAB_VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "ideas", label: "Ideas" },
  { id: "graph", label: "Graph" },
  { id: "papers", label: "Papers" },
  { id: "experiments", label: "Experiments" },
  { id: "queue", label: "Queue" },
  { id: "learning", label: "Research loop" },
  { id: "gaps", label: "Evidence gaps" },
  { id: "archive", label: "Archive" },
] as const;
export type LabView = (typeof LAB_VIEWS)[number]["id"];
export function readLabState(params: URLSearchParams) {
  const rawOffset = Number(params.get("offset") ?? 0);
  return {
    view: (LAB_VIEWS.find((v) => v.id === params.get("view"))?.id ??
      "overview") as LabView,
    q: params.get("q") ?? "",
    lane: params.get("lane") ?? "",
    family: params.get("family") ?? "",
    kind: params.get("kind") ?? "",
    gap_kind: params.get("gap_kind") ?? "",
    selected: params.get("id") ?? "",
    offset: Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
    network_q: params.get("network_q") ?? "",
    network_kind: params.get("network_kind") ?? "",
    network_focus: params.get("network_focus") ?? "",
  };
}
export type LabState = ReturnType<typeof readLabState>;
export function updateLabParams(
  params: URLSearchParams,
  changes: Record<string, string>,
  options: { resetPage?: boolean; clearSelection?: boolean } = {},
) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  if (options.resetPage) next.delete("offset");
  if (options.clearSelection) {
    next.delete("id");
    next.delete("network_focus");
  }
  return next;
}
export function clearLabServerSelection(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  for (const key of [...next.keys()])
    if (
      key === "id" ||
      key === "offset" ||
      key === "network_focus" ||
      key.startsWith("archive_")
    )
      next.delete(key);
  return next;
}
export function labContext(node: unknown): string {
  const data = object(object(node).data);
  return text(
    data.statement,
    text(
      object(data.mandate).objective,
      text(data.rationale, text(data.hypothesis, text(data.summary, ""))),
    ),
  );
}

export function labTimestamp(value: unknown) {
  const stamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(stamp)
    ? new Date(stamp).toLocaleString()
    : "Not recorded";
}
