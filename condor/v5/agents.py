"""Filesystem-backed V5 agent catalog with local-over-stock reads.

The format follows Condor's AGENT.md / loops / skills convention. The catalog is
kept independent from AgentStore, whose empty tool allowlist is unrestricted.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .config import Settings

SLUG_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
ALLOWED_TOOLS = frozenset(
    {
        "get_market_context",
        "get_advice_history",
        "request_market_report",
        "get_paper_status",
    }
)
REPORT_ROLES = frozenset({"market_analyst", "source_auditor", "decision_reviewer"})
# Roles that also need a fresh read-only native paper owner before they may run.
PAPER_ROLES = frozenset({"decision_reviewer"})
AGENT_SPECS: dict[str, dict[str, Any]] = {
    "market_analyst": {
        "task_id": "market_context",
        "allowed_tools": (
            "get_market_context",
            "get_advice_history",
            "request_market_report",
        ),
    },
    "source_auditor": {
        "task_id": "source_quality",
        "allowed_tools": (
            "get_market_context",
            "get_advice_history",
            "request_market_report",
        ),
    },
    "decision_reviewer": {
        "task_id": "decision_review",
        "allowed_tools": (
            "get_market_context",
            "get_paper_status",
            "get_advice_history",
            "request_market_report",
        ),
    },
}


@dataclass(frozen=True)
class AgentDefinition:
    id: str
    name: str
    description: str
    task_id: str | None
    mode: str
    model: str | None
    status: str
    blockers: tuple[str, ...]
    tools: tuple[str, ...]
    loops: tuple[dict[str, Any], ...]
    skills: tuple[dict[str, str], ...]
    playbook: str
    notes: str
    source: str

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "task_id": self.task_id,
            "mode": self.mode,
            "model": self.model,
            "status": self.status,
            "blockers": list(self.blockers),
            "tools": list(self.tools),
            "tool_policy_mode": "explicit_v5_allowlist",
            "empty_allowlist_means": "deny_all",
            "loops": [dict(loop) for loop in self.loops],
            "skills": [dict(skill) for skill in self.skills],
            "source": self.source,
        }


def _parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    text = content[:200_000]
    if not text.startswith("---\n"):
        return {}, text.strip()
    stop = text.find("\n---", 4)
    if stop < 0:
        return {}, text.strip()
    try:
        frontmatter = yaml.safe_load(text[4:stop]) or {}
    except yaml.YAMLError:
        return {}, text.strip()
    if not isinstance(frontmatter, dict):
        return {}, text.strip()
    return frontmatter, text[stop + 4 :].strip()


def _read_scoped(root: Path, relative: Path) -> str | None:
    """Read a regular file confined to root; reject symlinks and escapes."""
    try:
        root_resolved = root.resolve(strict=True)
        path = root / relative
        if not path.is_file():
            return None
        cursor = path
        while cursor != root:
            if cursor.is_symlink():
                return None
            cursor = cursor.parent
        resolved = path.resolve(strict=True)
        if root_resolved not in resolved.parents or resolved.stat().st_size > 200_000:
            return None
        return resolved.read_text(encoding="utf-8")
    except (OSError, RuntimeError):
        return None


class AgentCatalog:
    """Read only stock definitions and V5-owned local state overlays."""

    def __init__(self, settings: Settings, *, stock_root: Path | None = None):
        self.settings = settings
        self.stock_root = (
            stock_root
            or settings.stock_agents_root
            or Path(__file__).resolve().parents[2] / "agents_v5"
        ).resolve()
        self.local_root = (settings.runtime_root / "agents").resolve()

    def ids(self) -> list[str]:
        return list(AGENT_SPECS)

    def get(self, agent_id: str) -> AgentDefinition | None:
        if not SLUG_RE.fullmatch(agent_id) or agent_id not in AGENT_SPECS:
            return None
        stock_text = _read_scoped(self.stock_root, Path(agent_id) / "AGENT.md")
        local_text = _read_scoped(self.local_root, Path(agent_id) / "AGENT.md")
        # Local AGENT.md may customize prose, but hard-coded V5 policy owns tools,
        # task identity, mode and model. Invalid/missing stock fails closed.
        raw = local_text if local_text is not None else stock_text
        if raw is None:
            return None
        metadata, instructions = _parse_frontmatter(raw)
        spec = AGENT_SPECS[agent_id]
        task_id = spec["task_id"]
        role_tools = tuple(
            tool for tool in spec["allowed_tools"] if tool in ALLOWED_TOOLS
        )
        blockers: list[str] = []
        status = "ready"
        if task_id is None:
            status = "blocked"
            blockers.append("Native baseline identity and decision trace are not bound")
        # Until task profiles are reported enabled by the bounded API, the agent
        # remains visible but report calls are disabled at request time.
        loops = self._loops(agent_id)
        skills = self._skills(agent_id, metadata)
        return AgentDefinition(
            id=agent_id,
            name=str(metadata.get("name", agent_id.replace("_", " ").title()))[:100],
            description=str(
                metadata.get(
                    "description", instructions.splitlines()[0] if instructions else ""
                )
            )[:500],
            task_id=task_id,
            mode="reports-only",
            model=None,
            status=status,
            blockers=tuple(blockers),
            tools=role_tools,
            loops=loops,
            skills=skills,
            playbook=self._playbook(agent_id, metadata),
            notes=self._notes(agent_id),
            source="local" if local_text is not None else "stock",
        )

    def _playbook(self, agent_id: str, metadata: dict[str, Any]) -> str:
        loop_id = metadata.get("default_loop", agent_id)
        if not isinstance(loop_id, str) or not SLUG_RE.fullmatch(loop_id):
            loop_id = agent_id
        relative = Path(agent_id) / "loops" / loop_id / "loop.md"
        local = _read_scoped(self.local_root, relative)
        stock = _read_scoped(self.stock_root, relative)
        return (local or stock or "").strip()[:40_000]

    def _loops(self, agent_id: str) -> tuple[dict[str, Any], ...]:
        # Loop parameters are fixed by code and cannot be loosened by markdown.
        return (
            {
                "id": f"{agent_id}_monitor",
                "name": "Bounded report monitor",
                "frequency_sec": 1800,
                "max_ticks": 48,
            },
        )

    def _skills(
        self, agent_id: str, metadata: dict[str, Any]
    ) -> tuple[dict[str, str], ...]:
        values = metadata.get("skills", ["market_context"])
        if not isinstance(values, list):
            values = ["market_context"]
        result = []
        for skill_id in values[:12]:
            if not isinstance(skill_id, str) or not SLUG_RE.fullmatch(skill_id):
                continue
            relative = Path(agent_id) / "skills" / skill_id / "SKILL.md"
            content = _read_scoped(self.local_root, relative) or _read_scoped(
                self.stock_root, relative
            )
            if content is not None:
                frontmatter, body = _parse_frontmatter(content)
                result.append(
                    {
                        "id": skill_id,
                        "name": str(
                            frontmatter.get("name", skill_id.replace("_", " ").title())
                        )[:100],
                        "content": body[:40_000],
                    }
                )
        return tuple(result)

    def _notes(self, agent_id: str) -> str:
        if agent_id not in REPORT_ROLES:
            return ""
        relative = Path(agent_id) / "notes.md"
        return (_read_scoped(self.local_root, relative) or "")[:8_000]

    def save_notes(self, agent_id: str, text: str) -> str:
        if agent_id not in REPORT_ROLES or not SLUG_RE.fullmatch(agent_id):
            raise ValueError("notes are available only for report agents")
        if len(text) > 8_000:
            raise ValueError("notes exceed the 8000 character limit")
        root = self.local_root.resolve()
        root.mkdir(parents=True, exist_ok=True)
        agent_dir = root / agent_id
        if agent_dir.is_symlink():
            raise ValueError("agent state path may not be a symlink")
        agent_dir.mkdir(parents=True, exist_ok=True)
        target = agent_dir / "notes.md"
        if target.is_symlink():
            raise ValueError("notes path may not be a symlink")
        temporary = target.with_suffix(".md.tmp")
        temporary.write_text(text, encoding="utf-8")
        temporary.replace(target)
        return text
