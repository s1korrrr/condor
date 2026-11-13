"""Read-only projection of the Helm paper runtime status for the V5 dashboard Helm page.

Helm writes its own runtime schema (``helm_v5_paper_runtime_v1`` with a ``helm`` block), so the V5 paper
validator does not apply. This module reads the file through the same pinned, size-bounded reader as the V5
paper status, checks the identity and schema fields it shows, and returns only those fields. It never writes,
never sends a control command and never fills a missing value: a field the runtime did not publish stays null.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .paper import FUTURE_SKEW_SECONDS, STATUS_NAME, PaperStatusError, _parse, _read_regular

HELM_RUNTIME_SCHEMA = "helm_v5_paper_runtime_v1"
HELM_BLOCK_SCHEMA = "rsibot.helm-v5-paper.status.helm.v2"
STALE_AFTER_SECONDS = 30
TEXT_LIMIT = 256


def _text(value: Any) -> str | None:
    return value[:TEXT_LIMIT] if isinstance(value, str) else None


def _number(value: Any) -> int | float | str | None:
    """Numbers pass as JSON numbers; decimal strings stay strings (no float conversion)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str) and len(value) <= 64:
        try:
            float(value)
        except ValueError:
            return None
        return value
    return None


def _flag(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _label(value: Any) -> str | None:
    """Short identifier-like text (reasons, states); anything else is not shown."""
    return value if isinstance(value, str) and 0 < len(value) <= 128 else None


def _pick(source: Any, fields: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(source, dict):
        return None
    return {name: convert(source.get(name)) for name, convert in fields.items()}


# Only the per-coin fields the Helm page shows, each with its own type; unknown keys are never projected.
BAG_FIELDS = {"held_amount": _number, "breakeven_price": _number, "trail_armed": _flag, "trail_peak": _number, "reason": _label}
DECISION_FIELDS = {"at": _number, "candle": _number, "reason": _label}


def read_helm_status(path: Path, *, now: float) -> dict[str, Any]:
    """Return ``{"state", "reason", "bot", "observed_at", "status"}``; ``status`` is None unless readable."""
    match = STATUS_NAME.fullmatch(path.name)
    bot = match.group(1) if match else None
    base = {"bot": bot, "observed_at": now, "status": None}
    try:
        if bot is None or not path.is_absolute():
            raise PaperStatusError("HELM_STATUS_PATH")
        payload = _parse(_read_regular(path))
    except PaperStatusError as exc:
        return {**base, "state": "UNAVAILABLE", "reason": exc.code.replace("PAPER_", "HELM_")}
    helm = payload.get("helm") if isinstance(payload, dict) else None
    generated = payload.get("generated_at") if isinstance(payload, dict) else None
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != 1
        or payload.get("paper_runtime_schema") != HELM_RUNTIME_SCHEMA
        or payload.get("bot_name") != bot
        or payload.get("execution_mode") != "paper"
        or not isinstance(helm, dict)
        or helm.get("schema") != HELM_BLOCK_SCHEMA
        or isinstance(generated, bool)
        or not isinstance(generated, (int, float))
    ):
        return {**base, "state": "UNAVAILABLE", "reason": "HELM_STATUS_SCHEMA"}
    if generated > now + FUTURE_SKEW_SECONDS:
        return {**base, "state": "UNAVAILABLE", "reason": "HELM_STATUS_CLOCK_SKEW"}
    controllers = payload.get("controllers") if isinstance(payload.get("controllers"), list) else []
    symbols: list[dict[str, Any]] = []
    for controller in controllers[:4]:
        info = controller.get("custom_info") if isinstance(controller, dict) else None
        portfolio = info.get("portfolio") if isinstance(info, dict) else None
        holds = portfolio.get("candidate_holds") if isinstance(portfolio, dict) else None
        for pair, row in list((info.get("symbols") or {}).items())[:16] if isinstance(info, dict) and isinstance(info.get("symbols"), dict) else []:
            if not isinstance(pair, str) or len(pair) > 32 or not isinstance(row, dict):
                continue
            bag = row.get("bag") if isinstance(row.get("bag"), dict) else {}
            decision = row.get("last_decision") if isinstance(row.get("last_decision"), dict) else {}
            symbols.append({
                "pair": pair,
                "status": _label(row.get("status")),
                "candidate_hold": _label(holds.get(pair)) if isinstance(holds, dict) else None,
                "bag": _pick(bag, BAG_FIELDS),
                "last_decision": _pick(decision, DECISION_FIELDS),
            })
    rejections = helm.get("control_rejections") if isinstance(helm.get("control_rejections"), dict) else {}
    status = {
        "generated_at": generated,
        "age_s": max(0.0, now - generated),
        "ready": _flag(payload.get("ready")),
        "failure": _text(payload.get("failure")),
        "reasons": [_text(reason) for reason in payload.get("reasons", [])[:16] if isinstance(reason, str)] if isinstance(payload.get("reasons"), list) else [],
        "controller_kind": _text(payload.get("controller_kind")),
        "steps": _number(payload.get("steps")),
        "actions": _number(payload.get("actions")),
        "phase": _text(helm.get("phase")),
        "profile_id": _text(helm.get("profile_id")),
        "entries_held": _text(helm.get("entries_held")),
        "operator_entry_paused": _flag(helm.get("operator_entry_paused")),
        "kill_switch": _flag(helm.get("kill_switch")),
        "adaptive_actions": _text(helm.get("adaptive_actions")),
        "funding": _text(helm.get("funding")),
        "image_tag": _text((helm.get("image") or {}).get("tag")) if isinstance(helm.get("image"), dict) else None,
        "shutdown": _pick(helm.get("shutdown"), {"checkpoint": _flag, "clean": _flag, "closed": _flag}),
        "mandate": _pick(helm.get("mandate"), {"mandate_id": _text, "state": _text, "reason": _text, "valid_from_ms": _number, "valid_until_ms": _number, "days_to_expiry": _number, "observed_at_ms": _number}),
        "risk": _pick(helm.get("native_risk"), {"reason": _text, "latched": _flag, "complete": _flag, "daily_loss_use": _number, "drawdown_use": _number, "native_marked_pnl": _number, "peak_pnl": _number, "risk_reference_quote": _number, "unit": _text, "protected_exits": _text, "scope_of_latch": _text, "observed_at_ms": _number}),
        "control_rejections": {
            "published": isinstance(helm.get("control_rejections"), dict),
            "count": _number(rejections.get("count")),
            "recent": [_pick(row, {"action": _text, "at_ms": _number, "reason": _text}) for row in rejections.get("recent", [])[:5]] if isinstance(rejections.get("recent"), list) else [],
        },
        "symbols": symbols,
    }
    stale = now - generated > STALE_AFTER_SECONDS
    return {**base, "state": "STALE" if stale else "FRESH", "reason": "HELM_STATUS_STALE" if stale else "HELM_STATUS_FRESH", "status": status}
