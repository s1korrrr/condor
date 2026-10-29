"""Fixed local compatibility projections for the isolated V5 dashboard.

This module deliberately has no client, filesystem, or Condor-owner imports. It
does not proxy the ordinary dashboard API. Only the exact reads below are
projected; owner-backed categories fail visibly until a native V5 owner binds.
The caller may pass one already-read paper observation (``condor.v5.paper``);
without it every projection is the unbound release, unchanged.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.parse import parse_qsl, unquote, urlsplit

from fastapi import HTTPException

from .paper import STALE_AFTER_SECONDS, PaperObservation, validate_paper_read

V5_SERVER_ID = "rsibot-v5"
V5_HOST = "razer"
V5_PORT = 8088
CONDOR_BASE_REVISION = "ff8858df765cffe4d325fde384f7a2eecdf51641"
MAX_READ_PATH_LENGTH = 2048


def dashboard_profile(paper: PaperObservation | None = None) -> dict:
    """Return V5 identity and explicit owner readiness."""
    profile = {
        "schema_version": "v5-dashboard-profile.v1",
        "server": {
            "server_id": V5_SERVER_ID,
            "host": V5_HOST,
            "port": V5_PORT,
            "mode": "reports-only",
            "execution_enabled": False,
        },
        "condor": {"base_revision": CONDOR_BASE_REVISION},
        "readiness": {
            "native_owner": "UNBOUND",
            "native_owner_reason": "The exact V5 controller baseline and native decision trace are not bound.",
            "account_owner": "UNBOUND",
            "account_owner_reason": "No V5 account and position owner is bound.",
            "research_owner": "UNBOUND",
            "research_owner_reason": "No V5 Research OS source is bound.",
            "tradepad_owner": "UNBOUND",
            "tradepad_owner_reason": "No V5 Tradepad session or publication is bound.",
            "market_picture_owner": "UNBOUND",
            "market_picture_owner_reason": "The V5 context is not an ordinary Condor Market Picture frame.",
        },
    }
    if paper is not None:
        owner, reason = _paper_owner_state(paper)
        profile["readiness"].update(
            native_owner=owner,
            native_owner_reason=reason,
            paper_owner=_paper_owner(paper),
        )
        profile["capabilities"] = {
            "paper_owner": owner,
            "account": "SIMULATED_WALLET_ONLY",
            "advisor": "REPORTS_ONLY",
            "live_execution": "DISABLED",
            "paper_control": "NOT_ENABLED",
            "read_schema": "rsibot.v5-paper.read.v1",
        }
    return profile


def read_compatibility_path(
    raw_path: str, paper: PaperObservation | None = None, *, paper_read: dict | None = None
) -> object:
    """Project one exact, safe legacy GET path into fixed V5-owned data.

    The caller must enforce V5 dashboard authentication. This function only
    handles a local path string and never performs I/O.
    """
    if (
        not isinstance(raw_path, str)
        or not raw_path
        or len(raw_path) > MAX_READ_PATH_LENGTH
    ):
        raise HTTPException(400, detail="invalid compatibility read path")
    if "\\" in raw_path or "#" in raw_path:
        raise HTTPException(400, detail="invalid compatibility read path")

    parts = urlsplit(raw_path)
    if (
        parts.scheme
        or parts.netloc
        or parts.fragment
        or not parts.path.startswith("/api/v1/")
    ):
        raise HTTPException(
            400, detail="compatibility path must be a relative /api/v1 path"
        )
    # Encoded separators and dot segments are ambiguous across URL decoders.
    decoded_path = unquote(parts.path)
    if "%" in parts.path or decoded_path != parts.path:
        raise HTTPException(400, detail="encoded compatibility paths are not allowed")
    segments = parts.path.split("/")
    if any(segment in {".", ".."} for segment in segments):
        raise HTTPException(400, detail="dot segments are not allowed")

    path = parts.path
    if paper is not None:
        route = paper_read_route(path, parts.query, paper.bot_name)
        if route is not None:
            section, query = route
            if paper_read is not None:
                return validate_paper_read(paper_read, section=section, bot=paper.bot_name, now_ms=int(paper.observed_at * 1000))
            return {
                "schema": "rsibot.v5-paper.read.v1", "section": section,
                "state": "degraded", "reason": "Paper observation read is not connected.",
                "bot_id": paper.bot_name, "execution_mode": "paper", "simulated": True,
                "snapshot_id": None, "generated_at_ms": None, "data": None,
                "source_route": f"/v1/paper/{section}" + (f"?{query}" if query else ""),
            }
    if path == "/api/v1/servers":
        _require_no_query(parts.query)
        return [
            {
                "name": V5_SERVER_ID,
                "host": V5_HOST,
                "port": V5_PORT,
                "online": True,
                "permission": "observer",
            }
        ]

    if path.startswith("/api/v1/servers/"):
        remainder = path.removeprefix("/api/v1/servers/")
        server_id, _, suffix = remainder.partition("/")
        if server_id != V5_SERVER_ID:
            raise HTTPException(403, detail="server identity is outside V5 scope")
        if suffix == "status":
            _require_no_query(parts.query)
            # This is the exact V5 unbound-status projection; it reports process
            # health separately from native owner readiness.
            return _server_status(paper)
        if suffix == "bots":
            _require_no_query(parts.query)
            return _bots_unbound() if paper is None else _paper_bots(paper)
        if suffix.startswith(
            ("portfolio", "account-balances", "fleet", "executors", "positions")
        ):
            raise _unbound("account and execution")
        if suffix.startswith(("market-picture", "screener", "market")):
            raise _unbound("native market-picture frame")
        raise HTTPException(404, detail="V5 compatibility read is not registered")

    if path == "/api/v1/trading-visuals/sources":
        _require_no_query(parts.query)
        # The parser expects a `sources` array. Only a read paper bot is listed.
        if paper is None or paper.status is None:
            return {"sources": []}
        return {"sources": [{"bot": paper.bot_name, "server": V5_SERVER_ID}]}
    if path == "/api/v1/trading-visuals/bootstrap" and paper is not None:
        query = parse_qsl(parts.query, keep_blank_values=True)
        if len(query) != 1 or query[0][0] != "bot":
            raise HTTPException(
                400, detail="exactly one bot query parameter is required"
            )
        if paper.status is None:
            raise _unbound("native observations")
        if query[0][1] != paper.bot_name:
            raise HTTPException(404, detail="bot is not the bound V5 paper bot")
        return _paper_bootstrap(paper)

    if path == "/api/v1/operations" or path.startswith("/api/v1/operations/"):
        raise _unbound("native operations")
    if path.startswith("/api/v1/trading-visuals/"):
        raise _unbound("native observations")
    if path == "/api/v1/research" or path.startswith("/api/v1/research/"):
        raise _unbound("Research OS")
    if (
        path == "/api/v1/tradepad"
        or path.startswith("/api/v1/tradepad/")
        or path.startswith("/api/v1/backtest")
    ):
        raise _unbound("Tradepad")
    if path.startswith("/api/v1/market-picture") or path.startswith("/api/v1/screener"):
        raise _unbound("native market-picture frame")
    if "/servers/" in path:
        raise HTTPException(403, detail="server identity is outside V5 scope")
    raise HTTPException(404, detail="V5 compatibility read is not registered")


def _require_no_query(query: str) -> None:
    if query:
        raise HTTPException(
            400, detail="query parameters are not supported for this read"
        )


def paper_read_route(path: str, query: str, bot: str | None) -> tuple[str, str] | None:
    prefix = f"/api/v1/servers/{V5_SERVER_ID}/"
    routes = {
        "fleet/holdings": "positions", "fleet/fills": "fills",
        "fleet/summary": "wallet", "account-balances": "wallet",
        "controller-performance/history": "history",
        f"bots/{bot}/native/status": "status", f"bots/{bot}/quant-summary": "status",
        f"bots/{bot}/executors": "executors", f"bots/{bot}/risk": "risk",
        f"bots/{bot}/decisions": "decisions", f"bots/{bot}/decision-journal": "decisions",
    }
    section = routes.get(path.removeprefix(prefix)) if path.startswith(prefix) else None
    if path in {"/api/v1/operations", "/api/v1/operations/workspace"}:
        section = "operations"
    if section is None:
        return None
    try:
        params = parse_qsl(query, keep_blank_values=True, strict_parsing=True) if query else []
    except ValueError:
        raise HTTPException(400, detail="invalid paper read query") from None
    if len(params) != len(dict(params)):
        raise HTTPException(400, detail="duplicate paper read query")
    forwarded = []
    for key, value in params:
        if key == "bot" and value == bot:
            continue
        if key == "interval" and section == "history" and value in {"1m", "5m", "1h", "1d"}:
            continue
        if key == "limit" and value.isascii() and value.isdigit() and 1 <= int(value) <= 1000:
            forwarded.append((key, value))
        elif key in {"start_ms", "end_ms"} and value.isascii() and value.isdigit() and 0 <= int(value) <= 10**14:
            forwarded.append((key, value))
        elif key == "cursor" and re.fullmatch(r"[A-Za-z0-9_.:=-]{1,1024}", value):
            forwarded.append((key, value))
        else:
            raise HTTPException(400, detail="unsupported paper read query")
    bounds = dict(forwarded)
    if "start_ms" in bounds and "end_ms" in bounds and int(bounds["start_ms"]) > int(bounds["end_ms"]):
        raise HTTPException(400, detail="inverted paper read range")
    from urllib.parse import urlencode

    return section, urlencode(forwarded)


def _unbound(owner: str) -> HTTPException:
    return HTTPException(503, detail=f"V5 {owner} owner is UNBOUND")


def _server_status(paper: PaperObservation | None = None) -> dict:
    status = {
        "status": "online",
        "profile": "native",
        "message": "V5 dashboard process is online; native Hummingbot owner is unbound.",
        "capabilities": {
            "native_status": True,
            "accounts": False,
            "account_management": False,
            "portfolio_read": False,
            "manual_trading": False,
            "executor_management": False,
            "docker": False,
            "fleet_catalogue": False,
            "market_screener": False,
            "market_picture": False,
            "native_controls_enabled": False,
            "native_stop": False,
            "performance_history": False,
        },
        "process_health": "RUNNING",
        "native_owner": "UNBOUND",
        "native_owner_reason": "The exact V5 controller baseline and native decision trace are not bound.",
        "baseline_binding": None,
        "execution_enabled": False,
    }
    if paper is not None:
        owner, reason = _paper_owner_state(paper)
        status.update(
            message=f"V5 dashboard process is online; native paper owner is {owner}.",
            native_owner=owner,
            native_owner_reason=reason,
            paper_owner=_paper_owner(paper),
        )
    return status


def _bots_unbound() -> dict:
    return {
        "controllers": [],
        "bots": [],
        "total_pnl": None,
        "total_volume": None,
        "metrics_available": False,
        "metrics_unavailable_reason": "V5 native bot owner is unbound.",
        "server_online": True,
        "error_hint": "Native strategy and bot state are UNBOUND in this V5 workspace.",
        "native_owner": "UNBOUND",
    }


# --- read-only paper owner projections -------------------------------------------

PAPER_CONNECTOR = "simulated_paper_wallet"
MAX_CUSTOM_INFO_BYTES = 8_192
MAX_ROWS = 64


def _paper_owner_state(paper: PaperObservation) -> tuple[str, str]:
    if paper.state == "FRESH":
        return "PAPER_BOUND", (
            f"Native V5 paper runtime {paper.bot_name} is bound read-only from its status file; "
            "its orders fill only against the simulated paper wallet."
        )
    if paper.state == "STALE":
        age = int(paper.observed_at - paper.status["generated_at"])
        return "STALE", (
            f"The paper status for {paper.bot_name} is stale ({age}s old); "
            "no current paper owner state is available."
        )
    return (
        "UNAVAILABLE",
        f"The configured paper status file is unavailable ({paper.reason}).",
    )


def _paper_owner(paper: PaperObservation) -> dict:
    status = paper.status or {}
    assumptions = status.get("simulation_assumptions") or {}
    return {
        "bot_name": paper.bot_name,
        "state": paper.state,
        "reason": paper.reason,
        "mode": "PAPER",
        "execution": "SIMULATED_WALLET_ONLY",
        "generated_at": status.get("generated_at"),
        "ready": status.get("ready") if paper.state == "FRESH" else None,
        "readiness_reasons": list(status.get("reasons", []))[:MAX_ROWS],
        "failure": status.get("failure"),
        "controller_kind": status.get("controller_kind"),
        "process_boot_id": status.get("process_boot_id"),
        "source_sha256": status.get("source_sha256"),
        "simulation_assumptions": {
            key: assumptions.get(key)
            for key in (
                "quote",
                "trade_participation",
                "book_depth",
                "queue_priority_verified",
            )
            if isinstance(assumptions.get(key), (str, int, float, bool))
        },
    }


def _lifecycle(paper: PaperObservation) -> str:
    status = paper.status
    if paper.state != "FRESH":
        return "stale"
    if status["failure"] is not None:
        return "failed"
    if "runtime_stopped" in status["reasons"]:
        return "stopped"
    return "running"


# Plain decimal text as the native reports write it; Decimal alone also admits
# underscores ("1_0") and spellings that float() refuses.
_DECIMAL_TEXT = re.compile(r"-?\d{1,40}(?:\.\d{1,40})?(?:[eE][-+]?\d{1,4})?")


def _decimal_text(value) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    if isinstance(value, str) and _DECIMAL_TEXT.fullmatch(value) is None:
        return None
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        return None
    return str(value) if number.is_finite() else None


def _float(value) -> float | None:
    """A finite float or None: a finite decimal beyond float range ("1e999") is withheld."""
    text = _decimal_text(value)
    if text is None:
        return None
    try:
        number = float(text)
    except (ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _side(value) -> str | None:
    # TradeType serializes by value (1 BUY, 2 SELL) or by name.
    # Only a scalar side is looked up; a malformed (unhashable) value is unavailable.
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return None
    return {1: "BUY", 2: "SELL", "BUY": "BUY", "SELL": "SELL"}.get(value)


def _custom_info(row: dict) -> dict:
    info = row.get("custom_info") or {}
    try:
        encoded = json.dumps(info, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError):
        return {"unavailable": "custom_info_invalid"}
    return (
        info
        if len(encoded) <= MAX_CUSTOM_INFO_BYTES
        else {"unavailable": "custom_info_capacity"}
    )


def _pairs(row: dict) -> list[str]:
    return row["pair"] if isinstance(row["pair"], list) else [row["pair"]]


def _report(paper: PaperObservation, controller_id: str) -> dict | None:
    status = paper.status
    if paper.state != "FRESH" or controller_id in status["unavailable_controller_ids"]:
        return None
    report = status["native_reports"].get(controller_id)
    return report if isinstance(report, dict) else None


def _performance(report: dict | None) -> dict | None:
    performance = report.get("performance") if report else None
    if (
        not isinstance(performance, dict)
        or performance.get("pnl_available") is not True
    ):
        return None
    if any(
        _float(performance.get(key)) is None
        for key in (
            "realized_pnl_quote",
            "unrealized_pnl_quote",
            "global_pnl_quote",
            "volume_traded",
        )
    ):
        return None
    return performance


def _paper_bots(paper: PaperObservation) -> dict:
    owner, reason = _paper_owner_state(paper)
    if paper.status is None:
        page = _bots_unbound()
        page.update(
            native_owner=owner, metrics_unavailable_reason=reason, error_hint=reason
        )
        return page
    status = paper.status
    lifecycle = _lifecycle(paper)
    fresh = paper.state == "FRESH"
    controllers = []
    complete = (
        fresh and lifecycle != "failed" and status["report_observed_at"] is not None
    )
    for row in status["controllers"] if fresh else []:
        performance = _performance(_report(paper, row["id"]))
        complete = complete and performance is not None
        counts = (performance or {}).get("close_type_counts") or {}
        controllers.append(
            {
                "controller_name": row["controller_name"],
                "controller_id": row["id"],
                "bot_name": paper.bot_name,
                "status": lifecycle
                if performance is not None
                else "report_unavailable",
                "connector": PAPER_CONNECTOR,
                "trading_pair": ",".join(_pairs(row)),
                "realized_pnl_quote": _float(
                    (performance or {}).get("realized_pnl_quote")
                ),
                "unrealized_pnl_quote": _float(
                    (performance or {}).get("unrealized_pnl_quote")
                ),
                "global_pnl_quote": _float((performance or {}).get("global_pnl_quote")),
                "global_pnl_pct": _float((performance or {}).get("global_pnl_pct")),
                "volume_traded": _float((performance or {}).get("volume_traded")),
                "close_type_counts": {
                    str(key)[:64]: value
                    for key, value in list(counts.items())[:16]
                    if type(value) is int
                }
                if isinstance(counts, dict)
                else {},
                "positions_summary": [],
                "deployed_at": None,
                "config": {},
                "custom_info": _custom_info(row),
            }
        )
    reasons = list(status["reasons"])[:MAX_ROWS]
    generated = status["generated_at"]
    bot = {
        "bot_name": paper.bot_name,
        "status": lifecycle,
        "num_controllers": len(status["controllers"]),
        "controller_count_current": fresh,
        "performance_received_at": status["report_observed_at"] if fresh else None,
        "performance_stale_after_seconds": STALE_AFTER_SECONDS,
        "status_received_at": generated,
        "status_stale_after_seconds": STALE_AFTER_SECONDS,
        "error_count": 0 if status["failure"] is None else 1,
        "deployed_at": None,
        "error_logs": []
        if status["failure"] is None
        else [
            {
                "timestamp": generated,
                "msg": f"Paper runtime failure: {status['failure']}",
            }
        ],
        "general_logs": [
            {"timestamp": generated, "msg": f"Not ready: {item}"} for item in reasons
        ],
        "execution_mode": "PAPER",
        "execution": "SIMULATED_WALLET_ONLY",
        "simulated": True,
        "ready": status["ready"] if fresh else None,
        "readiness_reasons": reasons,
        "failure": status["failure"],
        "controller_kind": status["controller_kind"],
        "process_boot_id": status["process_boot_id"],
    }
    total_pnl = (
        sum(row["global_pnl_quote"] for row in controllers) if complete else None
    )
    total_volume = (
        sum(row["volume_traded"] for row in controllers) if complete else None
    )
    # Finite parts can still sum beyond float range.
    complete = complete and math.isfinite(total_pnl) and math.isfinite(total_volume)
    return {
        "controllers": controllers,
        "bots": [bot],
        "total_pnl": total_pnl if complete else None,
        "total_volume": total_volume if complete else None,
        "metrics_available": complete,
        "metrics_unavailable_reason": None
        if complete
        else (
            reason
            if not fresh
            else "Some paper controller reports are unavailable or the runtime is not reporting."
        ),
        "server_online": True,
        "error_hint": None if fresh else reason,
        "native_owner": owner,
        "paper_owner": _paper_owner(paper),
    }


def _report_rows(controller_id: str, report: dict | None) -> tuple[list, list] | None:
    """Positions and active executors of one native report, or None when unrecognized."""
    if report is None:
        return None
    # Both lists are required: a missing list is an unknown, never an empty book.
    executors, positions = report.get("executors"), report.get("positions")
    if (
        not isinstance(executors, list)
        or not isinstance(positions, list)
        or len(executors) + len(positions) > 4 * MAX_ROWS
    ):
        return None
    active, held = [], []
    for item in executors:
        config = item.get("config") if isinstance(item, dict) else None
        if (
            not isinstance(config, dict)
            or not isinstance(item.get("id"), str)
            or not isinstance(item.get("is_active"), bool)
        ):
            return None
        if not item["is_active"]:
            continue
        pair = config.get("trading_pair")
        if not isinstance(pair, str) or "-" not in pair:
            return None
        active.append(
            {
                "executor_id": item["id"][:128],
                "pair": pair,
                "controller_id": controller_id,
                "type": str(item.get("type"))[:64],
                "side": _side(config.get("side")),
                "filled_amount_quote": _decimal_text(item.get("filled_amount_quote")),
                "net_pnl_quote": _decimal_text(item.get("net_pnl_quote")),
                "is_trading": item.get("is_trading") is True,
            }
        )
    for item in positions:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("trading_pair"), str)
            or _decimal_text(item.get("amount")) is None
        ):
            return None
        held.append(
            {
                "controller_id": controller_id,
                "pair": item["trading_pair"],
                "side": _side(item.get("side")),
                **{
                    key: _decimal_text(item.get(key))
                    for key in (
                        "amount",
                        "breakeven_price",
                        "unrealized_pnl_quote",
                        "realized_pnl_quote",
                        "cum_fees_quote",
                    )
                },
            }
        )
    return held, active


def _report_state(paper: PaperObservation, controller_id: str, current: bool) -> dict:
    """Whether a controller's report is current; a retained one is labelled with its own date."""
    if current:
        return {"report_state": "current"}
    status = paper.status
    retained = status.get("retained_reports")
    observed = status.get("retained_reports_observed_at")
    if (
        paper.state == "FRESH"
        and isinstance(retained, dict)
        and isinstance(retained.get(controller_id), dict)
        and type(observed) in (int, float)
        and math.isfinite(observed)
    ):
        # Valued at a quiet book's last observation: dated, never current, and
        # never counted into this observation's executors or positions.
        return {"report_state": "retained", "report_observed_at": observed}
    return {"report_state": "unavailable"}


