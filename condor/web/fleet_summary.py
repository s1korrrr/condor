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
* storage is reused, never duplicated: performance history comes from
  ``PerformanceHistory``, account valuation from the native portfolio reader, bot lifecycle from the bots status cache, the verdict from the stored
  Market Picture frame and history, per-bot owner counters from the registered reporting sources.

``build_fleet_summary`` is pure given its ``readers``; ``routes/fleet_summary.py`` wires the
live readers and HTTP.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import math
import re
import time
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Optional, Protocol

from condor import trading_words
from condor.fetchers.bots import build_bots_page
from condor.fleet_identity import display_name, generation, is_paper
from condor.web import fleet_pnl, holdings
from condor.web.market_verdict import (
    DEFAULT_HORIZON,
    frame_from_raw,
    history_from_items,
    market_verdict,
)

SCHEMA_VERSION = "fleet-summary.v1"
VIEWS = ("full", "glance")
RECENT_FILLS = {"full": 10, "glance": 3}
# One fill-ledger read per bot feeds both the recent-fills list and the lifetime totals for a bot that
# publishes no scored cycles. Same page size the Bots page reads. A ledger this long is a lower bound.
OWNER_FILL_LIMIT = 500
RUNTIME_STALE_CAP_S = 30  # the dashboard calls an owner observation older than min(threshold, 30)s stale

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
INCIDENT_DETAIL_LIMIT = 20

class PhaseRecorder(Protocol):
    def phase_started(self, name: str, started: float) -> int: ...

    def phase_finished(self, token: int, outcome: str, elapsed: float) -> None: ...


_phase_recorder: contextvars.ContextVar[PhaseRecorder | None] = contextvars.ContextVar(
    "fleet_summary_phase_recorder", default=None
)


@contextmanager
def capture_phase_recorder(recorder: PhaseRecorder):
    """Install a request-local phase recorder for summary work and nested readers."""
    token = _phase_recorder.set(recorder)
    try:
        yield
    finally:
        _phase_recorder.reset(token)


@asynccontextmanager
async def phase_span(name: str):
    """Record elapsed time and cancellation for one fixed, non-sensitive phase name."""
    recorder = _phase_recorder.get()
    if recorder is None:
        yield {"outcome": "complete"}
        return
    started = time.monotonic()
    token = recorder.phase_started(name, started)
    result = {"outcome": "complete"}
    try:
        yield result
    except asyncio.CancelledError:
        recorder.phase_finished(token, "cancelled", time.monotonic() - started)
        raise
    except BaseException:
        recorder.phase_finished(token, "error", time.monotonic() - started)
        raise
    else:
        recorder.phase_finished(token, result["outcome"], time.monotonic() - started)


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


class LastKnown:
    """Last good observations a later build may stand on when its own read fails.

    Process memory only, owned by the caller (the route keeps one per process). A held value keeps its
    own observation time, so clients age it exactly as they age a fresh one; it is never renewed.

    * wallet: the last valid account valuation per server, used only when the account read failed
      (``SOURCE_UNAVAILABLE``) and only while its own age is within the wallet ``stale_after_ms``.
      Denied, unconfigured or invalid answers are real answers and are never masked.
    * trading: the last valid capability per (server, bot), used when the owner runtime read failed or
      was rejected, for at most ``TRADING_HOLD_MS`` after its own observation, both sides ``unverified``.
    """

    def __init__(self) -> None:
        self.wallet: dict[str, Any] = {}
        self.trading: dict[tuple[str, str], dict] = {}


class Readers(Protocol):
    def registered_bots(self, server: str) -> Optional[list[str]]: ...
    async def bots_status(self, server: str) -> Any: ...
    def performance(self, server: str, bot: str, range_: str, now_s: float) -> dict: ...
    async def account(self, server: str, user_id: Any) -> OwnerRead: ...
    async def market(self, server: str, user_id: Any) -> MarketRead: ...
    async def owner(self, bot: str, path: str, params: dict) -> OwnerRead: ...


# ── small parsing helpers ──


def _instant_ms(value: Any, now_ms: Optional[float] = None) -> Optional[int]:
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
    return (
        instant
        if instant >= 0 and (now_ms is None or instant <= now_ms + 5_000)
        else None
    )


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    if isinstance(value, str) and not re.fullmatch(
        r"[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?", value, re.IGNORECASE
    ):
        return None
    try:
        number = float(value)
    except (OverflowError, ValueError):
        return None
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
    if not isinstance(value, (str, int, float, Decimal)):
        return None
    if isinstance(value, int) and value.bit_length() > 1024:
        return None
    return fleet_pnl._amount(str(value))


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
    # The owner's explicit coverage verdict admits the source (a unified multi-pair controller publishes no per-pair
    # state, so its label stays UNKNOWN while its inventory is verified). Envelopes without coverage keep the label rule.
    coverage = envelope.get("coverage")
    if isinstance(coverage, dict):
        ready = _nonneg_int(coverage.get("ready"))
        reasons = coverage.get("reasons")
        owner_admitted = (ready or 0) > 0 and isinstance(reasons, list) and not reasons
    else:
        owner_admitted = state != "UNKNOWN"
    admitted = fresh and owner_admitted
    known = {} if fresh else _obj(data.get("last_known"))
    counts = _obj(data.get("cycle_counts") if admitted else known.get("cycle_counts"))
    return {
        "observed_ms": (
            observed if observed is not None else _instant_ms(known.get("observed_at"))
        ),
        "current": current,
        "admitted": admitted,
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
            row["quote_currency"].strip()
            if isinstance(row.get("quote_currency"), str)
            and row["quote_currency"].strip()
            and row["quote_currency"].strip().lower() != "unknown"
            else None
        ),
        "counts": counts,
        "cycles": cycles,
        "fill_count": _nonneg_int(stats.get("fill_count")),
        "fees": _dec(stats.get("fees_quote")),
    }


# Reporting's per-field receipt verdict (`receipt_precision`) and the keys it applies to.
RECEIPT_KEYS = {
    "amount": ("exact_amount", "amount_base"),
    "price": ("exact_price", "price_quote"),
    "fee_quote": ("exact_trade_fee_in_quote", "fee_quote"),
}


