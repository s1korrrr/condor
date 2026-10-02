"""Fleet summary contract ``fleet-summary.v1``: one server-side computation of the fleet numbers.

The dashboard, the iPhone/Watch app and any push/summary text read this payload instead of
each re-deriving fleet PnL, wallet equity and the Market verdict. The document that clients
code against is ``docs/reference/fleet-summary-v1.md`` (in the rsibot workspace); this module
is its reference implementation.

Rules that make the payload trustworthy:

* a value exists only when a named source produced it. Otherwise the field is ``null`` (or the
  whole section is ``null``) and the reason is listed in ``missing`` with a reason code. No
  "Unavailable" strings, no zero standing in for unknown;
* every section carries its own ``observed_at_ms`` and ``stale`` flag in ``sections``;
* decimals that are money (PnL, equity, fees) are strings; scores are JSON numbers; times are
  epoch milliseconds, so a client computes ages itself and the body only changes when data does;
* storage is reused, never duplicated: performance and wallet history come from
  ``PerformanceHistory``, bot lifecycle from the bots status cache, the verdict from the stored
  Market Picture frame and history, per-bot owner counters from the registered reporting sources.

``build_fleet_summary`` is pure given its ``readers``; ``routes/fleet_summary.py`` wires the
live readers and HTTP.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional, Protocol

from condor.fetchers.bots import build_bots_page
from condor.web import fleet_pnl
from condor.web.market_verdict import (
    DEFAULT_HORIZON,
    frame_from_raw,
    history_from_items,
    market_verdict,
)

SCHEMA_VERSION = "fleet-summary.v1"
VIEWS = ("full", "glance")
RECENT_FILLS = {"full": 10, "glance": 3}
OWNER_FILL_LIMIT = 10

# Per-section staleness thresholds (ms). A section older than this is flagged ``stale`` in ``sections``.
STALE_AFTER_MS = {
    "wallet": 120_000,  # the wallet observer samples about once a minute
    "pnl": 180_000,  # native samples are <= 90s apart; a window is stale 90s after that
    "market": 90_000,  # the frame is minute-aligned; the Market page calls >90s old "lagging"
    "bots": 30_000,  # owner heartbeat currency, as the dashboard roster uses
    "fills": 120_000,
    "incidents": 90_000,
}
OWNER_CURRENT_MS = 30_000

# Reason codes (the contract document defines each).
SOURCE_UNAVAILABLE = "SOURCE_UNAVAILABLE"
NOT_CONFIGURED = "NOT_CONFIGURED"
FORBIDDEN = "FORBIDDEN"
NO_REGISTRY = "NO_REGISTRY"
REGISTRY_FROM_STATUS = "REGISTRY_FROM_STATUS"
NO_SAMPLES = fleet_pnl.NO_SAMPLES
FRAME_UNAVAILABLE = "FRAME_UNAVAILABLE"
NO_COMPONENTS = "NO_COMPONENTS"
HISTORY_UNAVAILABLE = "HISTORY_UNAVAILABLE"
OWNER_NOT_CURRENT = "OWNER_NOT_CURRENT"
INVALID = "INVALID"
PAPER_EXCLUDED = "PAPER_EXCLUDED"
PARTIAL_COVERAGE = "PARTIAL_COVERAGE"
FIELDS_MISSING = "FIELDS_MISSING"
GLANCE_MAX_BOTS = 16
GLANCE_MAX_MISSING = 16

V1_DISPLAY = {
    "ok_rsi": "V1 · ok_rsi",
    "ok_rsi_sui_sell_only": "SUI · Sell only",
    "rsi_v5": "RSI v5",
}
_PAPER = re.compile(r"(?:^|[_-])paper(?:[_-]|$)", re.IGNORECASE)
_GEN = {
    "V2": re.compile(r"(?:^|[_-])v2(?:[_-]|$)", re.IGNORECASE),
    "V3": re.compile(r"(?:^|[_-])v3(?:[_-]|$)", re.IGNORECASE),
}


def display_name(bot: str) -> str:
    """Same nicknames as ``displayBotName`` in the frontend (V1 nicknames stay; other ids show as themselves)."""
    return V1_DISPLAY.get(bot, bot)


def generation(bot: str) -> Optional[str]:
    """'V1' for the known V1 bots, 'V2'/'V3' when the id carries that token, otherwise ``None`` (never guessed)."""
    if bot in V1_DISPLAY:
        return "V1"
    for name, pattern in _GEN.items():
        if pattern.search(bot):
            return name
    return None


def is_paper(bot: str) -> bool:
    return bool(_PAPER.search(bot))


@dataclass
class OwnerRead:
    payload: Any = None
    reason: Optional[str] = None  # None when the read succeeded


@dataclass
class MarketRead:
    frame: Optional[dict] = None  # validated owner frame (wire shape)
    history: Optional[list] = None  # validated stored history rows
    reason: Optional[str] = None
    history_reason: Optional[str] = None


class Readers(Protocol):
    def registered_bots(self, server: str) -> Optional[list[str]]: ...
    async def bots_status(self, server: str) -> Any: ...
    def performance(self, server: str, bot: str, range_: str, now_s: float) -> dict: ...
    def wallet(self, server: str, bot: str, range_: str, now_s: float) -> dict: ...
    async def market(self, server: str, user_id: Any) -> MarketRead: ...
    async def owner(self, bot: str, path: str, params: dict) -> OwnerRead: ...


# ── small parsing helpers ──


def _instant_ms(value: Any) -> Optional[int]:
    """ISO-8601 with an explicit offset -> epoch ms. Naive stamps are ambiguous and rejected."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return int(round(parsed.astimezone(timezone.utc).timestamp() * 1000))


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    if isinstance(value, str) and not re.fullmatch(
        r"[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?", value, re.IGNORECASE
    ):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _nonneg_int(value: Any) -> Optional[int]:
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0
        else None
    )


