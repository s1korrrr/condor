"""Pure alert-event detectors for native push.

Everything here is deterministic: no I/O, no clock (callers pass ``now``), no
SQLite. A detector receives a snapshot read from the native API plus a ``seen``
predicate and returns the events to send and the dedup keys to record. The
worker commits both in one transaction, so an event is announced at most once
per key and a failed read never advances a checkpoint.

Activation semantics follow the Telegram fleet worker: a source's history older
than its activation time is recorded as seen and never announced; rows that can
alert must carry exact economics or the whole batch is rejected (fail closed).
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable, Iterable, Mapping, Sequence

from condor import fleet_telegram_views as views
from condor.fleet_trade_alerts import economics, fill_key, identity

# --------------------------------------------------------------------------- contract

SEVERITIES = ("info", "notice", "warning", "critical")
_SEVERITY_RANK = {name: rank for rank, name in enumerate(SEVERITIES)}
BOT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")
DEFAULT_LABELS = {"ok_rsi": "V1", "rsi_modular_v2": "V2", "meridian_v3": "V3"}
FILL_HISTORY_LIMIT = 1000


@dataclass(frozen=True)
class AlertClass:
    id: str
    label: str
    description: str
    default_enabled: bool
    category: str  # UNNotificationCategory identifier; none declares an action


ALERT_CLASSES: dict[str, AlertClass] = {
    c.id: c
    for c in (
        AlertClass(
            "fill_entry",
            "Entry fills",
            "A buy fill confirmed by the native owner.",
            True,
            "RSIBOT_FILL",
        ),
        AlertClass(
            "fill_exit",
            "Exit fills",
            "A sell fill confirmed by the native owner.",
            True,
            "RSIBOT_FILL",
        ),
        AlertClass(
            "bag",
            "Bags and trailing",
            "A new held bag, or a trailing stop that armed.",
            True,
            "RSIBOT_BAG",
        ),
        AlertClass(
            "risk",
            "Risk rails",
            "The daily-loss rail paused entries.",
            True,
            "RSIBOT_RISK",
        ),
        AlertClass(
            "health",
            "Bot health",
            "An owner is offline, its lifecycle is invalid, or its status or data went stale.",
            True,
            "RSIBOT_HEALTH",
        ),
        AlertClass(
            "incident",
            "Stack incidents",
            "A container incident opened or recovered in the host monitor.",
            True,
            "RSIBOT_INCIDENT",
        ),
        AlertClass(
            "summary",
            "Daily summary",
            "One fleet summary per UTC day.",
            False,
            "RSIBOT_SUMMARY",
        ),
        AlertClass(
            "market",
            "Market verdict",
            "The market verdict flipped between Risk-on and Risk-off.",
            False,
            "RSIBOT_MARKET",
        ),
        AlertClass(
            "test",
            "Test",
            "A test alert you requested.",
            True,
            "RSIBOT_TEST",
        ),
    )
}
# Always delivered when requested; a device cannot switch its own test alert off.
ALWAYS_ON_CLASSES = frozenset({"test"})


def default_classes() -> dict[str, bool]:
    return {cid: c.default_enabled for cid, c in ALERT_CLASSES.items()}


def severity_rank(severity: str) -> int:
    return _SEVERITY_RANK[severity]


def interruption_level(severity: str) -> str:
    """Apple interruption level. Critical alerts (an entitlement) are never used."""
    return {
        "info": "passive",
        "notice": "active",
        "warning": "time-sensitive",
        "critical": "time-sensitive",
    }[severity]


def digest(*parts: Any, size: int = 24) -> str:
    raw = "\x1f".join(str(part) for part in parts).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:size]


def clean_text(value: Any, limit: int, *, multiline: bool = False) -> str:
    """Control-free, bounded text for a notification (single line unless ``multiline``)."""
    if value is None or isinstance(value, bool):
        return ""
    if multiline:
        text = "\n".join(clean_text(line, limit) for line in str(value).splitlines())
        text = text.strip("\n")
    else:
        text = " ".join(
            "".join(c if c.isprintable() else " " for c in str(value)).split()
        )
    return text if len(text) <= limit else text[: max(limit - 1, 0)].rstrip() + "…"


@dataclass(frozen=True)
class AlertEvent:
    id: str
    cls: str
    severity: str
    title: str
    body: str
    deep_link: str
    collapse_key: (
        str  # apns-collapse-id: a later event with this key replaces the earlier one
    )
    thread_id: str  # aps.thread-id: notifications group per bot
    occurred_at: float
    bot: str | None = None
    bot_tag: str | None = None
    kind: str = ""

    def __post_init__(self) -> None:
        if self.cls not in ALERT_CLASSES:
            raise ValueError("unknown alert class")
        if self.severity not in _SEVERITY_RANK:
            raise ValueError("unknown alert severity")
        if not self.id or len(self.id) > 120:
            raise ValueError("alert id must be 1-120 characters")
        if not self.collapse_key or len(self.collapse_key.encode("utf-8")) > 64:
            raise ValueError("collapse key must be 1-64 bytes")
        if not self.deep_link.startswith("rsibot://"):
            raise ValueError("deep link must use the rsibot scheme")
        if not self.title or not self.body:
            raise ValueError("alert needs a title and a body")
        if not math.isfinite(self.occurred_at):
            raise ValueError("alert time must be finite")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "cls": self.cls,
            "severity": self.severity,
            "title": self.title,
            "body": self.body,
            "deep_link": self.deep_link,
            "collapse_key": self.collapse_key,
            "thread_id": self.thread_id,
            "occurred_at": self.occurred_at,
            "bot": self.bot,
            "bot_tag": self.bot_tag,
            "kind": self.kind,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "AlertEvent":
        return cls(**{key: raw[key] for key in cls.__dataclass_fields__ if key in raw})


@dataclass(frozen=True)
class SourceInfo:
    """What the detectors need to know about one registered bot."""

    key: str  # fleet_trade_alerts.source_key: stable dedup identity of the source
    bot_id: str  # native bot name, e.g. rsi_modular_v2
    tag: str  # "V1" / "V2" / "V3" or a display name
    quote: str = "quote"


@dataclass(frozen=True)
class Detection:
    events: tuple[AlertEvent, ...] = ()
    seen: tuple[str, ...] = ()  # dedup keys to record with the events, atomically
    primed: bool = False  # a first snapshot was absorbed silently
    skipped: int = 0  # rows that could not be deduplicated safely


Seen = Callable[[str], bool]


def bot_tag(
    bot_id: str,
    display_name: str | None = None,
    labels: Mapping[str, str] | None = None,
) -> str:
    mapping = {**DEFAULT_LABELS, **(labels or {})}
    if bot_id in mapping:
        return clean_text(mapping[bot_id], 16)
    match = re.search(r"(?:^|[_-])(v\d{1,2})$", bot_id.lower())
    if match:
        return match.group(1).upper()
    return clean_text(display_name or bot_id, 24) or "Bot"


def link(section: str, bot_id: str | None = None) -> str:
    if bot_id is not None:
        if not BOT_ID.fullmatch(bot_id):
            raise ValueError("invalid bot id for a deep link")
        if section not in {"overview", "fills", "bag", "risk", "health"}:
            raise ValueError("invalid bot section")
        return f"rsibot://bot/{bot_id}/{section}"
    if section not in {"operations", "market", "overview", "summary", "settings/push"}:
        raise ValueError("invalid section")
    return f"rsibot://{section}"


def _thread(bot_id: str | None, fallback: str) -> str:
    return f"bot:{bot_id}" if bot_id else fallback


def _epoch(value: Any) -> float | None:
    try:
        return views.stamp(value)
    except ValueError:
        return None


def _utc_day(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")


_EPOCH_DAY = date(1970, 1, 1)


def day_number(value: Any) -> int | None:
    """Days since the Unix epoch from what an owner publishes as its UTC day.

    The engine's ``daily_entry_risk.utc_day`` is an integer day number (the
    reporting tests carry ``20720``); an ISO ``YYYY-MM-DD`` string is accepted too.
    Anything else is unknown, never guessed.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value == int(value):
        return int(value)
    if isinstance(value, str):
        try:
            return (date.fromisoformat(value) - _EPOCH_DAY).days
        except ValueError:
            return int(value) if value.isdecimal() and len(value) <= 7 else None
    return None