def receipt_value(fill: dict, field: str, *, positive: bool) -> tuple[Optional[str], str]:
    """``(decimal text, precision)`` for one receipt field, keeping the owner's admission verdict.

    The owner keeps raw ``exact_*`` strings for provenance even when it refuses them (unverified receipt
    source); only its verdict decides. Without a verdict (an older reporting image) only the normalized
    6-decimal value is used and the exact strings are not promoted.
    """
    exact_key, normalized_key = RECEIPT_KEYS[field]
    verdicts = fill.get("receipt_precision")
    verdict = verdicts.get(field) if isinstance(verdicts, dict) else None
    if verdict == "unavailable":
        return None, "unavailable"
    key = exact_key if verdict == "exact_decimal" else normalized_key
    number = _dec(fill.get(key))
    if number is None or (positive and number <= 0):
        return None, "unavailable"
    return fleet_pnl.decimal_text(number), "exact" if verdict == "exact_decimal" else "legacy_6dp"


def execution_time_fields(fill: dict, now_ms: Optional[float] = None, *, paper: bool = False) -> dict:
    """Preserve an attested execution clock separately from the existing recorded clock."""
    executed = fill.get("execution_timestamp_ms")
    recorded = _instant_ms(fill.get("timestamp"), now_ms)
    admitted = (
        not paper
        and fill.get("execution_timestamp_source") == "okx.fillTime"
        and fill.get("connector_name") == "okx"
        and fill.get("simulated") is not True
        and fill.get("execution_mode") != "paper"
        and type(executed) is int
        and 0 < executed <= 253402300799999
        and recorded is not None and recorded > 0
        and executed <= recorded + 5000
        and (now_ms is None or executed <= now_ms + 5000)
    )
    return {
        "execution_timestamp_ms": executed if admitted else None,
        "execution_timestamp_source": "okx.fillTime" if admitted else None,
    }


def project_fills(payload: Any, bot: str, now_ms: Optional[float] = None) -> list[dict]:
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
                if value is None:
                    continue
                number = _dec(value)
                return fleet_pnl.decimal_text(number) if number is not None else None
            return None

        out.append(
            {
                "bot": bot,
                "fill_id": fill_id,
                "pair": fill.get("pair") if isinstance(fill.get("pair"), str) else None,
                "side": fill.get("side") if isinstance(fill.get("side"), str) else None,
                "amount": receipt_value(fill, "amount", positive=True)[0],
                "price": receipt_value(fill, "price", positive=True)[0],
                "volume": pick(
                    "value_quote_exact",
                    "gross_volume_quote_decimal",
                    "gross_volume_quote",
                ),
                "fee": receipt_value(fill, "fee_quote", positive=False)[0],
                "time_ms": _instant_ms(fill.get("timestamp"), now_ms),
                **execution_time_fields(fill, now_ms, paper=is_paper(bot)),
            }
        )
    return out


def _rows(value: Any) -> Optional[list[dict]]:
    return [_obj(item) for item in value] if isinstance(value, list) else None


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() and value != "n/a" else None


def _nonneg_dec(value: Any) -> Optional[Decimal]:
    number = _dec(value)
    return number if number is not None and number >= 0 else None


TRADING_STATES = ("can_trade", "restricted", "blocked", "unverified")
TRADING_SIDES = ("buy", "sell", "both")
TRADING_MAX_RESTRICTIONS = 20
# A failed owner read may stand on the last good capability this long (the same 5-minute bound as the
# ``net_now`` history fallback). It is shown as last known: both sides ``unverified``, own ``observed_ms``.
TRADING_HOLD_MS = 300_000
PAIR_RE = re.compile(r"[A-Z0-9]+-[A-Z0-9]+")
REASON_CODE_RE = re.compile(r"[a-z0-9_]{1,64}")
SOURCE_RE = re.compile(r"[a-z][a-z0-9_]{0,39}")


def _controller_id(value: Any) -> Optional[str]:
    """An owner controller identity: printable, at most 100 characters, else ``None``."""
    if not isinstance(value, str) or not value.strip() or len(value) > 100:
        return None
    return value if value.isprintable() else None


def project_trading(value: Any, current: bool) -> Optional[dict]:
    """The reporting owner's per-pair, per-side trading capability, re-validated and bounded.

    ``None`` when the owner published none (older reporting, paper twins) or its shape is wrong. An
    observation that is no longer current keeps its restrictions as last known, but neither side may
    read as able to trade: both become ``unverified``.
    """
    root = _obj(value)
    if root.get("schema_version") != 1 or root.get("buy") not in TRADING_STATES or root.get("sell") not in TRADING_STATES:
        return None
    raw = root.get("restrictions")
    if not isinstance(raw, list) or len(raw) > 500:
        return None
    rows = []
    for item in raw:
        item = _obj(item)
        pair = item.get("pair")
        code = item.get("reason_code")
        if (
            item.get("side") not in TRADING_SIDES
            or item.get("state") not in ("restricted", "blocked")
            or not (pair is None or (isinstance(pair, str) and re.fullmatch(r"[A-Z0-9]+-[A-Z0-9]+", pair)))
            or not (isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,64}", code))
            or type(item.get("alert")) is not bool
        ):
            return None
        detail = item.get("detail")
        source = item.get("source")
        subject, why = trading_words.describe(item["side"], pair, code)
        rows.append(
            {
                "subject": subject,
                "why": why,
                "pair": pair,
                "side": item["side"],
                "state": item["state"],
                "reason_code": code,
                "since_ms": _instant_ms(item.get("since")),
                "detail": detail[:200] if isinstance(detail, str) else None,
                "alert": item["alert"],
                # Join keys to the host incident of the same fault (incident ``bot`` + ``subject``).
                "controller_id": _controller_id(item.get("controller_id")),
                "source": (
                    source
                    if isinstance(source, str) and SOURCE_RE.fullmatch(source)
                    else None
                ),
            }
        )
    # Alerting restrictions first, so the bound never hides a real inability behind a policy note.
    rows.sort(key=lambda r: (not r["alert"], r["state"] != "blocked"))
    fresh = current and root.get("evidence") == "fresh"
    return {
        "buy": root["buy"] if fresh else "unverified",
        "sell": root["sell"] if fresh else "unverified",
        "coverage": "partial" if root.get("coverage") != "complete" else "complete",
        "restrictions": rows[:TRADING_MAX_RESTRICTIONS],
        "restrictions_total": len(rows),
        "observed_ms": _instant_ms(root.get("observed_at")),
        "held": False,
        "reason": None,
    }


def held_trading(trading: dict, reason: str) -> dict:
    """The last good capability standing in for a failed read: last known, never able to trade."""
    return {
        **trading,
        "buy": "unverified",
        "sell": "unverified",
        "held": True,
        "reason": reason,
    }


