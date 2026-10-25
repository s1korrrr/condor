"""``fleet-holdings.v1``: current native inventory, admitted once for every client.

The reporting owner computes per-pair inventory from its own runtime observation
(``rsibot.quant_ops.v1`` ``quant-summary``: units, mark, marked value, cost, PnL). That is the
only inventory computation. This module admits it, normalizes it to exact decimal strings,
and adds the display facts every client needs (freshness, completeness, totals, small-holding
grouping). The dashboard, the fleet summary cards and the iPhone app render the result; none
of them re-derives inventory from raw ``bootstrap`` or ``positions`` payloads.

Pure: no I/O, no clock reads. Contract: ``docs/reference/fleet-holdings-v1.md`` (rsibot root).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from condor.fleet_identity import is_paper
from condor.web import fleet_pnl

SCHEMA_VERSION = "fleet-holdings.v1"
OWNER_SCHEMA = "rsibot.quant_ops.v1"
# The owner's own inventory freshness (``stale_after_seconds`` of its quant view).
STALE_AFTER_MS = 30_000
CLOCK_SKEW_MS = 5_000
SMALL_VALUE_QUOTE = Decimal(1)
PAIR = re.compile(r"[A-Z0-9]+-[A-Z0-9]+")
ASSET = re.compile(r"[A-Z0-9]+")
# Owner pair states with work in progress: never grouped as a small holding.
ACTIVE_STATES = frozenset({"BUILDING", "TRAILING", "EXITING", "UNKNOWN"})

CURRENT, STALE, UNAVAILABLE = "current", "stale", "unavailable"

# Bot unavailable.
SOURCE_UNAVAILABLE = "SOURCE_UNAVAILABLE"
OWNER_SCHEMA_UNSUPPORTED = "OWNER_SCHEMA_UNSUPPORTED"
IDENTITY_MISMATCH = "IDENTITY_MISMATCH"
OBSERVATION_TIME_INVALID = "OBSERVATION_TIME_INVALID"
CLOCK_SKEW = "CLOCK_SKEW"
MODE_UNVERIFIED = "MODE_UNVERIFIED"
QUOTE_UNVERIFIED = "QUOTE_UNVERIFIED"
OWNER_NOT_READY = "OWNER_NOT_READY"
PAIRS_INVALID = "PAIRS_INVALID"
RUNTIME_NOT_CURRENT = "RUNTIME_NOT_CURRENT"
# Unavailable because the owner payload is malformed, rather than because the owner withholds it.
MALFORMED = frozenset(
    {
        OWNER_SCHEMA_UNSUPPORTED,
        IDENTITY_MISMATCH,
        OBSERVATION_TIME_INVALID,
        CLOCK_SKEW,
        PAIRS_INVALID,
    }
)

# Bot admitted, totals and counts unknown.
PAIR_QUANTITY_UNKNOWN = "PAIR_QUANTITY_UNKNOWN"
PAIR_DUPLICATE = "PAIR_DUPLICATE"
PAIR_FIELD_INVALID = "PAIR_FIELD_INVALID"  # a published number that does not parse: malformed, not unknown
VALUE_UNKNOWN = "VALUE_UNKNOWN"


def _obj(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() else None


def _dec(value: Any) -> Optional[Decimal]:
    """An owner decimal string (or number) as an exact decimal; malformed, boolean or non-finite is ``None``."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    if isinstance(value, int) and value.bit_length() > 1024:
        return None
    return fleet_pnl._amount(str(value))


def _nonneg(value: Any) -> Optional[Decimal]:
    number = _dec(value)
    return number if number is not None and number >= 0 else None


def _positive(value: Any) -> Optional[Decimal]:
    number = _dec(value)
    return number if number is not None and number > 0 else None


def _out(value: Optional[Decimal]) -> Optional[str]:
    return fleet_pnl.decimal_text(value)


def _sum(values: list[Optional[Decimal]]) -> Optional[Decimal]:
    if any(value is None for value in values):
        return None
    return fleet_pnl.exact_sum(values)  # type: ignore[arg-type]


