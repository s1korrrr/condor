"""Read-only projection of the Helm paper runtime status for the V5 dashboard Helm page.

Helm writes its own runtime schema (``helm_v5_paper_runtime_v1`` with a ``helm`` block), so the V5 paper
validator does not apply. This module reads the file through the same pinned, size-bounded reader as the V5
paper status, checks identity and schema, and projects only the fields the page shows. Every field has a
converter by meaning (code, sentence, amount, epoch time, flag); a value that does not fit is dropped and counted
in ``withheld``, so nothing path-like, oversized or out of range reaches the browser and a dropped value is never
shown as absent. It never writes, never sends a control command and never fills a missing value.
"""

from __future__ import annotations

import math
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable

from .candles import MAX_TIMESTAMP
from .paper import FUTURE_SKEW_SECONDS, STATUS_NAME, PaperStatusError, _parse, _read_regular

HELM_RUNTIME_SCHEMA = "helm_v5_paper_runtime_v1"
HELM_BLOCK_SCHEMA = "rsibot.helm-v5-paper.status.helm.v2"
STALE_AFTER_SECONDS = 30

CODE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}")  # states, reason codes, ids, image tag
PLAIN = re.compile(r"[A-Za-z0-9 _.,:;()'%+=-]{1,256}")  # sentences: no / \ @ ~ $ or quotes
DECIMAL = re.compile(r"-?\d{1,18}(?:\.\d{1,18})?")
PAIR = re.compile(r"[A-Z0-9]{1,16}-[A-Z0-9]{1,16}")
MAX_SAFE = 2**53 - 1


def _code(value: Any) -> str | None:
    return value if isinstance(value, str) and CODE.fullmatch(value) else None


def _plain(value: Any) -> str | None:
    return value if isinstance(value, str) and PLAIN.fullmatch(value) else None


