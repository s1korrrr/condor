export type AgentStatus = "ready" | "blocked";

export interface V5Skill {
  id: string;
  name: string;
  content?: string;
}

export interface V5Loop {
  id: string | null;
  name: string;
  frequency_sec: number;
  max_ticks: number;
}

export interface V5Agent {
  id: string;
  name: string;
  description: string;
  task_id: string | null;
  mode: string;
  model: string | null;
  status: AgentStatus;
  blockers: string[];
  tools: string[];
  loops: V5Loop[];
  skills: Pick<V5Skill, "id" | "name">[];
}

export interface V5Session {
  id: string;
  agent_id: string | null;
  loop_id: string | null;
  status: string;
  started_at_ms: number;
  finished_at_ms: number | null;
  summary: string;
  effect: "NONE" | string;
  ticks?: V5Tick[];
  journal?: string;
}

export interface V5Tick {
  id: string;
  status: string;
  at_ms: number;
  summary: string;
  evidence_refs: string[];
  report: string | Record<string, unknown> | null;
  error: string | null;
}

export interface MarketEvidence {
  schema_version?: string;
  snapshot_id?: string | null;
  source_snapshot_ids?: string[];
  available_at_ms?: number | null;
  cutoff_ms?: number | null;
  baseline_binding_hash?: string | null;
  strategy_assessment_eligible?: boolean;
  features?: Record<string, { value: number | string | null; unit: string; status: string }>;
  quality?: Record<string, unknown>;
  lineage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AdvisorTaskProfile {
  task_id: string | null;
  model: string | null;
  enabled: boolean;
  reason: string;
}

export interface V5Workspace {
  schema_version: "v5-workspace.v1";
  identity: {
    name: string;
    host: string;
    mode: string;
    execution_enabled: boolean;
    baseline_binding: string | null;
    upstream_revision?: string | null;
  };
  context: MarketEvidence | null;
  advisor: {
    enabled: boolean;
    model: string | null;
    calls_today: number | null;
    spent_usd: number | string | null;
    reserved_usd: number | string | null;
    task_profiles: AdvisorTaskProfile[];
  };
  agents: V5Agent[];
  sessions: V5Session[];
  source_error: string | null;
}

export interface V5AgentDetail extends V5Agent {
  playbook: string;
  skills: V5Skill[];
  notes: string;
  policy: {
    allowed_tools: string[];
    execution_enabled: boolean;
    tool_policy_mode: string;
    empty_allowlist_means: "deny_all" | "allow_all" | "unknown";
  };
}

export interface V5Settings {
  identity: V5Workspace["identity"];
  budget: V5Workspace["advisor"];
  task_profiles?: AdvisorTaskProfile[];
  tool_readiness?: Record<string, unknown>;
  source_readiness?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface V5SessionDetail extends V5Session {
  ticks: V5Tick[];
  journal: string;
}