def instant_ms(value: Any) -> Optional[int]:
    """ISO-8601 with an explicit offset -> epoch ms. Naive stamps are ambiguous and rejected."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    try:
        instant = int(round(parsed.astimezone(timezone.utc).timestamp() * 1000))
    except (OverflowError, ValueError, OSError):
        return None
    return instant if instant >= 0 else None


def unavailable_bot(bot: str, reason: str) -> dict:
    """A bot whose inventory cannot be read or admitted. Never an empty book."""
    return {
        "bot": bot,
        "paper": is_paper(bot),
        "state": UNAVAILABLE,
        "reason": reason,
        "observed_at_ms": None,
        "stale_after_ms": STALE_AFTER_MS,
        "snapshot_id": None,
        "owner_boot_id": None,
        "quote_asset": None,
        "inventory_complete": False,
        "value_complete": False,
        "incomplete_reasons": [],
        "registered_pair_count": None,
        "held_pair_count": None,
        "totals": None,
        "pairs": [],
    }


def admit(payload: Any, bot: str, now_ms: float) -> dict:
    """Admission of the owner's quant view: ``{state, reason, observed_ms, pairs_raw, ...}``.

    ``current``: identity-bound, mode and quote verified, the owner reports itself ready, and the
    observation is younger than ``STALE_AFTER_MS``. ``stale``: the owner's last-known pairs of an
    older observation. ``unavailable`` otherwise, with a reason.
    """
    envelope = _obj(payload)
    scope, data = _obj(envelope.get("scope")), _obj(envelope.get("data"))
    if (
        envelope.get("schema_version") != OWNER_SCHEMA
        or envelope.get("execution_authorized") is not False
    ):
        return {"state": UNAVAILABLE, "reason": OWNER_SCHEMA_UNSUPPORTED}
    if scope.get("bot_key") != bot or data.get("bot_id") != bot:
        return {"state": UNAVAILABLE, "reason": IDENTITY_MISMATCH}
    generated = instant_ms(envelope.get("generated_at"))
    if generated is None:
        return {"state": UNAVAILABLE, "reason": OBSERVATION_TIME_INVALID}
    if generated > now_ms + CLOCK_SKEW_MS:
        return {"state": UNAVAILABLE, "reason": CLOCK_SKEW}
    if scope.get("execution_mode") not in ("live", "paper"):
        return {"state": UNAVAILABLE, "reason": MODE_UNVERIFIED}
    base = {
        "snapshot_id": _text(envelope.get("snapshot_id")),
        "owner_boot_id": _text(scope.get("owner_boot_id")),
        "simulated": scope.get("execution_mode") == "paper",
    }
    observed = instant_ms(
        data.get("heartbeat")
        or _obj(envelope.get("source_times")).get("runtime_status")
    )
    # The owner's explicit coverage verdict admits the source (a unified multi-pair controller has no
    # per-pair state, so its label stays UNKNOWN while its inventory is verified). An envelope without
    # coverage keeps the label rule.
    coverage = envelope.get("coverage")
    if isinstance(coverage, dict):
        ready = coverage.get("ready")
        reasons = coverage.get("reasons")
        owner_ready = (
            isinstance(ready, int)
            and not isinstance(ready, bool)
            and ready > 0
            and reasons == []
        )
    else:
        label = data.get("operational_label")
        reasons, owner_ready = (
            None,
            isinstance(label, str) and bool(label.strip()) and label != "UNKNOWN",
        )
    current = (
        observed is not None
        and observed <= now_ms + CLOCK_SKEW_MS
        and now_ms - observed < STALE_AFTER_MS
    )
    quote = scope.get("quote_currency")
    if current and owner_ready:
        if not isinstance(quote, str) or not ASSET.fullmatch(quote):
            return {"state": UNAVAILABLE, "reason": QUOTE_UNVERIFIED, **base}
        return {
            "state": CURRENT,
            "reason": None,
            "observed_ms": observed,
            "quote": quote,
            "pairs_raw": data.get("pairs"),
            **base,
        }
    # Last known: the owner's own last-known block, or its admitted pairs once they have aged here.
    known = _obj(data.get("last_known"))
    if not known and owner_ready and observed is not None:
        known = {
            "observed_at": data.get("heartbeat")
            or _obj(envelope.get("source_times")).get("runtime_status"),
            "quote_currency": quote,
            "pairs": data.get("pairs"),
        }
    known_observed = instant_ms(known.get("observed_at"))
    known_quote = known.get("quote_currency")
    if (
        not current
        and known
        and known_observed is not None
        and known_observed <= now_ms + CLOCK_SKEW_MS
    ):
        if not isinstance(known_quote, str) or not ASSET.fullmatch(known_quote):
            return {"state": UNAVAILABLE, "reason": QUOTE_UNVERIFIED, **base}
        return {
            "state": STALE,
            "reason": None,
            "observed_ms": known_observed,
            "quote": known_quote,
            "pairs_raw": known.get("pairs"),
            **base,
        }
    reason = next(
        (
            r
            for r in reasons or []
            if isinstance(r, str) and re.fullmatch(r"[A-Z0-9_]{1,64}", r)
        ),
        None,
    )
    return {
        "state": UNAVAILABLE,
        "reason": reason or (OWNER_NOT_READY if current else RUNTIME_NOT_CURRENT),
        **base,
    }


def _pair(row: dict, quote: str) -> Optional[tuple[dict, bool]]:
    """A normalized owner pair and whether any published number in it was malformed."""
    pair = row.get("pair")
    if not isinstance(pair, str) or not PAIR.fullmatch(pair):
        return None
    base_asset, quote_asset = pair.split("-")
    units = _nonneg(row.get("units"))
    mark = (
        _positive(row.get("mark"))
        if row.get("mark_availability") == "available"
        else None
    )
    marked = _nonneg(row.get("marked_value"))
    parsed = {
        "units": units,
        "entry_cost": _nonneg(row.get("entry_cost")),
        "breakeven_price": _positive(row.get("breakeven_price")),
        "marked_value": marked,
        "unrealized": _dec(row.get("unrealized")),
        "realized": _dec(row.get("realized")),
        "fees": _nonneg(row.get("fees")),
    }
    invalid = any(
        row.get(key) is not None and value is None for key, value in parsed.items()
    ) or (row.get("mark_availability") == "available" and mark is None)
    state = row.get("state") if isinstance(row.get("state"), str) else "UNKNOWN"
    executors = row.get("running_executors")
    executors = (
        executors
        if isinstance(executors, int)
        and not isinstance(executors, bool)
        and executors >= 0
        else None
    )
    small = (
        units is not None
        and units > 0
        and marked is not None
        and marked < SMALL_VALUE_QUOTE
        and quote_asset == quote
        and executors == 0
        and state not in ACTIVE_STATES
    )
    return {
        "pair": pair,
        "controller_id": _text(row.get("controller_id")),
        "base_asset": base_asset,
        "quote_asset": quote_asset,
        "state": state,
        "units": _out(units),
        "entry_cost_quote": _out(_nonneg(row.get("entry_cost"))),
        "breakeven_price": _out(_positive(row.get("breakeven_price"))),
        "mark_price": _out(mark),
        "mark_source": _text(row.get("mark_source")),
        "marked_value_quote": _out(marked),
        "unrealized_pnl_quote": _out(_dec(row.get("unrealized"))),
        "realized_pnl_quote": _out(_dec(row.get("realized"))),
        "fees_quote": _out(_nonneg(row.get("fees"))),
        "running_executor_count": executors,
        "small": small,
    }, invalid


def project_bot(payload: Any, bot: str, now_ms: float) -> dict:
    """One bot's inventory as every client renders it."""
    admission = admit(payload, bot, now_ms)
    if admission["state"] == UNAVAILABLE:
        return {
            **unavailable_bot(bot, admission["reason"]),
            "owner_boot_id": admission.get("owner_boot_id"),
            "snapshot_id": admission.get("snapshot_id"),
        }
    raw = admission["pairs_raw"]
    if not isinstance(raw, list) or not all(isinstance(item, dict) for item in raw):
        return unavailable_bot(bot, PAIRS_INVALID)
    quote = admission["quote"]
    normalized = [_pair(item, quote) for item in raw]
    if any(item is None for item in normalized):
        return unavailable_bot(bot, PAIRS_INVALID)
    pairs = [item[0] for item in normalized]
    invalid = any(item[1] for item in normalized)
    identities = [(p["controller_id"], p["pair"]) for p in pairs]
    duplicates = {key for key in identities if identities.count(key) > 1}
    incomplete: list[str] = [PAIR_FIELD_INVALID] if invalid else []
    if duplicates:
        # A repeated owner identity has no uniquely supported quantity.
        incomplete.append(PAIR_DUPLICATE)
        for p in pairs:
            if (p["controller_id"], p["pair"]) in duplicates:
                p.update(units=None, marked_value_quote=None, small=False)
    if any(p["units"] is None for p in pairs):
        incomplete.append(PAIR_QUANTITY_UNKNOWN)
    inventory_complete = not incomplete
    held = [p for p in pairs if p["units"] is not None and Decimal(p["units"]) > 0]
    values = [_dec(p["marked_value_quote"]) for p in held]
    if inventory_complete and any(v is None for v in values):
        incomplete.append(VALUE_UNKNOWN)
    value_complete = not incomplete
    totals = {
        "marked_value_quote": _out(_sum(values)) if value_complete else None,
        "known_marked_value_quote": _out(
            fleet_pnl.exact_sum([v for v in values if v is not None])
        ),
        "unrealized_pnl_quote": (
            _out(_sum([_dec(p["unrealized_pnl_quote"]) for p in held]))
            if inventory_complete
            else None
        ),
        "entry_cost_quote": (
            _out(_sum([_dec(p["entry_cost_quote"]) for p in held]))
            if inventory_complete
            else None
        ),
    }
    return {
        "bot": bot,
        "paper": is_paper(bot) or admission["simulated"],
        "state": admission["state"],
        "reason": None,
        "observed_at_ms": admission["observed_ms"],
        "stale_after_ms": STALE_AFTER_MS,
        "snapshot_id": admission["snapshot_id"],
        "owner_boot_id": admission["owner_boot_id"],
        "quote_asset": quote,
        "inventory_complete": inventory_complete,
        "value_complete": value_complete,
        "incomplete_reasons": incomplete,
        "registered_pair_count": len(pairs),
        "held_pair_count": len(held) if inventory_complete else None,
        "totals": totals,
        "pairs": pairs,
    }


def build_holdings(server: str, reads: dict[str, Any], now_ms: float) -> dict:
    """The route body. ``reads`` maps each registered bot to its quant-summary payload, or to a reason code."""
    return {
        "schema": SCHEMA_VERSION,
        "server": server,
        "generated_at_ms": int(now_ms),
        "bots": [
            (
                unavailable_bot(bot, read)
                if isinstance(read, str)
                else project_bot(read, bot, now_ms)
            )
            for bot, read in reads.items()
        ],
    }