def _dec(value: Any) -> Optional[Decimal]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        return None
    return number if number.is_finite() else None


def _obj(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


# ── owner projections (the subset of quant-roster.ts the fleet numbers need) ──


def project_quant_summary(payload: Any, bot: str, now_ms: float) -> Optional[dict]:
    """Admit only identity-bound native projections; mirrors ``projectQuantBotSummary`` admission rules."""
    envelope, scope, data = (
        _obj(payload),
        _obj(_obj(payload).get("scope")),
        _obj(_obj(payload).get("data")),
    )
    generated = _instant_ms(envelope.get("generated_at"))
    if (
        envelope.get("schema_version") != "rsibot.quant_ops.v1"
        or envelope.get("execution_authorized") is not False
        or scope.get("bot_key") != bot
        or data.get("bot_id") != bot
        or generated is None
        or generated > now_ms + 5_000
    ):
        return None
    mode = scope.get("execution_mode")
    observed_text = data.get("heartbeat") or _obj(envelope.get("source_times")).get(
        "runtime_status"
    )
    observed = _instant_ms(observed_text)
    current = (
        observed is not None
        and observed <= now_ms + 5_000
        and now_ms - observed < OWNER_CURRENT_MS
    )
    fresh = current and mode in ("live", "paper")
    state = (
        data.get("operational_label")
        if isinstance(data.get("operational_label"), str)
        and data.get("operational_label").strip()
        else "UNKNOWN"
    )
    admitted = fresh and state != "UNKNOWN"
    known = {} if fresh else _obj(data.get("last_known"))
    pairs_raw = data.get("pairs") if admitted else known.get("pairs")
    pairs = []
    for item in pairs_raw if isinstance(pairs_raw, list) else []:
        row = _obj(item)
        pair = row.get("pair")
        if isinstance(pair, str) and re.fullmatch(r"[A-Z0-9]+-[A-Z0-9]+", pair):
            units = _num(row.get("units"))
            pairs.append({"pair": pair, "held": units is not None and units > 0})
    counts = _obj(data.get("cycle_counts") if admitted else known.get("cycle_counts"))
    return {
        "observed_ms": (
            observed if observed is not None else _instant_ms(known.get("observed_at"))
        ),
        "current": current,
        "admitted": admitted,
        "pairs": pairs,
        "open_cycles": _nonneg_int(counts.get("open")),
    }


def project_quant_cycles(payload: Any, bot: str) -> Optional[dict]:
    """Scored cycles from the lifecycle projection; mirrors ``projectQuantCycles`` for the fields used here."""
    row = _obj(payload)
    if (
        row.get("bot_id") != bot
        or row.get("execution_authorized") is not False
        or row.get("source") != "executor_lifecycle"
        or not isinstance(row.get("cycles"), list)
    ):
        return None
    stats = _obj(row.get("statistics"))
    cycles = []
    for item in row["cycles"]:
        cycle = _obj(item)
        if (
            not isinstance(cycle.get("cycle_id"), str)
            or not cycle["cycle_id"]
            or not isinstance(cycle.get("outcome"), str)
            or not cycle["outcome"]
        ):
            continue
        cycles.append(
            {
                "first_ms": _instant_ms(cycle.get("first_fill_at"))
                or _instant_ms(cycle.get("opened_at")),
                "closed_ms": _instant_ms(cycle.get("closed_at")),
                "fill_count": _nonneg_int(cycle.get("fill_count")) or 0,
            }
        )
    counts = {
        k: v
        for k, v in _obj(row.get("cycle_counts")).items()
        if _nonneg_int(v) is not None
    }
    return {
        "quote": (
            row.get("quote_currency")
            if isinstance(row.get("quote_currency"), str)
            and row["quote_currency"].strip()
            else None
        ),
        "counts": counts,
        "cycles": cycles,
        "fill_count": _nonneg_int(stats.get("fill_count")),
        "fees": _dec(stats.get("fees_quote")),
    }


def project_fills(payload: Any, bot: str) -> list[dict]:
    """Native fills for one bot. Exact receipt strings are preferred over float projections."""
    rows = _obj(payload).get("rows")
    out = []
    for item in rows if isinstance(rows, list) else []:
        fill = _obj(item)
        fill_id = fill.get("fill_id")
        if not isinstance(fill_id, str) or not fill_id or fill.get("bot_name") != bot:
            continue

        def pick(*keys: str) -> Optional[str]:
            for key in keys:
                value = fill.get(key)
                if _dec(value) is not None:
                    return fleet_pnl.decimal_text(_dec(value))
            return None

        out.append(
            {
                "bot": bot,
                "fill_id": fill_id,
                "pair": fill.get("pair") if isinstance(fill.get("pair"), str) else None,
                "side": fill.get("side") if isinstance(fill.get("side"), str) else None,
                "amount": pick("exact_amount", "amount_base"),
                "price": pick("exact_price", "price_quote"),
                "volume": pick(
                    "value_quote_exact",
                    "gross_volume_quote_decimal",
                    "gross_volume_quote",
                ),
                "fee": pick("exact_trade_fee_in_quote", "fee_quote"),
                "time_ms": _instant_ms(fill.get("timestamp")),
            }
        )
    return out


def project_incidents(payload: Any, now_ms: float) -> Optional[dict]:
    """Open incident counts from the shared incident store (``sharedIncidentView`` rules, reduced)."""
    store = _obj(_obj(payload).get("incident_store"))
    monitor = _obj(store.get("monitor"))
    incidents = store.get("incidents")
    generated = _instant_ms(store.get("generated_at"))
    if (
        store.get("state") not in ("available", "unavailable")
        or generated is None
        or not isinstance(incidents, list)
        or len(incidents) > 2000
    ):
        return None
    rows = [_obj(i) for i in incidents]
    if any(
        r.get("state") not in ("open", "resolved")
        or r.get("severity") not in ("critical", "warning")
        for r in rows
    ):
        return None
    last_cycle = _instant_ms(monitor.get("last_cycle_at"))
    fresh = (
        store["state"] == "available"
        and last_cycle is not None
        and all(
            -5_000 <= now_ms - t <= STALE_AFTER_MS["incidents"]
            for t in (generated, last_cycle)
        )
    )
    open_rows = [r for r in rows if r["state"] == "open"]
    critical = sum(1 for r in open_rows if r["severity"] == "critical")
    if not fresh:
        state = "unknown"
    elif critical:
        state = "critical"
    elif open_rows or monitor.get("state") == "degraded":
        state = "degraded"
    else:
        state = "healthy"
    return {
        "state": state,
        "open": len(open_rows),
        "critical": critical,
        "warning": len(open_rows) - critical,
        "monitor": (
            monitor.get("state")
            if monitor.get("state") in ("healthy", "degraded")
            else None
        ),
        "generated_at_ms": generated,
        "observed_at_ms": generated,
    }


# ── assembly ──


def _section(
    status: str,
    observed: Optional[float],
    stale_after: Optional[int],
    reason: Optional[str] = None,
) -> dict:
    return {
        "status": status,
        "observed_at_ms": None if observed is None else int(round(observed)),
        "stale_after_ms": stale_after,
        "reason": reason,
    }


def _wallet_section(
    reads: dict[str, Optional[dict]], now_ms: float, missing: list
) -> tuple[Optional[dict], dict]:
    """Newest complete wallet valuation among the live bots' reporting wallet observers.

    ``reads`` maps each live bot to its wallet read, or ``None`` when the read itself failed.
    """
    best: Optional[tuple[float, str, dict]] = None
    for bot, payload in reads.items():
        if payload is None:
            continue
        latest = _obj(_obj(payload).get("latest"))
        stamp = _num(latest.get("timestamp"))
        value = _dec(latest.get("value_quote"))
        if (
            stamp is None
            or stamp <= 0
            or value is None
            or value < 0
            or not isinstance(latest.get("currency"), str)
            or not latest["currency"]
            or latest.get("valuation_complete") is not True
        ):
            continue
        if best is None or stamp > best[0]:
            best = (stamp, bot, latest)
    if best is None:
        reason = (
            NO_REGISTRY
            if not reads
            else (
                SOURCE_UNAVAILABLE
                if all(p is None for p in reads.values())
                else NO_SAMPLES
            )
        )
        missing.append({"section": "wallet", "reason": reason})
        return None, _section("missing", None, STALE_AFTER_MS["wallet"], reason)
    stamp, bot, latest = best
    observed = stamp * 1000
    stale = now_ms - observed > STALE_AFTER_MS["wallet"]
    wallet = {
        "equity": fleet_pnl.decimal_text(_dec(latest["value_quote"])),
        "unit": latest["currency"],
        "observed_at_ms": int(round(observed)),
        "source_bot": bot,
        "valuation_complete": True,
        "stale": stale,
    }
    return wallet, _section(
        "stale" if stale else "ok",
        observed,
        STALE_AFTER_MS["wallet"],
        OWNER_NOT_CURRENT if stale else None,
    )


def _freshness(frame: dict, now_ms: float) -> str:
    if now_ms < frame["available_at_ms"]:
        return "future"
    if now_ms >= frame["expires_at_ms"]:
        return "stale"
    return "lagging" if now_ms - frame["cutoff_ms"] > 90_000 else "fresh"


def _market_section(
    read: MarketRead, now_ms: float, missing: list
) -> tuple[Optional[dict], dict]:
    if read.frame is None:
        reason = read.reason or FRAME_UNAVAILABLE
        missing.append({"section": "market", "reason": reason})
        return None, _section("missing", None, STALE_AFTER_MS["market"], reason)
    frame = read.frame
    history = (
        history_from_items(read.history, frame["cutoff_ms"])
        if read.history is not None
        else None
    )
    verdict = market_verdict(frame_from_raw(frame), DEFAULT_HORIZON, history=history)
    if read.history is None:
        missing.append(
            {
                "section": "market",
                "field": "history",
                "reason": read.history_reason or HISTORY_UNAVAILABLE,
            }
        )
    if verdict is None:
        missing.append(
            {"section": "market", "field": "verdict", "reason": NO_COMPONENTS}
        )
        return None, _section(
            "missing", frame["cutoff_ms"], STALE_AFTER_MS["market"], NO_COMPONENTS
        )
    freshness = _freshness(frame, now_ms)
    market = {
        "verdict": verdict,
        "frame": {
            "snapshot_id": frame["snapshot_id"],
            "cutoff_ms": frame["cutoff_ms"],
            "available_at_ms": frame["available_at_ms"],
            "expires_at_ms": frame["expires_at_ms"],
            "source_kind": frame["source_kind"],
            "freshness": freshness,
        },
        "history_points": len(history) if history is not None else None,
    }
    status = (
        "ok"
        if freshness == "fresh" and history is not None
        else "stale" if freshness in ("stale", "future") else "partial"
    )
    reason = (
        None
        if status == "ok"
        else (
            HISTORY_UNAVAILABLE
            if freshness == "fresh"
            else "FRAME_" + freshness.upper()
        )
    )
    return market, _section(
        status, frame["cutoff_ms"], STALE_AFTER_MS["market"], reason
    )


def _controller_net(
    page: Optional[dict], bot: str
) -> Optional[tuple[Decimal, Optional[str]]]:
    """Controller-report net PnL: the sum over the bot's controllers, only when every controller reports a total.

    The unit is the common quote of the controllers' trading pairs, or ``None`` when it cannot be read.
    """
    rows = [c for c in (page or {}).get("controllers", []) if c.get("bot_name") == bot]
    if not rows:
        return None
    total = Decimal(0)
    quotes = set()
    for row in rows:
        value = _dec(row.get("global_pnl_quote"))
        if value is None:
            return None
        total += value
        pair = row.get("trading_pair")
        quotes.add(
            pair.split("-")[1]
            if isinstance(pair, str) and pair.count("-") == 1
            else None
        )
    return total, (quotes.pop() if len(quotes) == 1 else None)


def _bot_cards(
    bots: list[str],
    page: Optional[dict],
    quant: dict[str, Optional[dict]],
    owner_reasons: dict[tuple[str, str], str],
    cycles: dict[str, Optional[dict]],
    day: fleet_pnl.FleetWindow,
    latest_samples: dict[str, Optional[tuple[fleet_pnl.Sample, str]]],
    now_ms: float,
    missing: list,
) -> list[dict]:
    status_by_bot = {b.get("bot_name"): b for b in (page or {}).get("bots", [])}
    day_by_bot = {w.bot: w for w in day.bots}
    cards = []
    for bot in bots:
        gaps: list[dict] = []
        paper = is_paper(bot)

        def gap(field: str, reason: str, *, listed: bool = True) -> None:
            gaps.append({"field": field, "reason": reason})
            if listed:
                missing.append(
                    {"section": "bots", "bot": bot, "field": field, "reason": reason}
                )

        status = status_by_bot.get(bot)
        q, c = quant.get(bot), cycles.get(bot)
        summary_reason = owner_reasons.get((bot, "quant-summary"))
        cycles_reason = owner_reasons.get((bot, "quant-cycles"))
        if status is None:
            gap("status", SOURCE_UNAVAILABLE)

        positions = executors = None
        if q is not None and (q["pairs"] or q["admitted"]):
            positions = {
                "held": sum(1 for p in q["pairs"] if p["held"]),
                "registered": len(q["pairs"]),
                "current": q["admitted"],
            }
        else:
            gap(
                "positions",
                summary_reason or (OWNER_NOT_CURRENT if q is not None else INVALID),
            )
        open_cycles = c["counts"].get("open") if c is not None else None
        if open_cycles is None and q is not None:
            open_cycles = q["open_cycles"]
        if open_cycles is not None:
            executors = open_cycles
        else:
            gap("executors", cycles_reason or summary_reason or INVALID)

        report_at = None
        if q is not None and q["observed_ms"] is not None:
            report_at = q["observed_ms"]
        elif status and status.get("performance_received_at"):
            report_at = int(round(float(status["performance_received_at"]) * 1000))
        report_current = bool(q and q["current"]) or bool(
            status
            and status.get("performance_received_at")
            and status.get("performance_stale_after_seconds")
            and now_ms / 1000 - float(status["performance_received_at"])
            < float(status["performance_stale_after_seconds"])
        )
        if report_at is None:
            gap("report_at_ms", summary_reason or SOURCE_UNAVAILABLE)

        day_window = day_by_bot.get(bot)
        pnl_day = None
        if day_window is not None:
            pnl_day = {
                "change": fleet_pnl.decimal_text(day_window.change),
                "unit": day_window.quote,
                "partial": not day_window.full,
                "stale": day_window.stale,
            }
        elif paper:
            gap("pnl_day", PAPER_EXCLUDED, listed=False)
        else:
            gap(
                "pnl_day",
                next(
                    (m["reason"] for m in day.missing if m["bot"] == bot),
                    fleet_pnl.NOT_READ,
                ),
            )

        net_now = None
        live = _controller_net(page, bot)
        sample = latest_samples.get(bot)
        if live is not None:
            unit = (
                live[1]
                or (day_window.quote if day_window else None)
                or (sample[1] if sample else None)
            )
            if unit:
                net_now = {
                    "value": fleet_pnl.decimal_text(live[0]),
                    "unit": unit,
                    "source": "controller",
                }
        if (
            net_now is None
            and sample is not None
            and now_ms - sample[0].time <= 300_000
        ):
            net_now = {
                "value": fleet_pnl.decimal_text(sample[0].total),
                "unit": sample[1],
                "source": "history",
            }
        if net_now is None:
            gap(
                "net_now",
                PAPER_EXCLUDED if paper else fleet_pnl.NO_SAMPLES,
                listed=not paper,
            )

        fees = trades = None
        if c is not None:
            if c["fees"] is not None and c["quote"]:
                fees = {"amount": fleet_pnl.decimal_text(c["fees"]), "unit": c["quote"]}
            else:
                gap("fees", INVALID)
            since = now_ms - 86_400_000
            lifetime = c["fill_count"]
            if lifetime is None and c["cycles"]:
                lifetime = sum(row["fill_count"] for row in c["cycles"])
            trades = {
                "lifetime": lifetime,
                "opened_24h": sum(
                    1
                    for row in c["cycles"]
                    if row["first_ms"] is not None
                    and since <= row["first_ms"] <= now_ms + 5_000
                ),
                "closed_24h": sum(
                    1
                    for row in c["cycles"]
                    if row["closed_ms"] is not None
                    and since <= row["closed_ms"] <= now_ms + 5_000
                ),
            }
        else:
            gap("fees", cycles_reason or INVALID)
            gap("trades", cycles_reason or INVALID)

        cards.append(
            {
                "bot": bot,
                "display_name": display_name(bot),
                "generation": generation(bot),
                "paper": paper,
                "status": status.get("status") if status else None,
                "controllers": status.get("num_controllers") if status else None,
                "report_at_ms": report_at,
                "report_stale": not report_current,
                "positions": positions,
                "executors": executors,
                "executors_basis": (
                    "open_lifecycle_cycles" if executors is not None else None
                ),
                "pnl_day": pnl_day,
                "net_now": net_now,
                "fees": fees,
                "trades": trades,
                "missing": gaps,
            }
        )
    return cards


async def _safe_owner(readers: Readers, bot: str, path: str, params: dict) -> OwnerRead:
    try:
        return await readers.owner(bot, path, params)
    except Exception:
        return OwnerRead(None, SOURCE_UNAVAILABLE)


def _sync_reads(
    readers: Readers, server: str, live: list[str], now_ms: float
) -> tuple[dict[str, list[fleet_pnl.BotHistory]], dict[str, Optional[dict]]]:
    clock = now_ms + 5_000
    histories: dict[str, list[fleet_pnl.BotHistory]] = {
        r: [] for r in ("1D", "1W", "1M", "ALL")
    }
    wallets: dict[str, Optional[dict]] = {}
    for bot in live:
        for range_ in histories:
            try:
                payload, failed = (
                    readers.performance(server, bot, range_, now_ms / 1000),
                    False,
                )
            except Exception:
                payload, failed = None, True
            histories[range_].append(
                fleet_pnl.parse_bot_history(payload, bot, range_, clock, failed)
            )
        try:
            wallets[bot] = readers.wallet(server, bot, "1D", now_ms / 1000)
        except Exception:
            wallets[bot] = None
    return histories, wallets


async def build_fleet_summary(
    server: str,
    view: str,
    readers: Readers,
    now_ms: float,
    *,
    is_admin: bool,
    user_id: Any = None,
) -> dict:
    """Compute the whole payload. ``view='glance'`` is the compact projection of the same computation."""
    if view not in VIEWS:
        raise ValueError(f"unknown view {view!r}")
    missing: list[dict] = []
    sections: dict[str, dict] = {}

    status_raw = await readers.bots_status(server)
    page = build_bots_page(status_raw) if status_raw is not None else None
    status_names = [
        b["bot_name"] for b in (page or {}).get("bots", []) if b.get("bot_name")
    ]
    registry = readers.registered_bots(server)
    if registry:
        bots = list(dict.fromkeys(registry))
    elif status_names:
        bots = list(dict.fromkeys(status_names))
        missing.append({"section": "bots", "reason": REGISTRY_FROM_STATUS})
    else:
        bots = []
    live = [b for b in bots if not is_paper(b)]
    if page is None:
        missing.append(
            {"section": "bots", "field": "status", "reason": SOURCE_UNAVAILABLE}
        )

    # Independent reads run together; each fails into its own reason code.
    owner_jobs: list[tuple[str, str, dict]] = [
        (bot, path, {}) for bot in bots for path in ("quant-summary", "quant-cycles")
    ]
    owner_jobs += [(bot, "fills", {"limit": str(OWNER_FILL_LIMIT)}) for bot in live]
    incident_bot = live[0] if live else None
    if is_admin and incident_bot:
        owner_jobs.append((incident_bot, "operations", {}))
    sync_task = asyncio.to_thread(_sync_reads, readers, server, live, now_ms)
    market_task = readers.market(server, user_id)
    results = await asyncio.gather(
        sync_task,
        market_task,
        *[_safe_owner(readers, bot, path, params) for bot, path, params in owner_jobs],
        return_exceptions=True,
    )
    sync_result, market_result, owner_results = results[0], results[1], results[2:]
    if isinstance(sync_result, BaseException):
        histories, wallets = {r: [] for r in ("1D", "1W", "1M", "ALL")}, {}
    else:
        histories, wallets = sync_result
    market_read = (
        market_result
        if isinstance(market_result, MarketRead)
        else MarketRead(reason=SOURCE_UNAVAILABLE)
    )
    owner: dict[tuple[str, str], OwnerRead] = {}
    for (bot, path, _), result in zip(owner_jobs, owner_results):
        owner[(bot, path)] = (
            result
            if isinstance(result, OwnerRead)
            else OwnerRead(None, SOURCE_UNAVAILABLE)
        )

    # wallet
    wallet, sections["wallet"] = _wallet_section(wallets, now_ms, missing)

    # fleet PnL
    windows = fleet_pnl.compute_windows(histories, live, now_ms) if live else {}
    pnl: Optional[dict] = None
    if windows:
        detail = view == "full"
        pnl = {"unit": next((w.quote for w in windows.values() if w.quote), None)}
        pnl.update(
            {
                name: fleet_pnl.window_payload(
                    window, span_ms=fleet_pnl.WINDOW_SPAN_MS.get(name), detail=detail
                )
                for name, window in windows.items()
            }
        )
        usable = [w for w in windows.values() if w.total is not None]
        latest = max(
            (w.latest_at for w in usable if w.latest_at is not None), default=None
        )
        if not usable:
            reason = next(
                (m["reason"] for w in windows.values() for m in w.missing), NO_SAMPLES
            )
            sections["pnl"] = _section("missing", None, STALE_AFTER_MS["pnl"], reason)
            missing.append({"section": "pnl", "reason": reason})
        else:
            day = windows["day"]
            if day.total is None:
                missing.append(
                    {
                        "section": "pnl",
                        "field": "day",
                        "reason": next((m["reason"] for m in day.missing), NO_SAMPLES),
                    }
                )
            stale = latest is None or now_ms - latest > STALE_AFTER_MS["pnl"]
            incomplete = any(
                w.counted < w.expected or w.partial for w in usable
            ) or len(usable) < len(windows)
            for name, window in windows.items():
                for item in window.missing:
                    missing.append(
                        {
                            "section": "pnl",
                            "field": name,
                            "bot": item["bot"],
                            "reason": item["reason"],
                        }
                    )
            sections["pnl"] = _section(
                "stale" if stale else "partial" if incomplete else "ok",
                latest,
                STALE_AFTER_MS["pnl"],
                (
                    OWNER_NOT_CURRENT
                    if stale
                    else PARTIAL_COVERAGE if incomplete else None
                ),
            )
    else:
        sections["pnl"] = _section("missing", None, STALE_AFTER_MS["pnl"], NO_REGISTRY)
        missing.append({"section": "pnl", "reason": NO_REGISTRY})

    # market
    market, sections["market"] = _market_section(market_read, now_ms, missing)

    # bots
    quant = {
        bot: project_quant_summary(owner[(bot, "quant-summary")].payload, bot, now_ms)
        for bot in bots
    }
    cycles = {
        bot: project_quant_cycles(owner[(bot, "quant-cycles")].payload, bot)
        for bot in bots
    }
    owner_reasons: dict[tuple[str, str], str] = {}
    projections = {"quant-summary": quant, "quant-cycles": cycles}
    for (bot, path), read in owner.items():
        if path in projections and (read.reason or projections[path].get(bot) is None):
            owner_reasons[(bot, path)] = read.reason or INVALID
    latest_samples: dict[str, Optional[tuple[fleet_pnl.Sample, str]]] = {}
    for history in histories.get("1D", []):
        latest_samples[history.bot] = (
            (history.samples[-1], history.quote or "")
            if history.samples and history.quote
            else None
        )
    day_window = windows.get("day") or fleet_pnl.fleet_window([], [], 0, 0, 0)
    cards = (
        _bot_cards(
            bots,
            page,
            quant,
            owner_reasons,
            cycles,
            day_window,
            latest_samples,
            now_ms,
            missing,
        )
        if bots
        else []
    )
    if not bots:
        missing.append({"section": "bots", "reason": NO_REGISTRY})
        sections["bots"] = _section(
            "missing", None, STALE_AFTER_MS["bots"], NO_REGISTRY
        )
    else:
        observed = [c["report_at_ms"] for c in cards if c["report_at_ms"] is not None]
        any_stale = any(c["report_stale"] for c in cards if not c["paper"])
        incomplete = any(c["missing"] for c in cards) or page is None
        sections["bots"] = _section(
            "stale" if any_stale else "partial" if incomplete else "ok",
            max(observed) if observed else None,
            STALE_AFTER_MS["bots"],
            OWNER_NOT_CURRENT if any_stale else FIELDS_MISSING if incomplete else None,
        )

    # fills
    fills: Optional[list[dict]] = None
    merged: list[dict] = []
    fill_reads = [(bot, owner[(bot, "fills")]) for bot in live]
    for bot, read in fill_reads:
        if read.payload is None:
            missing.append(
                {
                    "section": "fills",
                    "bot": bot,
                    "reason": read.reason or SOURCE_UNAVAILABLE,
                }
            )
        else:
            merged.extend(project_fills(read.payload, bot))
    if fill_reads and any(read.payload is not None for _, read in fill_reads):
        merged.sort(
            key=lambda f: (f["time_ms"] is not None, f["time_ms"] or 0), reverse=True
        )
        fills = merged[: RECENT_FILLS[view]]
        times = [f["time_ms"] for f in merged if f["time_ms"] is not None]
        partial = any(read.payload is None for _, read in fill_reads)
        sections["fills"] = _section(
            "partial" if partial else "ok",
            max(times) if times else None,
            STALE_AFTER_MS["fills"],
            PARTIAL_COVERAGE if partial else None,
        )
    else:
        reason = (
            fill_reads[0][1].reason
            if fill_reads and fill_reads[0][1].reason
            else (NOT_CONFIGURED if live else NO_REGISTRY)
        )
        sections["fills"] = _section("missing", None, STALE_AFTER_MS["fills"], reason)
        missing.append({"section": "fills", "reason": reason})

    # incidents
    incidents = None
    if not is_admin:
        sections["incidents"] = _section(
            "missing", None, STALE_AFTER_MS["incidents"], FORBIDDEN
        )
        missing.append({"section": "incidents", "reason": FORBIDDEN})
    elif incident_bot is None:
        sections["incidents"] = _section(
            "missing", None, STALE_AFTER_MS["incidents"], NO_REGISTRY
        )
        missing.append({"section": "incidents", "reason": NO_REGISTRY})
    else:
        read = owner[(incident_bot, "operations")]
        incidents = (
            project_incidents(read.payload, now_ms)
            if read.payload is not None
            else None
        )
        if incidents is None:
            reason = read.reason or INVALID
            sections["incidents"] = _section(
                "missing", None, STALE_AFTER_MS["incidents"], reason
            )
            missing.append({"section": "incidents", "reason": reason})
        else:
            stale = incidents["state"] == "unknown"
            sections["incidents"] = _section(
                "stale" if stale else "ok",
                incidents["generated_at_ms"],
                STALE_AFTER_MS["incidents"],
                OWNER_NOT_CURRENT if stale else None,
            )

    body: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "view": view,
        "server": server,
        "generated_at_ms": int(now_ms),
        "sections": sections,
        "missing": missing,
        "wallet": wallet,
        "pnl": pnl,
        "market": market,
        "bots": cards,
        "fills": fills,
        "incidents": incidents,
    }
    return glance(body) if view == "glance" else body


