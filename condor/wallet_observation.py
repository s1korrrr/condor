"""Shared-wallet valuation samples read from the configured reporting owner.

The engine values its connector balances in its configured global token and
reporting republishes that value with the declared currency. Condor only
observes and stores it; nothing here infers prices, currencies or equity.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)

READ_TIMEOUT = 8.0
MAX_BYTES = 2 * 1024 * 1024
CURRENCY = re.compile(r"^[A-Z0-9]{2,12}$")


def configured_sources() -> dict[str, dict[str, str]]:
    """Loopback reporting sources keyed by bot, as the Trading Visuals proxy validates them."""
    try:
        sources = json.loads(os.environ.get("CONDOR_TRADING_VISUALS_SOURCES", "{}"))
    except ValueError:
        return {}
    if not isinstance(sources, dict):
        return {}
    valid: dict[str, dict[str, str]] = {}
    for bot, source in sources.items():
        if not isinstance(bot, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", bot) or not isinstance(source, dict):
            continue
        server, url = source.get("server"), source.get("url")
        if not isinstance(server, str) or not server or not isinstance(url, str):
            continue
        parsed = urlsplit(url)
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path.rstrip("/") not in {"/api/v1", "/trading-visuals"}):
            continue
        valid[bot] = {k: v for k, v in source.items() if isinstance(v, str)}
    return valid


def _decimal(value: object) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() and number >= 0 else None


def project_wallet(payload: object, bot: str) -> dict:
    """Validate one reporting runtime-status body into a wallet sample. Raises ValueError when not admissible."""
    if not isinstance(payload, dict):
        raise ValueError("Runtime status is not an object")
    runtime = payload.get("runtime_status")
    if not isinstance(runtime, dict) or runtime.get("bot_name") != bot:
        raise ValueError("Runtime status does not belong to this bot")
    summary = runtime.get("summary")
    if not isinstance(summary, dict) or summary.get("balance_value_scope") != "account_wallet":
        raise ValueError("Wallet scope is not declared")
    currency = summary.get("balance_value_currency")
    if not isinstance(currency, str) or not CURRENCY.fullmatch(currency):
        raise ValueError("Wallet valuation currency is not declared")
    value = _decimal(summary.get("balance_value_quote"))
    if value is None:
        raise ValueError("Wallet value is missing")
    if value == 0:
        # A restarting engine publishes 0.0 for every asset until its connector loads balances.
        raise ValueError("Wallet valuation is zero; connector balances are not loaded")
    observed = runtime.get("updated_at")
    if not isinstance(observed, str):
        raise ValueError("Wallet observation time is missing")
    try:
        parsed = datetime.fromisoformat(observed.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Wallet observation time is invalid") from exc
    if parsed.tzinfo is None:
        raise ValueError("Wallet observation time is not offset-aware")
    balances = runtime.get("balances")
    rows = []
    for row in balances if isinstance(balances, list) else []:
        if not isinstance(row, dict) or not isinstance(row.get("asset"), str):
            continue
        rows.append({"asset": row["asset"], "total": str(row.get("total_balance")),
                     "available": None if row.get("available_balance") is None else str(row.get("available_balance")),
                     "value": str(row.get("value_quote"))})
    source_id = runtime.get("source_runtime_status_id")
    return {
        "timestamp": parsed.timestamp(),
        "currency": currency,
        "value_quote": str(value),
        "source_id": source_id if isinstance(source_id, str) else "",
        "balances": rows,
    }


async def _read(client: httpx.AsyncClient, source: dict[str, str], bot: str) -> object:
    auth = None
    if source.get("username_env") and source.get("password_env"):
        auth = httpx.BasicAuth(os.environ.get(source["username_env"], ""), os.environ.get(source["password_env"], ""))
    async with client.stream("GET", source["url"].rstrip("/") + "/runtime-status", params={"bot": bot}, auth=auth) as response:
        if response.status_code != 200:
            raise ValueError(f"Reporting returned {response.status_code}")
        content = bytearray()
        async for chunk in response.aiter_bytes():
            if len(content) + len(chunk) > MAX_BYTES:
                raise ValueError("Reporting runtime status exceeds the size limit")
            content.extend(chunk)
    return json.loads(bytes(content))


async def observe(server: str, sources: dict[str, dict[str, str]] | None = None) -> dict[str, dict | None]:
    """One sample per configured bot on `server`; None when the read or validation failed."""
    sources = configured_sources() if sources is None else sources
    scoped = {bot: source for bot, source in sources.items() if source.get("server") == server}
    if not scoped:
        return {}
    samples: dict[str, dict | None] = {}
    async with httpx.AsyncClient(timeout=READ_TIMEOUT, follow_redirects=False, trust_env=False) as client:
        for bot, source in scoped.items():
            try:
                async with asyncio.timeout(READ_TIMEOUT + 2):
                    samples[bot] = project_wallet(await _read(client, source, bot), bot)
            except (ValueError, httpx.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
                logger.debug("Wallet observation unavailable for %s/%s: %s", server, bot, exc)
                samples[bot] = None
    return samples