def trading_word(trading: dict) -> str:
    """One word for the glance: ``blocked``/``restricted`` only for a real inability (an alerting
    restriction), else ``unverified`` when a side cannot be confirmed, else ``ok``. A policy limit
    such as sell-only mode is not an inability and stays ``ok`` here."""
    alerting = [row for row in trading["restrictions"] if row.get("alert")]
    if any(row.get("state") == "blocked" for row in alerting):
        return "blocked"
    if alerting:
        return "restricted"
    if "unverified" in (trading["buy"], trading["sell"]):
        return "unverified"
    return "ok"


def project_runtime_view(payload: Any, bot: str, now_ms: float) -> Optional[dict]:
    """The owner's own runtime observation (``bootstrap``): active executors and trading capability.

    Only an identity-bound, well-formed observation is admitted (``None`` otherwise). An old one is returned
    with ``current: False``: staleness is a state, corruption is not. Inventory is not read here; it comes
    from the one holdings projection (``condor.web.holdings``).
    """
    root = _obj(payload)
    runtime, monitoring = _obj(root.get("runtime_status")), _obj(root.get("monitoring"))
    observed = _instant_ms(runtime.get("updated_at"))
    threshold = _num(monitoring.get("stale_threshold_seconds"))
    if (
        runtime.get("bot_name") != bot
        or monitoring.get("bot_name") != bot
        or observed is None
        or threshold is None
        or threshold <= 0
        or observed > now_ms + 5_000
    ):
        return None
    controllers = _rows(runtime.get("controllers"))
    active = _rows(runtime.get("active_executors"))
    lifecycle = (
        active
        if "lifecycle_executors" not in runtime
        else _rows(runtime["lifecycle_executors"])
    )
    if controllers is None or active is None or lifecycle is None:
        return None
    if any(
        not any(
            row.get("executor_id") == a.get("executor_id")
            and row.get("pair") == a.get("pair")
            and row.get("controller_id") == a.get("controller_id")
            for row in lifecycle
        )
        for a in active
    ):
        return None
    idents = [i for i in (_text(row.get("controller_id")) for row in controllers) if i]
    if len(set(idents)) != len(idents):
        scoped = {(row.get("controller_id"), row.get("pair")) for row in controllers}
        if len(scoped) != len(controllers) or not all(
            row.get("pair_projection_source") == "native_owner_symbols"
            and _text(row.get("controller_id"))
            and isinstance(row.get("pair"), str)
            and re.fullmatch(r"[A-Z0-9]+-[A-Z0-9]+", row["pair"])
            for row in controllers
        ):
            return None
    if any(
        not isinstance(row.get("pair"), str)
        or not re.fullmatch(r"[A-Z0-9]+-[A-Z0-9]+", row["pair"])
        for row in controllers
    ):
        return None
    current = now_ms - observed < min(threshold, RUNTIME_STALE_CAP_S) * 1000
    return {
        "observed_ms": observed,
        "current": current,
        "trading": project_trading(runtime.get("trading_capability"), current),
        "executors": len(active),
    }


def project_fill_totals(payload: Any, bot: str, limit: int) -> Optional[dict]:
    """Lifetime counters from the owner's fill ledger, for a bot whose reporting publishes no scored cycles.

    Fees stay ``None`` when any row lacks one. A ledger as long as the page limit is only a lower bound, so it
    is flagged ``saturated`` and never presented as a lifetime total.
    """
    rows = project_fills(payload, bot)
    if not rows:
        return None
    raw = _obj(payload).get("rows")
    quotes = {
        row["pair"].split("-")[1]
        for row in rows
        if isinstance(row["pair"], str) and row["pair"].count("-") == 1
    }
    fees = [_dec(row["fee"]) for row in rows]
    return {
        "count": len(rows),
        "fees": None if any(f is None for f in fees) else fleet_pnl.exact_sum(fees),
        "quote": quotes.pop() if len(quotes) == 1 else None,
        "saturated": isinstance(raw, list) and len(raw) >= limit,
    }


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
    detail_rows: list[dict] = []
    incomplete_detail = False
    seen_ids: set[str] = set()
    for row in rows:
        item, valid, clipped = _project_incident_item(row, now_ms)
        if not valid or item is None or item["id"] in seen_ids:
            incomplete_detail = True
            continue
        incomplete_detail = incomplete_detail or clipped
        seen_ids.add(item["id"])
        detail_rows.append(item)

    def detail_order(item: dict) -> tuple[int, int, int, str]:
        is_open = item["state"] == "open"
        if is_open:
            latest = item["last_seen_at_ms"]
            if latest is None:
                latest = item["first_seen_at_ms"]
        else:
            latest = item["resolved_at_ms"]
            if latest is None:
                latest = item["last_seen_at_ms"]
        return (
            0 if is_open else 1,
            0 if is_open and item["severity"] == "critical" else 1,
            -(latest or 0),
            item["id"],
        )

    detail_rows.sort(key=detail_order)
    items_truncated = incomplete_detail or len(detail_rows) > INCIDENT_DETAIL_LIMIT
    detail_rows = detail_rows[:INCIDENT_DETAIL_LIMIT]
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
        "items": detail_rows,
        "items_truncated": items_truncated,
    }


def _incident_text(value: Any, limit: int) -> tuple[Optional[str], bool, bool]:
    """Return bounded printable owner text, validity, and whether it was clipped."""
    if value is None:
        return None, True, False
    if not isinstance(value, str):
        return None, False, False
    cleaned = " ".join(
        "".join(char if char.isprintable() else " " for char in value).split()
    )
    if not cleaned:
        return None, True, False
    if len(cleaned) > limit:
        return cleaned[: limit - 1].rstrip() + "…", True, True
    return cleaned, True, False


def _project_incident_item(
    row: dict, now_ms: float
) -> tuple[Optional[dict], bool, bool]:
    """Bound one detail row; counts remain authoritative even when details are partial."""
    incident_id, id_valid, id_clipped = _incident_text(row.get("id"), 120)
    if (
        incident_id is None
        or not id_valid
        or id_clipped
        or incident_id != row.get("id")
    ):
        return None, False, False
    fields: dict[str, Optional[str]] = {}
    clipped = False
    for name, limit in (
        ("service", 40),
        ("code", 80),
        ("title", 120),
        ("detail", 300),
    ):
        fields[name], valid, field_clipped = _incident_text(row.get(name), limit)
        if not valid:
            return None, False, False
        clipped = clipped or field_clipped
    times: dict[str, Optional[int]] = {}
    for source, target in (
        ("first_seen_at", "first_seen_at_ms"),
        ("last_seen_at", "last_seen_at_ms"),
        ("resolved_at", "resolved_at_ms"),
    ):
        raw = row.get(source)
        if raw is None:
            times[target] = None
        else:
            parsed = _instant_ms(raw, now_ms)
            if parsed is None:
                return None, False, False
            times[target] = parsed
    first = times["first_seen_at_ms"]
    last = times["last_seen_at_ms"]
    resolved = times["resolved_at_ms"]
    if (
        (first is not None and last is not None and last < first)
        or (first is not None and resolved is not None and resolved < first)
        or (last is not None and resolved is not None and resolved < last)
        or (row["state"] == "open" and resolved is not None)
    ):
        return None, False, False
    bot, subject, link_valid = _incident_link(row)
    return {
        "id": incident_id,
        **fields,
        "severity": row["severity"],
        "state": row["state"],
        **times,
        "bot": bot,
        "subject": subject,
    }, True, clipped or not link_valid