def _flag(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _amount(value: Any) -> int | float | str | None:
    """A finite JSON number within the safe integer range, or decimal text kept as text."""
    if type(value) is int and abs(value) <= MAX_SAFE:
        return value
    if type(value) is float and math.isfinite(value) and abs(value) <= MAX_SAFE:
        return value
    if isinstance(value, str) and DECIMAL.fullmatch(value):
        return value
    return None


def _epoch_ms(value: Any) -> int | None:
    return value if type(value) is int and 0 < value <= MAX_TIMESTAMP * 1000 else None


def _epoch_s(value: Any) -> int | float | None:
    if type(value) is int or (type(value) is float and math.isfinite(value)):
        return value if 0 < value <= MAX_TIMESTAMP else None
    return None


LONG_DECIMAL = re.compile(r"-?\d{1,18}(?:\.\d{1,30})?")


def _money(payload: dict) -> dict[str, str | None] | None:
    """Realized and unrealized P&L summed exactly over every controller; a partial set or any unreadable part is unknown."""
    reports = payload.get("native_reports")
    if not isinstance(reports, dict) or not reports or payload.get("unavailable_controller_ids") or len(reports) > 16:
        return None
    totals: dict[str, str | None] = {}
    for key, field in (("realized", "realized_pnl_quote"), ("unrealized", "unrealized_pnl_quote")):
        total = Decimal(0)
        for report in reports.values():
            performance = report.get("performance") if isinstance(report, dict) else None
            value = performance.get(field) if isinstance(performance, dict) and performance.get("pnl_available") is True else None
            if not isinstance(value, str) or not LONG_DECIMAL.fullmatch(value):
                total = None
                break
            try:
                total += Decimal(value)
            except InvalidOperation:
                total = None
                break
        totals[key] = None if total is None else format(total.quantize(Decimal("0.00000001")), "f")
    return totals


class _Projection:
    """Applies converters and counts published values that could not be shown."""

    def __init__(self) -> None:
        self.withheld = 0

    def one(self, value: Any, convert: Callable[[Any], Any]) -> Any:
        result = convert(value)
        if result is None and value is not None:
            self.withheld += 1
        return result

    def pick(self, source: Any, fields: dict[str, Callable[[Any], Any]]) -> dict[str, Any] | None:
        if not isinstance(source, dict):
            return None
        return {name: self.one(source.get(name), convert) for name, convert in fields.items()}


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
    generated = _epoch_s(payload.get("generated_at")) if isinstance(payload, dict) else None
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != 1
        or payload.get("paper_runtime_schema") != HELM_RUNTIME_SCHEMA
        or payload.get("bot_name") != bot
        or payload.get("execution_mode") != "paper"
        or not isinstance(helm, dict)
        or helm.get("schema") != HELM_BLOCK_SCHEMA
        or generated is None
    ):
        return {**base, "state": "UNAVAILABLE", "reason": "HELM_STATUS_SCHEMA"}
    if generated > now + FUTURE_SKEW_SECONDS:
        return {**base, "state": "UNAVAILABLE", "reason": "HELM_STATUS_CLOCK_SKEW"}
    shown = _Projection()
    symbols: list[dict[str, Any]] = []
    controllers = payload.get("controllers") if isinstance(payload.get("controllers"), list) else []
    for controller in controllers[:4]:
        info = controller.get("custom_info") if isinstance(controller, dict) else None
        if not isinstance(info, dict) or not isinstance(info.get("symbols"), dict):
            continue
        portfolio = info.get("portfolio") if isinstance(info.get("portfolio"), dict) else {}
        holds = portfolio.get("candidate_holds") if isinstance(portfolio.get("candidate_holds"), dict) else {}
        for pair, row in list(info["symbols"].items())[:16]:
            if not isinstance(pair, str) or not PAIR.fullmatch(pair) or not isinstance(row, dict):
                shown.withheld += 1
                continue
            symbols.append({
                "pair": pair,
                "status": shown.one(row.get("status"), _code),
                "candidate_hold": shown.one(holds.get(pair), _code),
                "bag": shown.pick(row.get("bag"), {"held_amount": _amount, "breakeven_price": _amount}),
                "last_decision": shown.pick(row.get("last_decision"), {"at": _epoch_s, "reason": _code}),
            })
    rejections = helm.get("control_rejections") if isinstance(helm.get("control_rejections"), dict) else None
    recent = rejections.get("recent") if rejections and isinstance(rejections.get("recent"), list) else []
    # Newest first by the runtime's own time, whatever order the file keeps.
    recent = sorted((row for row in recent if isinstance(row, dict)), key=lambda row: _epoch_ms(row.get("at_ms")) or 0, reverse=True)
    reasons = payload.get("reasons") if isinstance(payload.get("reasons"), list) else None
    image = helm.get("image") if isinstance(helm.get("image"), dict) else {}
    status = {
        "generated_at": generated,
        "age_s": max(0.0, now - generated),
        "ready": shown.one(payload.get("ready"), _flag),
        "failure": shown.one(payload.get("failure"), _plain),
        "failure_reported": payload.get("failure") is not None,
        "reasons": None if reasons is None else [value for value in (shown.one(reason, _code) for reason in reasons[:16]) if value is not None],
        "steps": shown.one(payload.get("steps"), _amount),
        "actions": shown.one(payload.get("actions"), _amount),
        "phase": shown.one(helm.get("phase"), _code),
        "profile_id": shown.one(helm.get("profile_id"), _code),
        "entries_held": shown.one(helm.get("entries_held"), _code),
        "operator_entry_paused": shown.one(helm.get("operator_entry_paused"), _flag),
        "kill_switch": shown.one(helm.get("kill_switch"), _flag),
        "adaptive_actions": shown.one(helm.get("adaptive_actions"), _code),
        "funding": shown.one(helm.get("funding"), _code),
        "image_tag": shown.one(image.get("tag"), _code),
        "shutdown": shown.pick(helm.get("shutdown"), {"checkpoint": _flag, "clean": _flag}),
        "mandate": shown.pick(helm.get("mandate"), {"mandate_id": _code, "state": _code, "valid_until_ms": _epoch_ms}),
        "risk": shown.pick(helm.get("native_risk"), {"reason": _code, "latched": _flag, "daily_loss_use": _amount, "risk_reference_quote": _amount, "unit": _code}),
        "control_rejections": None if rejections is None else {
            "count": shown.one(rejections.get("count"), _amount),
            "recent": [shown.pick(row, {"action": _code, "at_ms": _epoch_ms, "reason": _plain}) for row in recent[:5]],
        },
        "symbols": symbols,
        "money": _money(payload),
    }
    status["withheld"] = shown.withheld
    stale = now - generated > STALE_AFTER_SECONDS
    return {**base, "state": "STALE" if stale else "FRESH", "reason": "HELM_STATUS_STALE" if stale else "HELM_STATUS_FRESH", "status": status}
