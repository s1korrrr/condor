export type V5AdvisoryHistoryItem = {
  assessment: string;
  availableAtMs: number | null;
};

export type V5AdvisoryView = {
  freshness: string;
  mode: string;
  enabled: boolean | null;
  model: string | null;
  nativeV5Parity: string;
  journalStatus: string;
  assessment: string | null;
  summary: string | null;
  availableAtMs: number | null;
  expiresAtMs: number | null;
  features: Array<{ id: string; value: number | string | null; unit: string; status: string }>;
  quality: Array<{ id: string; value: string | null }>;
  reasons: string[];
  spentUsd: number | null;
  reservedUsd: number | null;
  callsToday: number | null;
  history: V5AdvisoryHistoryItem[];
};

export function projectV5Advisory(payload: unknown, nowMs?: number): V5AdvisoryView;