def _paper_bootstrap(paper: PaperObservation) -> dict:
    status = paper.status
    controllers, positions, executors = [], [], []
    complete = True
    for row in status["controllers"]:
        rows = _report_rows(row["id"], _report(paper, row["id"]))
        if rows is None:
            complete = False
        else:
            positions.extend(rows[0])
            executors.extend(rows[1])
        report_state = _report_state(paper, row["id"], rows is not None)
        info = _custom_info(row)
        pairs = _pairs(row)
        for pair in pairs:
            controllers.append(
                {
                    "controller_id": row["id"],
                    "controller_name": row["controller_name"],
                    "pair": pair,
                    "state": info.get("modular_status")
                    if isinstance(info.get("modular_status"), str)
                    else None,
                    "execution_mode": "paper",
                    "observation_status": "available"
                    if rows is not None
                    else "unavailable",
                    "custom_info": info,
                    **report_state,
                    **(
                        {"pair_projection_source": "native_owner_symbols"}
                        if isinstance(row["pair"], list)
                        else {}
                    ),
                }
            )
    updated = datetime.fromtimestamp(status["generated_at"], tz=timezone.utc)
    return {
        "runtime_status": {
            "bot_name": paper.bot_name,
            "updated_at": updated.isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"
            ),
            "execution_mode": "paper",
            "execution": "SIMULATED_WALLET_ONLY",
            "simulated": True,
            "ready": status["ready"],
            "readiness_reasons": list(status["reasons"])[:MAX_ROWS],
            "controllers": controllers,
            # Bot-wide lists are null, not partial, unless every controller has a
            # current native report: a missing report is not zero executors.
            "positions_held": positions if complete else None,
            "active_executors": executors if complete else None,
            "active_orders_count": None,
        },
        "monitoring": {
            "bot_name": paper.bot_name,
            "stale_threshold_seconds": STALE_AFTER_SECONDS,
        },
    }
