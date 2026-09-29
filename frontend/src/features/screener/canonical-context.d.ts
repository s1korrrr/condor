export type CanonicalFeatureStatus =
  | "VALID"
  | "WARMUP_INCOMPLETE"
  | "INPUT_MISSING"
  | "INPUT_STALE"
  | "MODEL_UNAVAILABLE"
  | "INVALID";

export interface CanonicalNamedFeature {
  name: string;
  value: number | null;
  unit: string;
  horizon_minutes: number;
  status: CanonicalFeatureStatus;
  reasons: string[];
  valid_count: number;
  expected_count: number;
  valid_weight_fraction: number | null;
  model_id: string | null;
  input_available_at_ms: number | null;
}

export interface CanonicalContextAsset {
  asset_id: string;
  instrument_id: string;
  reasons: string[];
  features: CanonicalNamedFeature[];
  fits: CanonicalFitRecord[];
}

export interface CanonicalFitRecord {
  horizon_minutes: number;
  status: CanonicalFeatureStatus;
  reasons: string[];
  training_samples: number;
  history_cutoff_ms: number | null;
  factor_id: string | null;
}

export interface CanonicalContextSnapshot {
  schema_version: string;
  snapshot_id: string;
  stream_id: string;
  epoch: string;
  sequence: number;
  source_kind: "observed" | "modeled_availability" | "synthetic";
  venue: string;
  numeraire: string;
  cutoff_ms: number;
  available_at_ms: number;
  expires_at_ms: number;
  supersedes: string | null;
  max_input_available_at_ms: number | null;
  status: "READY" | "DEGRADED" | "WARMING" | "INVALID";
  reasons: string[];
  provenance: Record<string, unknown>;
  coverage: {
    expected_count: number;
    valid_count: number;
    valid_weight_fraction: number;
    missing: Array<{ asset_id: string; reasons: string[] }>;
  };
  market: CanonicalNamedFeature[];
  assets: CanonicalContextAsset[];
}

export type CanonicalContextResponse =
  | { availability: "available"; payload: CanonicalContextSnapshot }
  | {
      availability: "unavailable";
      reason: string;
      sourceStatus: number | null;
    };

export function parseCanonicalContext(value: unknown): CanonicalContextResponse;
export function canonicalContextExpiry(
  snapshot: CanonicalContextSnapshot | null | undefined,
  now: number,
): "current" | "future" | "expired" | "unknown";
export function mergeCanonicalContext(
  currentSnapshot: CanonicalContextSnapshot | null,
  incoming: CanonicalContextResponse,
): {
  response: CanonicalContextResponse;
  snapshot: CanonicalContextSnapshot | null;
};
