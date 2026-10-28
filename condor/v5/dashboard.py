"""Fixed local compatibility projections for the isolated V5 dashboard.

This module deliberately has no client, filesystem, or Condor-owner imports. It
does not proxy the ordinary dashboard API. Only the exact reads below are
projected; owner-backed categories fail visibly until a native V5 owner binds.
"""

from __future__ import annotations

from urllib.parse import unquote, urlsplit

from fastapi import HTTPException

V5_SERVER_ID = "rsibot-v5"
V5_HOST = "razer"
V5_PORT = 8088
CONDOR_BASE_REVISION = "ff8858df765cffe4d325fde384f7a2eecdf51641"
MAX_READ_PATH_LENGTH = 2048


def dashboard_profile() -> dict:
    """Return V5 identity and explicit unbound-owner readiness."""
    return {
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


def read_compatibility_path(raw_path: str) -> object:
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
            return _server_status()
        if suffix == "bots":
            _require_no_query(parts.query)
            return _bots_unbound()
        if suffix.startswith(
            ("portfolio", "account-balances", "fleet", "executors", "positions")
        ):
            raise _unbound("account and execution")
        if suffix.startswith(("market-picture", "screener", "market")):
            raise _unbound("native market-picture frame")
        raise HTTPException(404, detail="V5 compatibility read is not registered")

    if path == "/api/v1/trading-visuals/sources":
        _require_no_query(parts.query)
        # The parser expects a `sources` array. V5 has no native bot owner bound.
        return {"sources": []}

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


def _unbound(owner: str) -> HTTPException:
    return HTTPException(503, detail=f"V5 {owner} owner is UNBOUND")


def _server_status() -> dict:
    return {
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
