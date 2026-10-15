"""Simulated PnL observations of paper bots, read from the reporting owner's runtime status.

A paper bot publishes no native performance to the API, so its PnL history is recorded from the
same reporting runtime-status body the wallet observer already reads. The body has the live shape:
``runtime_status.summary`` carries ``realized_pnl_quote`` and ``unrealized_pnl_quote`` (with
``fees_quote`` and ``net_pnl_quote``), ``controllers[].pair`` names the traded pairs and
``updated_at`` stamps the observation. The total is ``realized + unrealized``, the same definition
as a live bot's ``global_pnl_quote``.

These points are simulated: they are stored apart from live points, read back with
``simulated: true`` and never enter a fleet window, a wallet total or Capital.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation

from condor.fleet_identity import is_paper

STALE_AFTER_SECONDS = (
    120  # the reporting owner republishes runtime status every few seconds
)
FUTURE_SKEW_SECONDS = 5
PAIR = re.compile(r"[A-Z0-9]+-[A-Z0-9]+")


def _number(value: object) -> Decimal:
    if value is None or isinstance(value, bool):
        raise ValueError("Missing numeric observation")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("Invalid numeric observation") from exc
    if not result.is_finite():
        raise ValueError("Nonfinite observation")
    return result


def project_paper(payload: object, bot: str, now: float) -> dict:
    """Validate one reporting runtime-status body of a paper bot into a simulated PnL point.

    Raises ValueError when the body does not belong to a current, self-consistent paper report.
    """
    if not is_paper(bot):
        raise ValueError("Only paper bots record simulated PnL")
    if not isinstance(payload, dict):
        raise ValueError("Runtime status is not an object")
    runtime = payload.get("runtime_status")
    if not isinstance(runtime, dict) or runtime.get("bot_name") != bot:
        raise ValueError("Runtime status does not belong to this bot")
    if payload.get("simulated") is False or runtime.get("simulated") is False:
        raise ValueError("A paper bot reported a non-simulated runtime")
    summary = runtime.get("summary")
    if not isinstance(summary, dict) or summary.get("pnl_available") is False:
        raise ValueError("Paper PnL is not available")
    realized = _number(summary.get("realized_pnl_quote"))
    unrealized = _number(summary.get("unrealized_pnl_quote"))
    if (
        summary.get("net_pnl_quote") is not None
        and summary.get("fees_quote") is not None
    ):
        net, fees = _number(summary["net_pnl_quote"]), _number(summary["fees_quote"])
        # The paper summary declares whether its native controller PnL already includes fees
        # (fees_quote is then informational); the live convention subtracts them from net.
        if summary.get("fees_included_in_pnl") is True:
            expected = realized + unrealized
        else:
            expected = realized + unrealized - fees
        if abs(net - expected) > Decimal("0.00001"):
            raise ValueError("Inconsistent paper PnL summary")
    observed = runtime.get("updated_at")
    if not isinstance(observed, str):
        raise ValueError("Paper observation time is missing")
    try:
        parsed = datetime.fromisoformat(observed.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Paper observation time is invalid") from exc
    if parsed.tzinfo is None:
        raise ValueError("Paper observation time is not offset-aware")
    stamp = parsed.timestamp()
    if not -FUTURE_SKEW_SECONDS <= now - stamp < STALE_AFTER_SECONDS:
        raise ValueError("Expired paper observation")
    controllers = runtime.get("controllers")
    pairs = sorted(
        {
            row["pair"]
            for row in controllers
            if isinstance(row, dict)
            and isinstance(row.get("pair"), str)
            and PAIR.fullmatch(row["pair"])
        }
        if isinstance(controllers, list)
        else set()
    )
    if not pairs:
        raise ValueError("Unknown quote currency")
    quotes = {pair.split("-")[1] for pair in pairs}
    if len(quotes) != 1:
        raise ValueError("Mixed quote currencies")
    source = runtime.get("source_runtime_status_id")
    identity = hashlib.sha256(
        json.dumps([bot, source if isinstance(source, str) else "", pairs]).encode()
    ).hexdigest()
    return {
        "timestamp": stamp,
        "identity": identity,
        "quote": quotes.pop(),
        "realized_pnl_quote": str(realized),
        "unrealized_pnl_quote": str(unrealized),
        "total_pnl_quote": str(realized + unrealized),
    }


def paper_samples(
    bodies: dict[str, object | None], now: float
) -> dict[str, dict | None]:
    """One simulated point per paper bot read; None when the read or validation failed. Live bots are skipped."""
    samples: dict[str, dict | None] = {}
    for bot, body in bodies.items():
        if not is_paper(bot):
            continue
        try:
            samples[bot] = None if body is None else project_paper(body, bot, now)
        except (ValueError, TypeError, KeyError, AttributeError):
            samples[bot] = None
    return samples