def _day_label(number: int) -> str:
    return (_EPOCH_DAY + timedelta(days=number)).isoformat()


def _today_number(now: float) -> int:
    return int(now // 86400)


# --------------------------------------------------------------------------- fills


def _fill_seen_key(row: Mapping[str, Any]) -> str:
    return "fill:" + hashlib.sha256(fill_key(row).encode("utf-8")).hexdigest()


def detect_fills(
    src: SourceInfo,
    rows: Sequence[Mapping[str, Any]],
    *,
    started: float,
    seen: Seen,
    limit: int = FILL_HISTORY_LIMIT,
) -> Detection:
    """Fill events for a bot's recent history, honoring activation time.

    The whole batch is validated before anything is returned: a row with an
    incomplete identity, or a post-activation row without exact economics,
    raises ValueError and nothing advances. A full-limit history that never
    reaches back to activation or to a known fill is a coverage gap, not a quiet
    window, and is rejected too.
    """
    parsed = []
    for row in rows:
        occurred = identity(row)
        if occurred >= started:
            economics(row)
        parsed.append((row, _fill_seen_key(row), occurred))
    if len(rows) >= limit:
        known = any(seen(key) for _, key, _ in parsed)
        if min(occurred for _, _, occurred in parsed) > started and not known:
            raise ValueError("fill history reached its coverage limit")

    new: dict[str, tuple[Mapping[str, Any], float]] = {}
    for row, key, occurred in parsed:
        if key not in new and not seen(key):
            new[key] = (row, occurred)
    groups: dict[
        tuple[str, str, str, str], list[tuple[str, Mapping[str, Any], float]]
    ] = defaultdict(list)
    for key, (row, occurred) in new.items():
        if occurred >= started:
            groups[
                (row["source_db_id"], row["order_id"], row["side"], row["pair"])
            ].append((key, row, occurred))
    events = []
    for (source_db_id, order_id, side, pair), members in sorted(groups.items()):
        members.sort(key=lambda m: (m[2], m[0]))
        values = [economics(m[1]) for m in members]
        amount = sum((v[0] for v in values), Decimal(0))
        gross = sum((v[0] * v[1] for v in values), Decimal(0))
        fee = (
            sum((v[2] for v in values), Decimal(0))
            if all(v[2] is not None for v in values)
            else None
        )
        base, quote = pair.split("-")
        buy = side == "buy"
        body = (
            f"{'Entry' if buy else 'Exit'} filled {views.number(amount)} {base} "
            f"@ {views.number(gross / amount)} · {views.number(gross, money=True)} {quote}"
        )
        if fee is not None:
            body += f" · fee {views.number(fee)} {quote}"
        events.append(
            AlertEvent(
                id="fill:" + digest(src.key, *sorted(m[0] for m in members)),
                cls="fill_entry" if buy else "fill_exit",
                severity="notice",
                title=clean_text(f"{src.tag} · {'BUY' if buy else 'SELL'} {pair}", 100),
                body=clean_text(body, 300),
                deep_link=link("fills", src.bot_id),
                collapse_key="fill:" + digest(src.key, source_db_id, order_id),
                thread_id=_thread(src.bot_id, "fleet"),
                occurred_at=max(m[2] for m in members),
                bot=src.bot_id,
                bot_tag=src.tag,
                kind="entry" if buy else "exit",
            )
        )
    return Detection(tuple(events), tuple(new))


# --------------------------------------------------------------------------- bags


CLOSE_TYPES = {
    "1": "TIME_LIMIT",
    "2": "STOP_LOSS",
    "3": "TAKE_PROFIT",
    "4": "EXPIRED",
    "5": "EARLY_STOP",
    "6": "TRAILING_STOP",
    "7": "INSUFFICIENT_BALANCE",
    "8": "FAILED",
    "9": "COMPLETED",
    "10": "POSITION_HOLD",
}
_CLOSED = frozenset({"closed", "completed", "terminated"})
_LIVE = frozenset({"active", "running", "open", "partially_filled"})


def close_type_name(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip().upper().removeprefix("CLOSETYPE.")
    return CLOSE_TYPES.get(text, text) or None


def detect_executors(
    src: SourceInfo,
    rows: Sequence[Mapping[str, Any]],
    *,
    started: float,
    seen: Seen,
    primed: bool,
) -> Detection:
    """New held bags and trailing stops that armed.

    A held bag is a position executor that closed with ``POSITION_HOLD`` at or
    after activation. ``trailing_state == "armed"`` is the engine's own word for
    an armed trailing stop; the executor rows carry no arming time, so the first
    snapshot (``primed`` False) is absorbed silently and only later transitions
    announce. Rows without an executor id cannot be deduplicated and are skipped.
    """
    events: list[AlertEvent] = []
    keys: list[str] = []
    skipped = 0
    for row in rows:
        executor_id = row.get("executor_id")
        if (
            not isinstance(executor_id, str)
            or not executor_id
            or len(executor_id) > 200
        ):
            skipped += 1
            continue
        pair = row.get("pair") or row.get("trading_pair")
        if not isinstance(pair, str) or len(pair.split("-")) != 2:
            skipped += 1
            continue
        base, quote = pair.split("-")
        status = str(row.get("normalized_status") or "").lower()
        collapse = "bag:" + digest(src.key, executor_id)
        if (
            status in _CLOSED
            and close_type_name(row.get("close_type")) == "POSITION_HOLD"
        ):
            closed_at = _epoch(row.get("closed_at") or row.get("timestamp"))
            key = "bag:" + executor_id
            if closed_at is None or seen(key):
                continue
            keys.append(key)
            if closed_at < started:
                continue
            amount = views.decimal(row.get("amount_base"))
            price = views.decimal(row.get("price_quote"))
            detail = f"{pair} was retained as a held bag, not sold."
            if amount is not None and amount > 0:
                detail += f" {views.number(amount)} {base}"
                if price is not None and price > 0:
                    detail += f" @ {views.number(price)} {quote}"
                detail += "."
            events.append(
                AlertEvent(
                    id="bag:" + digest(src.key, executor_id, "hold"),
                    cls="bag",
                    severity="notice",
                    title=clean_text(f"{src.tag} · Held bag {pair}", 100),
                    body=clean_text(detail, 300),
                    deep_link=link("bag", src.bot_id),
                    collapse_key=collapse,
                    thread_id=_thread(src.bot_id, "fleet"),
                    occurred_at=closed_at,
                    bot=src.bot_id,
                    bot_tag=src.tag,
                    kind="held",
                )
            )
        elif (
            status in _LIVE and str(row.get("trailing_state") or "").lower() == "armed"
        ):
            key = "trail:" + executor_id
            if seen(key):
                continue
            keys.append(key)
            if not primed:
                continue
            trigger = views.decimal(row.get("trailing_trigger_price"))
            detail = f"Trailing stop armed on {pair}."
            if trigger is not None and trigger > 0:
                detail += f" Trigger {views.number(trigger)} {quote}."
            events.append(
                AlertEvent(
                    id="bag:" + digest(src.key, executor_id, "trail"),
                    cls="bag",
                    severity="notice",
                    title=clean_text(f"{src.tag} · Trailing armed {pair}", 100),
                    body=clean_text(detail, 300),
                    deep_link=link("bag", src.bot_id),
                    collapse_key=collapse,
                    thread_id=_thread(src.bot_id, "fleet"),
                    occurred_at=_epoch(row.get("timestamp")) or started,
                    bot=src.bot_id,
                    bot_tag=src.tag,
                    kind="trailing_armed",
                )
            )
    return Detection(tuple(events), tuple(keys), primed=True, skipped=skipped)


# --------------------------------------------------------------------------- risk rails


def _runtime(payload: Any) -> Mapping[str, Any] | None:
    runtime = payload.get("runtime_status") if isinstance(payload, Mapping) else None
    return runtime if isinstance(runtime, Mapping) else None


def detect_risk(
    src: SourceInfo,
    payload: Any,
    *,
    now: float,
    seen: Seen,
    stale_seconds: float,
) -> Detection:
    """The owner's daily-loss rail paused entries today.

    A rail state is current evidence, not history: it announces once per UTC day
    while the owner's own status is fresh. Missing or malformed rail data is
    silence, never a guess.
    """
    runtime = _runtime(payload)
    daily = runtime.get("daily_entry_risk") if runtime else None
    if not isinstance(daily, Mapping):
        return Detection()
    updated = _epoch(runtime.get("updated_at"))
    if updated is None or not 0 <= now - updated <= stale_seconds:
        return Detection()
    breach = daily.get("breach_day")
    day = day_number(breach if breach is not None else daily.get("utc_day"))
    paused = daily.get("paused") is True
    if not (paused or breach is not None) or day is None or day != _today_number(now):
        return Detection()
    key = f"risk:{day}"
    if seen(key):
        return Detection()
    limit = views.decimal(daily.get("limit_quote"))
    baseline = views.decimal(daily.get("baseline_quote"))
    last = views.decimal(daily.get("last_pnl_quote"))
    body = f"Daily-loss rail reached (UTC {_day_label(day)})"
    body += "; new entries are paused." if paused else "."
    if limit is not None and baseline is not None and last is not None:
        used = max(Decimal(0), baseline - last)
        body += f" Used {views.number(used, money=True)} of {views.number(limit, money=True)} {src.quote}."
    event = AlertEvent(
        id="risk:" + digest(src.key, day),
        cls="risk",
        severity="warning",
        title=clean_text(f"{src.tag} · Daily-loss rail", 100),
        body=clean_text(body, 300),
        deep_link=link("risk", src.bot_id),
        collapse_key="risk:" + digest(src.key, day),
        thread_id=_thread(src.bot_id, "fleet"),
        occurred_at=updated,
        bot=src.bot_id,
        bot_tag=src.tag,
        kind="daily_loss",
    )
    return Detection((event,), (key,))


# --------------------------------------------------------------------------- health


@dataclass(frozen=True)
class Condition:
    """One watched fault with confirmation and recovery delays (no flapping)."""

    key: str
    since: float  # first observation of the current run of bad (or good) readings
    open: bool = False
    clear_since: float | None = None  # first good reading while open

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "since": self.since,
            "open": self.open,
            "clear_since": self.clear_since,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Condition":
        return cls(
            str(raw["key"]),
            float(raw["since"]),
            bool(raw.get("open", False)),
            None if raw.get("clear_since") is None else float(raw["clear_since"]),
        )


def step_condition(
    previous: Condition | None,
    key: str,
    bad: bool,
    now: float,
    *,
    confirm_seconds: float,
    recover_seconds: float,
) -> tuple[Condition | None, str | None]:
    """Advance a condition by one observation. Returns (state, "opened"|"resolved"|None).

    A fault opens only after ``confirm_seconds`` of continuous bad readings; it
    resolves only after ``recover_seconds`` of continuous good readings. Callers
    skip the step when a reading is unavailable: a gap is not evidence either way.
    """
    if bad:
        if previous is None:
            previous = Condition(key, now)
        if previous.open:
            return Condition(key, previous.since, True, None), None
        if now - previous.since >= confirm_seconds:
            return Condition(key, previous.since, True, None), "opened"
        return previous, None
    if previous is None:
        return None, None
    if not previous.open:
        return None, None
    clear = previous.clear_since if previous.clear_since is not None else now
    if now - clear >= recover_seconds:
        return None, "resolved"
    return Condition(key, previous.since, True, clear), None


OFFLINE_STATES = frozenset(
    {"disconnected", "missing", "retained_only", "stale", "clock_skew"}
)
LIFECYCLE_STATES = frozenset(
    {
        "lifecycle_unavailable",
        "identity_mismatch",
        "identity_unverified",
        "identity_unavailable",
        "stopped",
        "starting",
        "stopping",
        "unknown",
    }
)


def native_status(payload: Any) -> Mapping[str, Any] | None:
    """The orchestration status object, tolerating a ``data`` envelope."""
    if not isinstance(payload, Mapping):
        return None
    inner = payload.get("data")
    if isinstance(inner, Mapping) and isinstance(inner.get("status"), str):
        return inner
    return payload if isinstance(payload.get("status"), str) else None


@dataclass(frozen=True)
class HealthThresholds:
    stale_seconds: float = 300.0  # owner runtime status older than this is stale
    confirm_seconds: float = 180.0  # a fault must persist this long before it alerts
    unreadable_seconds: float = 300.0
    recover_seconds: float = 120.0


_HEALTH_COPY = {
    "offline": ("Owner offline", "critical"),
    "lifecycle": ("Lifecycle invalid", "warning"),
    "stale": ("Status stale", "warning"),
    "unreadable": ("Data unavailable", "warning"),
}


def evaluate_health(
    src: SourceInfo,
    *,
    now: float,
    thresholds: HealthThresholds,
    runtime_payload: Any,
    runtime_ok: bool,
    status_payload: Any,
    conditions: Mapping[str, Condition],
) -> tuple[tuple[AlertEvent, ...], dict[str, Condition | None]]:
    """Health events and the new condition states (None means the condition cleared)."""
    changes: dict[str, Condition | None] = {}
    events: list[AlertEvent] = []

    def advance(code: str, bad: bool, confirm: float, detail: str) -> None:
        key = f"{src.key[:16]}:{code}"
        state, transition = step_condition(
            conditions.get(key),
            key,
            bad,
            now,
            confirm_seconds=confirm,
            recover_seconds=thresholds.recover_seconds,
        )
        if state != conditions.get(key):
            changes[key] = state
        if transition is None:
            return
        title, severity = _HEALTH_COPY[code]
        since = (state or conditions[key]).since
        collapse = "health:" + digest(src.key, code)
        opened = transition == "opened"
        events.append(
            AlertEvent(
                id=("health:" if opened else "health-ok:")
                + digest(src.key, code, since),
                cls="health",
                severity=severity if opened else "info",
                title=clean_text(
                    (
                        f"{src.tag} · {title}"
                        if opened
                        else f"{src.tag} · Recovered: {title}"
                    ),
                    100,
                ),
                body=clean_text(detail if opened else f"{title} cleared.", 300),
                deep_link=link("health", src.bot_id),
                collapse_key=collapse,
                thread_id=_thread(src.bot_id, "fleet"),
                occurred_at=now,
                bot=src.bot_id,
                bot_tag=src.tag,
                kind=code if opened else code + "_resolved",
            )
        )

    runtime = _runtime(runtime_payload) if runtime_ok else None
    if runtime is not None:
        updated = _epoch(runtime.get("updated_at"))
        # A future-dated source clock is not evidence of staleness.
        if updated is not None and now - updated >= -5:
            age = now - updated
            advance(
                "stale",
                age > thresholds.stale_seconds,
                thresholds.confirm_seconds,
                f"Owner status last updated {views.age(age)} ago.",
            )
    # A failed read is evidence of an unreadable source; an unreadable source must not
    # also be read as healthy or stale, so the other conditions are left untouched.
    advance(
        "unreadable",
        not runtime_ok,
        thresholds.unreadable_seconds,
        "Condor cannot read this bot's native status.",
    )
    status = native_status(status_payload)
    if status is not None:
        state = status["status"]
        reason = None
        lifecycle = status.get("lifecycle")
        if isinstance(lifecycle, Mapping) and isinstance(
            lifecycle.get("blocked_reason"), str
        ):
            reason = lifecycle["blocked_reason"]
        known = (
            state == "running" or state in OFFLINE_STATES or state in LIFECYCLE_STATES
        )
        if known:
            advance(
                "offline",
                state in OFFLINE_STATES,
                thresholds.confirm_seconds,
                f"Native status {state}: no fresh owner telemetry.",
            )
            advance(
                "lifecycle",
                state in LIFECYCLE_STATES,
                thresholds.confirm_seconds,
                f"Native status {state}" + (f" ({reason})." if reason else "."),
            )
    return tuple(events), changes


# --------------------------------------------------------------------------- incidents


def detect_incidents(
    store: Any,
    *,
    started: float,
    seen: Seen,
    min_severity: str = "critical",
    labels: Mapping[str, str] | None = None,
) -> Detection:
    """Open (and later recovered) host-monitor incidents.

    ``store`` is the ``incident_store`` object of the Operations workspace read.
    Only an available (fresh) store is acted on; a stale one is historical.
    Incidents first seen before activation, or below ``min_severity``, are
    recorded as seen and never announced. A recovery notification is sent only
    for an incident this worker announced, and replaces it (same collapse key).
    """
    if not isinstance(store, Mapping) or store.get("state") != "available":
        return Detection()
    incidents = store.get("incidents")
    if not isinstance(incidents, list):
        return Detection()
    floor = severity_rank(min_severity)
    events: list[AlertEvent] = []
    keys: list[str] = []
    for incident in incidents:
        if not isinstance(incident, Mapping):
            continue
        incident_id = incident.get("id")
        severity = incident.get("severity")
        first = _epoch(incident.get("first_seen_at"))
        if (
            not isinstance(incident_id, str)
            or not incident_id
            or severity not in {"critical", "warning"}
            or first is None
        ):
            continue
        service = clean_text(incident.get("service"), 40) or "stack"
        title = clean_text(incident.get("title"), 90)
        collapse = "incident:" + digest(incident_id)
        opened_key, skip_key, done_key = (
            "inc-open:" + incident_id,
            "inc-skip:" + incident_id,
            "inc-done:" + incident_id,
        )
        if incident.get("state") == "open":
            if seen(opened_key) or seen(skip_key):
                continue
            if first < started or severity_rank(severity) < floor:
                keys.append(skip_key)
                continue
            keys.append(opened_key)
            detail = clean_text(incident.get("detail"), 200)
            events.append(
                AlertEvent(
                    id="incident:" + digest(incident_id, "open"),
                    cls="incident",
                    severity="critical" if severity == "critical" else "warning",
                    title=clean_text(f"{service} · {title}" if title else service, 100),
                    body=clean_text(detail or "Host monitor opened an incident.", 300),
                    deep_link=link("operations"),
                    collapse_key=collapse,
                    thread_id="stack",
                    occurred_at=first,
                    kind="incident_open",
                )
            )
        elif (
            incident.get("state") == "resolved"
            and seen(opened_key)
            and not seen(done_key)
        ):
            keys.append(done_key)
            resolved = _epoch(incident.get("resolved_at")) or first
            events.append(
                AlertEvent(
                    id="incident:" + digest(incident_id, "resolved"),
                    cls="incident",
                    severity="info",
                    title=clean_text(f"{service} · Recovered", 100),
                    body=clean_text(f"{title or 'Incident'} resolved.", 300),
                    deep_link=link("operations"),
                    collapse_key=collapse,
                    thread_id="stack",
                    occurred_at=resolved,
                    kind="incident_resolved",
                )
            )
    return Detection(tuple(events), tuple(keys))


# --------------------------------------------------------------------------- summary


@dataclass(frozen=True)
class BotDay:
    tag: str
    quote: str
    fresh: bool
    pnl_day: Decimal | None
    held: int | None
    active: int | None
    wallet: Decimal | None = (
        None  # the owner's account wallet value, in ``wallet_currency``
    )
    wallet_currency: str | None = None


def summarize_bot(
    src: SourceInfo, payload: Any, *, now: float, stale_seconds: float
) -> BotDay:
    runtime = _runtime(payload)
    if runtime is None:
        return BotDay(src.tag, src.quote, False, None, None, None)
    updated = _epoch(runtime.get("updated_at"))
    fresh = updated is not None and 0 <= now - updated <= stale_seconds
    summary = (
        runtime.get("summary") if isinstance(runtime.get("summary"), Mapping) else {}
    )

    def count(name: str) -> int | None:
        value = views.decimal(summary.get(name))
        return (
            int(value)
            if value is not None and value >= 0 and value == int(value)
            else None
        )

    day = None
    daily = runtime.get("daily_entry_risk")
    if (
        fresh
        and isinstance(daily, Mapping)
        and day_number(daily.get("utc_day")) == _today_number(now)
    ):
        baseline = views.decimal(daily.get("baseline_quote"))
        last = views.decimal(daily.get("last_pnl_quote"))
        if baseline is not None and last is not None:
            day = last - baseline
    wallet = views.decimal(summary.get("balance_value_quote"))
    currency = summary.get("balance_value_currency")
    if (
        summary.get("balance_value_status") == "UNAVAILABLE"
        or wallet is None
        or wallet < 0
        or not isinstance(currency, str)
        or not currency.strip()
    ):
        wallet, currency = None, None
    return BotDay(
        src.tag,
        src.quote,
        fresh,
        day,
        count("positions_held_count"),
        count("active_executor_count"),
        wallet if fresh else None,
        clean_text(currency, 8) if wallet is not None and fresh else None,
    )


def fleet_summary(days: Sequence[BotDay], *, now: float) -> AlertEvent:
    """One daily event. Quote currencies are never mixed: a mixed total is UNAVAILABLE.

    The wallet value is the owner's account-wide balance, so bots that share an
    account report the same wallet. It is shown per bot and never summed.
    """
    if not days:
        raise ValueError("a summary needs at least one bot")
    date = _utc_day(now)
    lines = []
    for day in days:
        if not day.fresh:
            lines.append(f"{day.tag}: status unavailable")
            continue
        pnl = (
            f"{views.number(day.pnl_day, signed=True, money=True)} {day.quote} today"
            if day.pnl_day is not None
            else "day PnL unavailable"
        )
        held = "—" if day.held is None else str(day.held)
        active = "—" if day.active is None else str(day.active)
        line = f"{day.tag}: {pnl} · {held} held · {active} active"
        if day.wallet is not None:
            line += f" · wallet {views.number(day.wallet, money=True)} {day.wallet_currency}"
        lines.append(line)
    quotes = {d.quote for d in days}
    if all(d.fresh and d.pnl_day is not None for d in days) and len(quotes) == 1:
        total = sum((d.pnl_day for d in days), Decimal(0))
        lines.append(
            f"Fleet today: {views.number(total, signed=True, money=True)} {next(iter(quotes))}"
        )
    else:
        lines.append(
            "Fleet today: UNAVAILABLE (missing data or mixed quote currencies)"
        )
    return AlertEvent(
        id="summary:" + date,
        cls="summary",
        severity="info",
        title=f"Daily summary · {date}",
        body=clean_text("\n".join(lines), 600, multiline=True),
        deep_link=link("summary"),
        collapse_key="summary:daily",
        thread_id="summary",
        occurred_at=now,
        kind="summary",
    )


def summary_due(
    now: float,
    *,
    hour_utc: int,
    minute: int,
    last_date: str | None,
    grace_seconds: float = 6 * 3600,
) -> str | None:
    """The UTC date to summarize now, or None. Never emits a day twice or very late."""
    today = datetime.fromtimestamp(now, timezone.utc)
    scheduled = today.replace(
        hour=hour_utc, minute=minute, second=0, microsecond=0
    ).timestamp()
    date = _utc_day(now)
    if last_date == date or not 0 <= now - scheduled <= grace_seconds:
        return None
    return date


# --------------------------------------------------------------------------- market verdict

VERDICT_THRESHOLD = (
    0.25  # mirrors condor/frontend/src/features/market-picture/pulse.mjs
)
VERDICT_HOLD = 0.10
SMOOTHING_MINUTES = 15
VERDICT_LABELS = {"risk-on": "Risk-on", "risk-off": "Risk-off", "mixed": "Mixed"}


def next_verdict_state(previous: str | None, score: float) -> str:
    if score >= VERDICT_THRESHOLD:
        return "risk-on"
    if score <= -VERDICT_THRESHOLD:
        return "risk-off"
    if previous == "risk-on" and score > VERDICT_HOLD:
        return "risk-on"
    if previous == "risk-off" and score < -VERDICT_HOLD:
        return "risk-off"
    return "mixed"


def smoothed_score(
    samples: Iterable[tuple[float, float]],
    now: float,
    minutes: float = SMOOTHING_MINUTES,
) -> float | None:
    """Trailing mean of (epoch, score) samples inside the window; None when empty."""
    window = [
        s for t, s in samples if now - minutes * 60 < t <= now and math.isfinite(s)
    ]
    return sum(window) / len(window) if window else None


@dataclass(frozen=True)
class VerdictState:
    state: str | None = None
    last_extreme: str | None = None  # last Risk-on / Risk-off seen; the flip baseline


def step_verdict(
    previous: VerdictState, score: float | None, now: float
) -> tuple[VerdictState, AlertEvent | None]:
    """Advance the verdict; announce only a flip between the two extremes.

    The hold band keeps a state until the score crosses back through it, so the
    notification does not flap around the threshold. The first extreme observed
    is a baseline and is never announced.
    """
    if score is None or not math.isfinite(score):
        return previous, None
    state = next_verdict_state(previous.state, score)
    extreme = state if state in ("risk-on", "risk-off") else previous.last_extreme
    event = None
    if state in ("risk-on", "risk-off") and previous.last_extreme not in (None, state):
        event = AlertEvent(
            id="market:" + digest(state, int(now)),
            cls="market",
            severity="notice",
            title=f"Market verdict: {VERDICT_LABELS[state]}",
            body=clean_text(
                f"Flipped from {VERDICT_LABELS[previous.last_extreme]} to {VERDICT_LABELS[state]} "
                f"(score {score:+.2f}; enter ±{VERDICT_THRESHOLD:.2f}, hold ±{VERDICT_HOLD:.2f}).",
                300,
            ),
            deep_link=link("market"),
            collapse_key="market:verdict",
            thread_id="market",
            occurred_at=now,
            kind=state,
        )
    return VerdictState(state, extreme), event


# --------------------------------------------------------------------------- test alert


def make_test_event(request_id: str, *, now: float) -> AlertEvent:
    return AlertEvent(
        id="test:" + request_id,
        cls="test",
        severity="notice",
        title="RSIBOT test alert",
        body="Push delivery works. This was a test you requested; no action is needed.",
        deep_link=link("settings/push"),
        collapse_key="test:" + digest(request_id),
        thread_id="test",
        occurred_at=now,
        kind="test",
    )