def _incident_link(row: dict) -> tuple[Optional[str], Optional[dict], bool]:
    """The owner's structured link to a trading restriction: ``bot`` and ``subject``.

    ``subject`` is ``{controller_id, pair, reason_code}`` with the same normalised reason code as the
    bot card's restriction, so a client can show one fault once. Absent fields stay ``None``; a
    present but malformed link is dropped and reported as an incomplete detail.
    """
    raw_bot, raw_subject = row.get("bot"), row.get("subject")
    bot = (
        raw_bot
        if isinstance(raw_bot, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", raw_bot)
        else None
    )
    subject = None
    if isinstance(raw_subject, dict):
        controller, pair, code = (
            raw_subject.get("controller_id"),
            raw_subject.get("pair"),
            raw_subject.get("reason_code"),
        )
        if (
            _controller_id(controller) is not None
            and isinstance(pair, str)
            and len(pair) <= 80
            and PAIR_RE.fullmatch(pair)
            and isinstance(code, str)
            and REASON_CODE_RE.fullmatch(code)
        ):
            subject = {"controller_id": controller, "pair": pair, "reason_code": code}
    valid = (raw_bot is None or bot is not None) and (
        raw_subject is None or subject is not None
    )
    return bot, subject, valid


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
    read: OwnerRead, now_ms: float, missing: list
) -> tuple[Optional[dict], dict]:
    """Project the native account owner's valuation, including its incomplete coverage."""
    payload = _obj(read.payload)
    scope = _obj(payload.get("scope"))
    current = _obj(payload.get("current"))
    observed = _instant_ms(current.get("observed_at"), now_ms)
    value = _dec(current.get("priced_total"))
    encoded = fleet_pnl.decimal_text(value)
    assets = current.get("unpriced_assets")
    complete = current.get("valuation_complete")
    unit = payload.get("quote_currency")
    basis = payload.get("valuation_basis")
    usdt_holdings = current.get("holdings")
    legacy_usdt_policy_valid = (
        unit == "USDT"
        and basis is None
        and current.get("dust_threshold_usd") is None
        and not current.get("excluded_dust_assets")
        and isinstance(usdt_holdings, list)
        and not any(
            _obj(row).get("excluded_from_valuation") is True
            for row in usdt_holdings
        )
    )
    usdc_policy_valid = False
    if unit == "USDC":
        usdc_policy_valid = _usdc_materiality_valid(payload, current)
    valid = (
        payload.get("schema_version") == 1
        and (legacy_usdt_policy_valid or unit == "USDC" and usdc_policy_valid)
        and payload.get("capture_mode") == "observation-driven"
        and scope.get("account") == "master_account"
        and scope.get("connector") == "okx"
        and scope.get("market") == "spot"
        and isinstance(scope.get("identity"), str)
        and bool(scope["identity"].strip())
        and len(scope["identity"]) <= 80
        and observed is not None
        and value is not None
        and value >= 0
        and encoded is not None
        and type(complete) is bool
        and isinstance(assets, list)
        and all(isinstance(asset, str) and 0 < len(asset) <= 80 for asset in assets)
        and complete == (len(assets) == 0)
    )
    if not valid:
        reason = read.reason or (
            NOT_CONFIGURED if payload.get("scope") is None else INVALID
        )
        missing.append({"section": "wallet", "reason": reason})
        return None, _section("missing", None, STALE_AFTER_MS["wallet"], reason)
    stale = now_ms - observed > STALE_AFTER_MS["wallet"]
    wallet = {
        "equity": encoded,
        "unit": unit,
        "observed_at_ms": observed,
        "source_bot": None,
        "source": "native_account_portfolio",
        "account_scope": scope,
        "valuation_complete": complete,
        "unpriced_assets": assets[:GLANCE_MAX_BOTS],
        "unpriced_count": len(assets),
        "stale": stale,
    }
    if unit == "USDC":
        wallet.update(
            {
                "valuation_basis": basis,
                "dust_threshold_usd": fleet_pnl.decimal_text(
                    _dec(current["dust_threshold_usd"])
                ),
                "excluded_dust_assets": current["excluded_dust_assets"][
                    :GLANCE_MAX_BOTS
                ],
                "excluded_dust_count": len(current["excluded_dust_assets"]),
            }
        )
    reason = PARTIAL_COVERAGE if not complete else OWNER_NOT_CURRENT if stale else None
    if not complete:
        missing.append({"section": "wallet", "reason": PARTIAL_COVERAGE})
    return wallet, _section(
        "partial" if not complete else "stale" if stale else "ok",
        observed,
        STALE_AFTER_MS["wallet"],
        reason,
    )


