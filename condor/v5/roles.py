"""Code-owned, disabled Stage 1 role bindings. Prose is never executable policy."""

from types import MappingProxyType

ROLE_SPECS = MappingProxyType(
    {
        "market_analyst": ("Market Regime Analyst", "market_context", "agent_message"),
        "source_auditor": ("Event Analyst", "source_quality", "agent_message"),
        "decision_reviewer": ("Decision Critic", None, "agent_message"),
        "forecast_analyst": ("Forecast Analyst", None, "agent_message"),
        "strategy_analyst": ("Strategy Analyst", None, "agent_message"),
        "portfolio_manager": ("Portfolio Manager", None, "agent_message"),
        "research_scout": ("Research Scout", None, "agent_message"),
        "hypothesis_designer": ("Hypothesis Designer", None, "agent_message"),
        "strategy_engineer": ("Strategy Engineer", None, "candidate_revision"),
        "experiment_critic": ("Experiment Critic", None, "agent_message"),
        "experience_analyst": ("Experience Analyst", None, "lesson_revision"),
        "knowledge_curator": ("Knowledge Curator", None, "knowledge_release"),
    }
)


def resolve_role(role_id, capability_manifest):
    if role_id not in ROLE_SPECS:
        raise ValueError("unknown fixed role")
    name, task_id, schema = ROLE_SPECS[role_id]
    return {
        "role_id": role_id,
        "name": name,
        "revision": "stage1-20261029",
        "task_id": task_id,
        "output_schema": schema,
        "schema_version": "2" if schema == "lesson_revision" else "1",
        "model": "FIXTURE_ONLY",
        "provider": "NONE",
        "status": "BLOCKED",
        "blockers": ["Stage 1 dispatch disabled"]
        + ([] if task_id else ["Owner task binding missing"]),
        "tools": [],
        "read_capability": "fixture_projection",
        "request_capability": None,
        "empty_allowlist_means": "deny_all",
        "usage": "NOT_DISPATCHED",
        "provider_metered_usage": None,
        "effect": "NONE",
    }