def glance(full: dict) -> dict:
    """Compact projection for the Watch: headline numbers only, reason codes without detail. Target < 8 KB."""
    pnl = full["pnl"]
    market = full["market"]
    verdict = market["verdict"] if market else None
    return {
        "schema_version": full["schema_version"],
        "view": "glance",
        "server": full["server"],
        "generated_at_ms": full["generated_at_ms"],
        "sections": full["sections"],
        "missing": [
            {
                k: v
                for k, v in item.items()
                if k in ("section", "field", "bot", "reason")
            }
            for item in full["missing"]
        ][:GLANCE_MAX_MISSING],
        "missing_total": len(full["missing"]),
        "wallet": full["wallet"],
        "pnl": (
            None
            if pnl is None
            else {
                "unit": pnl["unit"],
                **{
                    name: {
                        k: pnl[name][k]
                        for k in ("total", "partial", "counted", "expected", "stale")
                    }
                    for name in ("day", "week", "month", "all")
                },
            }
        ),
        "market": (
            None
            if market is None
            else {
                "state": verdict["state"],
                "label": verdict["label"],
                "score": verdict["score"],
                "horizon_label": verdict["horizon_label"],
                "held": verdict["held"],
                "freshness": market["frame"]["freshness"],
                "cutoff_ms": market["frame"]["cutoff_ms"],
            }
        ),
        "bots": [
            {
                "bot": c["bot"],
                "display_name": c["display_name"],
                "generation": c["generation"],
                "paper": c["paper"],
                "status": c["status"],
                "report_stale": c["report_stale"],
                "pnl_day": None if c["pnl_day"] is None else c["pnl_day"]["change"],
            }
            for c in full["bots"][:GLANCE_MAX_BOTS]
        ],
        "bots_total": len(full["bots"]),
        "fills": (
            None
            if full["fills"] is None
            else [
                {k: f[k] for k in ("bot", "pair", "side", "volume", "time_ms")}
                for f in full["fills"]
            ]
        ),
        "incidents": (
            None
            if full["incidents"] is None
            else {k: full["incidents"][k] for k in ("state", "open", "critical")}
        ),
    }


def canonical_json(body: dict) -> bytes:
    return json.dumps(
        body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode()


def etag_for(body: dict) -> str:
    """Strong validator over the body without its generation clock, so an unchanged fleet keeps its tag."""
    stable = {k: v for k, v in body.items() if k != "generated_at_ms"}
    return '"' + hashlib.sha256(canonical_json(stable)).hexdigest() + '"'