def _usdc_materiality_valid(payload: dict, current: dict) -> bool:
    """Require owner evidence that USDC valuation excludes only verified sub-dollar assets."""
    threshold = _dec(current.get("dust_threshold_usd"))
    excluded_raw = current.get("excluded_dust_assets")
    unpriced_raw = current.get("unpriced_assets")
    holdings = current.get("holdings")
    if (
        payload.get("valuation_basis") != "native_account_usdc_material_v1"
        or threshold != Decimal("1")
        or not isinstance(excluded_raw, list)
        or len(excluded_raw) > 10_000
        or not isinstance(unpriced_raw, list)
        or len(unpriced_raw) > 10_000
        or not isinstance(holdings, list)
        or len(holdings) > 10_000
    ):
        return False
    if not all(
        isinstance(token, str) and 0 < len(token) <= 80
        for token in excluded_raw + unpriced_raw
    ):
        return False
    if len(set(excluded_raw)) != len(excluded_raw) or len(set(unpriced_raw)) != len(unpriced_raw):
        return False
    if type(current.get("valuation_complete")) is not bool:
        return False
    if current["valuation_complete"] != (len(unpriced_raw) == 0):
        return False

    seen: set[str] = set()
    excluded: set[str] = set()
    expected_unpriced: set[str] = set()
    for row in holdings:
        if not isinstance(row, dict):
            return False
        token = row.get("token")
        if not isinstance(token, str) or not 0 < len(token) <= 80 or token in seen:
            return False
        seen.add(token)
        if row.get("quote_currency") != "USDC":
            return False
        total = _nonneg_dec(row.get("total"))
        value = _nonneg_dec(row.get("value")) if row.get("value") is not None else None
        price = _nonneg_dec(row.get("price")) if row.get("price") is not None else None
        usd = _nonneg_dec(row.get("usd_equivalent")) if row.get("usd_equivalent") is not None else None
        source = row.get("usd_equivalent_source")
        marked = row.get("excluded_from_valuation")
        if (
            total is None
            or (row.get("value") is not None and value is None)
            or (row.get("price") is not None and price is None)
            or (row.get("usd_equivalent") is not None and usd is None)
            or (total == 0 and usd is not None and usd != 0)
            or source not in (None, "okx_account_balance_eqUsd")
            or (source is not None and usd is None)
            or type(marked) is not bool
        ):
            return False
        verified_usd = usd is not None and source == "okx_account_balance_eqUsd"
        if verified_usd and usd < threshold and marked is not True:
            return False
        if marked:
            if (
                not verified_usd
                or usd >= threshold
                or row.get("price") is not None
                or row.get("value") is not None
            ):
                return False
            excluded.add(token)
        elif total > 0 and (price is None or value is None):
            expected_unpriced.add(token)
    return (
        excluded == set(excluded_raw)
        and expected_unpriced == set(unpriced_raw)
        and not excluded.intersection(unpriced_raw)
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


CONTROLLER_PNL_TOLERANCE = Decimal("0.000001")


def _native_fresh(observed: Any, threshold: Any, now_ms: float) -> bool:
    """``expireNativeBotPage``'s freshness rule (``bot-monitoring.ts``): an observation in epoch seconds
    is current while ``-5 s <= age < min(threshold, 30 s)``."""
    if not all(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
        for value in (observed, threshold)
    ):
        return False
    age_ms = now_ms - observed * 1000
    return -5_000 <= age_ms < min(threshold, RUNTIME_STALE_CAP_S) * 1000


def _native_amount(value: Any) -> Optional[Decimal]:
    """A finite JSON number, as the dashboard's ``finite()`` admits it; anything else is unknown."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return _dec(value) if math.isfinite(value) else None


def _controller_net(
    page: Optional[dict], bot: str, now_ms: float
) -> Optional[tuple[Decimal, str]]:
    """Controller-report net PnL under the dashboard's ``projectControllerPnl`` rules (``controller-pnl.ts``).

    ``None`` unless the bot has one current native observation (status and performance within
    ``min(threshold, 30 s)``, ``controller_count_current``), exactly ``num_controllers`` controller rows
    with unique identities, one quote per controller and across the bot, every total reported, and
    every row's total reconciling with realized + unrealized within 1e-6. A multi-symbol controller's
    aggregate counts once.
    """
    page = page or {}
    bots, controllers = page.get("bots"), page.get("controllers")
    if (
        not isinstance(bots, list)
        or not isinstance(controllers, list)
        or any(
            not isinstance(row, dict) or not isinstance(row.get("bot_name"), str)
            for row in bots + controllers
        )
    ):
        return None
    selected = [row for row in bots if row["bot_name"] == bot]
    if len(selected) != 1:
        return None
    own, rows = selected[0], [row for row in controllers if row["bot_name"] == bot]
    count = own.get("num_controllers")
    current = (
        own.get("controller_count_current") is True
        and _native_fresh(
            own.get("status_received_at"), own.get("status_stale_after_seconds"), now_ms
        )
        and _native_fresh(
            own.get("performance_received_at"),
            own.get("performance_stale_after_seconds"),
            now_ms,
        )
    )
    if (
        not current
        or type(count) is not int
        or count < 0
        or len(rows) != count
        or not rows
    ):
        return None
    identities: set[str] = set()
    quotes: set[str] = set()
    totals: list[Decimal] = []
    for row in rows:
        identity = row.get("controller_id")
        if (
            not isinstance(identity, str)
            or not identity.strip()
            or identity in identities
        ):
            return None
        pair = row.get("trading_pair")
        pairs = [pair] if isinstance(pair, str) and PAIR_RE.fullmatch(pair) else []
        symbols = _obj(row.get("custom_info")).get("symbols")
        entries = list(symbols.items()) if isinstance(symbols, dict) else []
        if len(entries) >= 2 or not pairs:
            if len(entries) < 2 or any(
                not PAIR_RE.fullmatch(name) or not isinstance(value, dict)
                for name, value in entries
            ):
                return None
            pairs = sorted(name for name, _ in entries)
        row_quotes = {name.split("-")[1] for name in pairs}
        if len(row_quotes) != 1:
            return None
        identities.add(identity)
        quotes |= row_quotes
        total, realized, unrealized = (
            _native_amount(row.get(key))
            for key in (
                "global_pnl_quote",
                "realized_pnl_quote",
                "unrealized_pnl_quote",
            )
        )
        if (
            total is not None
            and realized is not None
            and unrealized is not None
            and abs(total - realized - unrealized) > CONTROLLER_PNL_TOLERANCE
        ):
            return None
        if total is None:
            return None
        totals.append(total)
    if len(quotes) != 1:
        return None
    total = fleet_pnl.exact_sum(totals)
    return None if total is None else (total, quotes.pop())


def bot_day_pnl(window: fleet_pnl.BotWindow, *, simulated: bool = False) -> dict:
    """A bot card's day change under the fleet window rules (contract ``pnl_day``): ``partial``
    when its history starts after the window opens, and the unrecorded time it sums across in
    ``uncovered_ms``, exactly as the fleet window carries both."""
    day = {
        "change": fleet_pnl.decimal_text(window.change),
        "unit": window.quote,
        "partial": not window.full,
        "stale": window.stale,
        "uncovered_ms": round(window.uncovered_ms),
    }
    if simulated:
        day["simulated"] = True
    return day


def _held_wallet_section(
    server: str,
    read: OwnerRead,
    now_ms: float,
    missing: list,
    last_known: Optional[LastKnown],
) -> tuple[Optional[dict], dict]:
    """The wallet from this build's account read, or, when that read failed, the last valid
    observation while its own age is within the wallet ``stale_after_ms`` (marked ``held``).
    """
    own_missing: list = []
    wallet, section = _wallet_section(read, now_ms, own_missing)
    if last_known is not None:
        if wallet is not None and read.reason is None:
            last_known.wallet[server] = read.payload
        elif (
            wallet is None
            and read.reason == SOURCE_UNAVAILABLE
            and server in last_known.wallet
        ):
            held_missing: list = []
            held, held_section = _wallet_section(
                OwnerRead(last_known.wallet[server]), now_ms, held_missing
            )
            if (
                held is not None
                and now_ms - held["observed_at_ms"] <= STALE_AFTER_MS["wallet"]
            ):
                wallet, section, own_missing = (
                    {**held, "held": True},
                    held_section,
                    held_missing,
                )
    missing.extend(own_missing)
    if wallet is not None:
        wallet.setdefault("held", False)
    return wallet, section


def _held_trading(
    server: str,
    bots: list[str],
    runtime: dict[str, Optional[dict]],
    owner: dict[tuple[str, str], OwnerRead],
    now_ms: float,
    last_known: Optional[LastKnown],
) -> dict[str, Optional[dict]]:
    """Each bot's capability from this build's owner runtime read, else its last good one (bounded)."""
    result: dict[str, Optional[dict]] = {}
    for bot in bots:
        rt = runtime.get(bot)
        capability = rt.get("trading") if rt is not None else None
        if last_known is not None:
            key = (server, bot)
            if capability is not None:
                if capability["observed_ms"] is not None:
                    last_known.trading[key] = capability
            elif key in last_known.trading:
                held = last_known.trading[key]
                if 0 <= now_ms - held["observed_ms"] <= TRADING_HOLD_MS:
                    read = owner.get((bot, "bootstrap"))
                    capability = held_trading(
                        held, (read.reason if read else None) or INVALID
                    )
                else:
                    del last_known.trading[key]
        result[bot] = capability
    return result


def _bot_cards(
    bots: list[str],
    page: Optional[dict],
    quant: dict[str, Optional[dict]],
    owner_reasons: dict[tuple[str, str], str],
    cycles: dict[str, Optional[dict]],
    runtime: dict[str, Optional[dict]],
    inventory: dict[str, dict],
    totals: dict[str, Optional[dict]],
    day: fleet_pnl.FleetWindow,
    latest_samples: dict[str, Optional[tuple[fleet_pnl.Sample, str]]],
    now_ms: float,
    missing: list,
    paper_day: Optional[dict[str, fleet_pnl.FleetWindow]] = None,
    trading: Optional[dict[str, Optional[dict]]] = None,
) -> list[dict]:
    """One card per bot. A paper card carries its own simulated numbers (``simulated: true``); its gaps
    stay on the card and never enter the fleet ``missing`` list."""
    status_by_bot = {b.get("bot_name"): b for b in (page or {}).get("bots", [])}
    day_by_bot = {w.bot: w for w in day.bots}
    paper_day = paper_day or {}
    for window in paper_day.values():
        day_by_bot.update({w.bot: w for w in window.bots})
    cards = []
    for bot in bots:
        gaps: list[dict] = []
        paper = is_paper(bot)

        def gap(field: str, reason: str, *, listed: bool = True) -> None:
            gaps.append({"field": field, "reason": reason})
            if listed and not paper:
                missing.append(
                    {"section": "bots", "bot": bot, "field": field, "reason": reason}
                )

        status = status_by_bot.get(bot)
        q, c = quant.get(bot), cycles.get(bot)
        rt, ledger = runtime.get(bot), totals.get(bot)
        summary_reason = owner_reasons.get((bot, "quant-summary"))
        cycles_reason = owner_reasons.get((bot, "quant-cycles"))
        runtime_reason = owner_reasons.get((bot, "bootstrap"))
        if status is None:
            gap("status", SOURCE_UNAVAILABLE)

        # Inventory: the one holdings projection every client renders (the owner's quant view).
        positions = executors = None
        executors_basis = None
        held = inventory.get(bot)
        if held is not None and held["held_pair_count"] is not None:
            positions = {
                "held": held["held_pair_count"],
                "registered": held["registered_pair_count"],
                "current": held["state"] == holdings.CURRENT,
            }
        else:
            gap(
                "positions",
                summary_reason
                or (
                    INVALID
                    if held is None
                    else INVALID
                    if holdings.PAIR_FIELD_INVALID in held["incomplete_reasons"]
                    else PARTIAL_COVERAGE
                    if held["state"] != holdings.UNAVAILABLE
                    else OWNER_NOT_CURRENT
                    if held["reason"] == holdings.RUNTIME_NOT_CURRENT
                    else INVALID
                    if held["reason"] in holdings.MALFORMED
                    else SOURCE_UNAVAILABLE
                ),
            )
        open_cycles = c["counts"].get("open") if c is not None else None
        if open_cycles is None and q is not None:
            open_cycles = q["open_cycles"]
        if rt is not None and (rt["current"] or open_cycles is None):
            executors, executors_basis = rt["executors"], "runtime_active_executors"
        elif open_cycles is not None:
            executors, executors_basis = open_cycles, "open_lifecycle_cycles"
        else:
            gap("executors", cycles_reason or summary_reason or runtime_reason or INVALID)

        performance_at = (
            _num(status.get("performance_received_at")) if status else None
        )
        if (
            performance_at is not None
            and (performance_at <= 0 or performance_at > (now_ms + 5_000) / 1000)
        ):
            performance_at = None
        performance_limit = (
            _num(status.get("performance_stale_after_seconds")) if status else None
        )
        performance_current = bool(
            performance_at is not None
            and performance_limit is not None
            and performance_limit > 0
            and now_ms / 1000 - performance_at < performance_limit
        )
        observations = [
            (q["observed_ms"], q["current"]) if q is not None else (None, False),
            (rt["observed_ms"], rt["current"]) if rt is not None else (None, False),
            (
                (
                    int(round(performance_at * 1000)),
                    performance_current,
                )
                if performance_at is not None
                else (None, False)
            ),
        ]
        # The age and current flag must describe the same source. Prefer a
        # current owner observation before retaining an older source's clock.
        report_at, report_current = next(
            (
                (stamp, current)
                for stamp, current in observations
                if stamp is not None and current
            ),
            next(
                ((stamp, False) for stamp, _ in observations if stamp is not None),
                (None, False),
            ),
        )
        if report_at is None:
            gap("report_at_ms", summary_reason or runtime_reason or SOURCE_UNAVAILABLE)

        day_window = day_by_bot.get(bot)
        pnl_day = None
        if day_window is not None:
            pnl_day = bot_day_pnl(day_window, simulated=paper)
        elif paper:
            own = paper_day.get(bot)
            gap(
                "pnl_day",
                next((m["reason"] for m in own.missing), fleet_pnl.NO_SAMPLES)
                if own is not None
                else fleet_pnl.NOT_READ,
            )
        else:
            gap(
                "pnl_day",
                next(
                    (m["reason"] for m in day.missing if m["bot"] == bot),
                    fleet_pnl.NOT_READ,
                ),
            )

        net_now = None
        live = _controller_net(page, bot, now_ms)
        sample = latest_samples.get(bot)
        if live is not None:
            net_now = {
                "value": fleet_pnl.decimal_text(live[0]),
                "unit": live[1],
                "source": "controller",
            }
            if paper:
                net_now["simulated"] = True
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
            if paper:
                net_now["simulated"] = True
        if net_now is None:
            gap("net_now", fleet_pnl.NO_SAMPLES)

        # Fees and trades: scored cycles when the owner publishes them, else its fill ledger (a ledger the
        # page limit cut short is only a lower bound, so it never stands in for a lifetime total).
        ledger_ok = ledger is not None and not ledger["saturated"]
        fees = trades = None
        if c is not None and c["fees"] is not None and c["quote"]:
            fees = {"amount": fleet_pnl.decimal_text(c["fees"]), "unit": c["quote"]}
        elif ledger_ok and ledger["fees"] is not None and ledger["quote"]:
            fees = {
                "amount": fleet_pnl.decimal_text(ledger["fees"]),
                "unit": ledger["quote"],
            }
        else:
            gap(
                "fees",
                INVALID
                if c is not None or ledger is not None
                else cycles_reason or INVALID,
            )
        if c is not None:
            since = now_ms - 86_400_000
            lifetime = c["fill_count"]
            if lifetime is None and c["cycles"]:
                lifetime = sum(row["fill_count"] for row in c["cycles"])
            if lifetime is None and ledger_ok:
                lifetime = ledger["count"]
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
        elif ledger_ok:
            # No lifecycle projection: the 24h cycle counts are unknown, not zero.
            trades = {
                "lifetime": ledger["count"],
                "opened_24h": None,
                "closed_24h": None,
            }
        else:
            gap("trades", INVALID if ledger is not None else cycles_reason or INVALID)

        if trading is not None:
            capability = trading.get(bot)
        else:
            capability = rt.get("trading") if rt is not None else None
        if capability is None and not paper:
            # A live owner always publishes its capability; its absence is a failed or rejected read.
            gap("trading", runtime_reason or INVALID)

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
                "executors_basis": executors_basis,
                "pnl_day": pnl_day,
                "net_now": net_now,
                "fees": fees,
                "trades": trades,
                # Process status says the bot runs; this says whether it can buy and sell.
                "trading": capability,
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
    readers: Readers,
    server: str,
    live: list[str],
    now_ms: float,
    paper: tuple[str, ...] = (),
) -> tuple[dict[str, list[fleet_pnl.BotHistory]], list[fleet_pnl.BotHistory]]:
    """Live PnL histories and paper bots' own 1D histories for their cards only."""
    clock = now_ms + 5_000
    histories: dict[str, list[fleet_pnl.BotHistory]] = {
        r: [] for r in ("1D", "1W", "1M", "ALL")
    }
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
    paper_histories: list[fleet_pnl.BotHistory] = []
    for bot in paper:
        try:
            payload, failed = (
                readers.performance(server, bot, "1D", now_ms / 1000),
                False,
            )
        except Exception:
            payload, failed = None, True
        paper_histories.append(
            fleet_pnl.parse_bot_history(payload, bot, "1D", clock, failed)
        )
    return histories, paper_histories


async def build_fleet_summary(
    server: str,
    view: str,
    readers: Readers,
    now_ms: float,
    *,
    is_admin: bool,
    user_id: Any = None,
    clock_ms: Callable[[], float] | None = None,
    last_known: Optional[LastKnown] = None,
) -> dict:
    """Compute the whole payload. ``view='glance'`` is the compact projection of the same computation.

    ``last_known`` (optional) lets a failed account or owner runtime read stand on the last good
    observation within its own age bound (see ``LastKnown``)."""
    if view not in VIEWS:
        raise ValueError(f"unknown view {view!r}")
    missing: list[dict] = []
    sections: dict[str, dict] = {}

    async def read_status():
        async with phase_span("status_read") as phase:
            value = await readers.bots_status(server)
            if value is None:
                phase["outcome"] = "unavailable"
            return value

    registry = readers.registered_bots(server)
    status_raw = None
    if registry:
        bots = list(dict.fromkeys(registry))
    else:
        # Only roster discovery depends on status. With registered owner sources,
        # status and owner reads are independent and must share one read window.
        status_raw = await read_status()
        page = build_bots_page(status_raw) if status_raw is not None else None
        bots = list(dict.fromkeys(
            b["bot_name"] for b in (page or {}).get("bots", []) if b.get("bot_name")
        ))
        if bots:
            missing.append({"section": "bots", "reason": REGISTRY_FROM_STATUS})
    live = [b for b in bots if not is_paper(b)]

    async def resolve_status():
        return await read_status() if registry else status_raw

    status_task = asyncio.create_task(resolve_status())

    # Independent reads run together; each fails into its own reason code.
    owner_jobs: list[tuple[str, str, dict]] = [
        (bot, path, {})
        for bot in bots
        for path in ("quant-summary", "quant-cycles", "bootstrap")
        if view == "full" or path != "quant-cycles" or not is_paper(bot)
    ]
    owner_jobs += [
        (bot, "fills", {"limit": str(OWNER_FILL_LIMIT)})
        for bot in bots
        if view == "full" or not is_paper(bot)
    ]
    incident_bot = live[0] if live else None
    if is_admin and incident_bot:
        owner_jobs.append((incident_bot, "operations", {}))
    paper_bots = tuple(b for b in bots if is_paper(b))

    async def read_local_history():
        # Native status may append a point or mark a recording gap. Read that
        # committed history after status settles, while other sources proceed.
        try:
            await asyncio.shield(status_task)
        except Exception:
            pass  # An unavailable status still allows last-known history reads.
        read_now_ms = clock_ms() if clock_ms is not None else now_ms
        async with phase_span("local_history"):
            return await asyncio.to_thread(
                _sync_reads, readers, server, live, read_now_ms, paper_bots
            )

    async def read_market():
        async with phase_span("market_read") as phase:
            result = await readers.market(server, user_id)
            if result.frame is None:
                phase["outcome"] = "unavailable"
            return result

    async def read_account():
        async with phase_span("account_read") as phase:
            result = await readers.account(server, user_id)
            if result.reason is not None:
                phase["outcome"] = "unavailable"
            return result

    async def read_owner(bot: str, path: str, params: dict):
        async with phase_span(f"owner.{path}") as phase:
            result = await _safe_owner(readers, bot, path, params)
            if result.reason is not None:
                phase["outcome"] = "unavailable"
            return result

    results = await asyncio.gather(
        status_task,
        read_local_history(),
        read_market(),
        read_account(),
        *[read_owner(bot, path, params) for bot, path, params in owner_jobs],
        return_exceptions=True,
    )
    status_raw, sync_result, market_result, account_result, owner_results = (
        results[0], results[1], results[2], results[3], results[4:]
    )
    if isinstance(status_raw, BaseException):
        status_raw = None
    page = build_bots_page(status_raw) if status_raw is not None else None
    if page is None:
        missing.append({"section": "bots", "field": "status", "reason": SOURCE_UNAVAILABLE})
    now_ms = clock_ms() if clock_ms is not None else now_ms
    if isinstance(sync_result, BaseException):
        histories = {r: [] for r in ("1D", "1W", "1M", "ALL")}
        paper_histories = [
            fleet_pnl.BotHistory(bot, "1D", reason=fleet_pnl.HISTORY_READ_FAILED)
            for bot in paper_bots
        ]
    else:
        histories, paper_histories = sync_result
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
    wallet, sections["wallet"] = _held_wallet_section(
        server,
        (
            account_result
            if isinstance(account_result, OwnerRead)
            else OwnerRead(None, SOURCE_UNAVAILABLE)
        ),
        now_ms,
        missing,
        last_known,
    )

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
            # An unrecorded stretch inside a window is not observed change: incomplete (contract `gaps`).
            incomplete = any(
                w.counted < w.expected or w.partial or w.gaps for w in usable
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
        if (bot, "quant-cycles") in owner
    }
    runtime = {
        bot: project_runtime_view(owner[(bot, "bootstrap")].payload, bot, now_ms)
        for bot in bots
    }
    trading = _held_trading(server, bots, runtime, owner, now_ms, last_known)
    inventory = {
        bot: (
            holdings.project_bot(read.payload, bot, now_ms)
            if (read := owner[(bot, "quant-summary")]).payload is not None
            else holdings.unavailable_bot(bot, read.reason or SOURCE_UNAVAILABLE)
        )
        for bot in bots
    }
    totals = {
        bot: project_fill_totals(owner[(bot, "fills")].payload, bot, OWNER_FILL_LIMIT)
        for bot in bots
        if (bot, "fills") in owner
    }
    owner_reasons: dict[tuple[str, str], str] = {}
    projections = {
        "quant-summary": quant,
        "quant-cycles": cycles,
        "bootstrap": runtime,
    }
    for (bot, path), read in owner.items():
        if path in projections and (read.reason or projections[path].get(bot) is None):
            owner_reasons[(bot, path)] = read.reason or INVALID
    latest_samples: dict[str, Optional[tuple[fleet_pnl.Sample, str]]] = {}
    for history in [*histories.get("1D", []), *paper_histories]:
        latest_samples[history.bot] = (
            (history.samples[-1], history.quote or "")
            if history.samples and history.quote
            else None
        )
    day_window = windows.get("day") or fleet_pnl.fleet_window([], [], 0, 0, 0)
    # Each paper bot's own simulated day change, for its card only: never part of a fleet window
    # (one window per bot, so two paper quotes never compete).
    paper_day = {
        history.bot: fleet_pnl.fleet_window(
            [history],
            [history.bot],
            now_ms - fleet_pnl.RANGE_SPAN_MS["1D"],
            now_ms,
            now_ms + 5_000,
        )
        for history in paper_histories
    }
    cards = (
        _bot_cards(
            bots,
            page,
            quant,
            owner_reasons,
            cycles,
            runtime,
            inventory,
            totals,
            day_window,
            latest_samples,
            now_ms,
            missing,
            paper_day,
            trading,
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
        # The section verdict is the live fleet's: a paper card's own gaps never make it partial.
        incomplete = (
            any(c["missing"] for c in cards if not c["paper"]) or page is None
        )
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
            merged.extend(project_fills(read.payload, bot, now_ms))
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

    # paper fills: a separate, labelled list (full view only), never merged into ``fills``
    paper_fills: Optional[list[dict]] = None
    if paper_bots and view == "full":
        paper_merged = [
            {**fill, "simulated": True}
            for bot in paper_bots
            if owner[(bot, "fills")].payload is not None
            for fill in project_fills(owner[(bot, "fills")].payload, bot, now_ms)
        ]
        paper_merged.sort(
            key=lambda f: (f["time_ms"] is not None, f["time_ms"] or 0), reverse=True
        )
        paper_fills = paper_merged[: RECENT_FILLS["full"]]

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
        "bot_counts": {
            "live_running": sum(
                not c["paper"]
                and isinstance(c["status"], str)
                and c["status"].lower() == "running"
                for c in cards
            ),
            "live_total": sum(not c["paper"] for c in cards),
            "paper_total": sum(c["paper"] for c in cards),
            "live_stale_reports": sum(
                not c["paper"] and c["report_stale"] for c in cards
            ),
        },
        "fills": fills,
        "incidents": incidents,
    }
    if view == "full":
        body["paper_fills"] = paper_fills
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
                        for k in (
                            "unit",
                            "total",
                            "partial",
                            "counted",
                            "expected",
                            "stale",
                            "uncovered_ms",
                        )
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
                "expires_at_ms": market["frame"]["expires_at_ms"],
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
                # One word keeps the Watch glance under its 8 KiB budget; the full view has the detail.
                "trading": None if c.get("trading") is None else trading_word(c["trading"]),
            }
            for c in full["bots"][:GLANCE_MAX_BOTS]
        ],
        "bots_total": len(full["bots"]),
        "bot_counts": full["bot_counts"],
        "fills": (
            None
            if full["fills"] is None
            else [
                {
                    **{k: f[k] for k in ("bot", "pair", "side", "volume", "time_ms")},
                    "execution_timestamp_ms": f.get("execution_timestamp_ms"),
                    "execution_timestamp_source": f.get("execution_timestamp_source"),
                }
                for f in full["fills"][: RECENT_FILLS["glance"]]
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
