import { describePanelState, type PanelStateKind } from "@/features/quant-ops/panel-state";

// Owner and gateway reason codes in operator wording; the code stays visible for diagnosis.
const REASON_TEXT: Record<string, string> = {
  SOURCE_UNAVAILABLE: "Market Picture source unavailable",
  SOURCE_DISABLED: "Market Picture source disabled on this server",
  STORE_UNAVAILABLE: "Market Picture store unavailable",
  CONTEXT_UNAVAILABLE: "Market context unavailable",
  RETENTION_EXPIRED: "Requested observation is past retention",
  CAPACITY_EXCEEDED: "Market Picture source at capacity; retry shortly",
  EXPIRED_SNAPSHOT: "Snapshot expired",
  HASH_MISMATCH: "Stored snapshot failed its integrity check",
  SOURCE_IDENTITY_MISMATCH: "Source identity changed",
  INVALID_QUERY: "Request rejected as invalid",
  RESPONSE_CONTRACT_VIOLATION: "Market Picture response failed validation",
};
const NO_DATA = new Set(["SOURCE_DISABLED", "STORE_UNAVAILABLE", "CONTEXT_UNAVAILABLE", "RETENTION_EXPIRED", "EXPIRED_SNAPSHOT"]);

/** The same "<state> · <reason>" wording as the other dashboard panels, from an HTTP status and owner codes. */
export function observationErrorMessage(status: number, reasons: unknown[] = []): string {
  const codes = reasons.filter((code): code is string => typeof code === "string" && /^[A-Z_]+$/.test(code));
  const kind: PanelStateKind = status === 401 || status === 403 ? "unauthorized"
    : codes.length && codes.every(code => NO_DATA.has(code)) ? "unavailable" : "error";
  const text = codes.length
    ? `${codes.map(code => REASON_TEXT[code] ?? code).join("; ")} (${codes.join(", ")})`
    : `Market Picture source unavailable (HTTP ${status})`;
  return describePanelState({ kind, reason: text });
}
