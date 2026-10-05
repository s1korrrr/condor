"""Fleet PnL windows from saved native performance history, computed once on the server.

Port of ``frontend/src/features/quant-ops/fleet-performance.ts`` (``parseBotHistory``,
``botWindow``, ``fleetWindow``) and the validation half of
``frontend/src/features/quant-ops/performance-history.ts`` (``projectPerformanceHistory``).
Semantics are identical and deposit independent:

* every bot reports its own cumulative PnL, so the fleet change over a window is the SUM of
  per-bot changes, never a wallet difference;
* a bot's change is the sum of its within-owner-run steps. An owner run is the stretch between
  two boot-identity changes, so a restart is a boundary and never a delta. Rows rebuilt from the
  bot's own recorder (segment ``backfill-<bot>``) join their live neighbours without an owner
  boundary, because native PnL is cumulative across restarts;
* the first sample inside the window is the baseline. A bot whose history starts after the
  window opens contributes from its first sample (``partial``), never an invented opening value;
* a bot without a usable history is listed in ``missing`` with a reason code, and the totals say
  how many bots they cover. Quotes never mix: the most common quote wins, others are named missing.

Sums use ``Decimal`` (the stored values are decimal strings). The browser sums floats, so the
two agree to about 1e-9 on real data and exactly on the shared fixtures
(``tests/fixtures/fleet_summary/performance_cases.json``).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from condor.performance_history import PERFORMANCE_BUCKETS

RANGE_SPAN_MS = {"1D": 86_400_000, "1W": 7 * 86_400_000, "1M": 30 * 86_400_000}
WINDOWS = (("day", "1D"), ("week", "1W"), ("month", "1M"))
WINDOW_SPAN_MS = {name: RANGE_SPAN_MS[range_] for name, range_ in WINDOWS}
SAMPLE_GAP_MS = 90_000
QUOTE = re.compile(r"^[A-Z0-9]+$")

# Reason codes. Human text lives in the contract document, never in the payload.
NO_SAMPLES = "NO_SAMPLES"
HISTORY_INVALID = "HISTORY_INVALID"
HISTORY_READ_FAILED = "HISTORY_READ_FAILED"
NEEDS_TWO_SAMPLES = "NEEDS_TWO_SAMPLES"
QUOTE_MISMATCH = "QUOTE_MISMATCH"
NOT_READ = "NOT_READ"


def _amount(value: Any) -> Optional[Decimal]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        number = Decimal(value)
    except InvalidOperation:
        return None
    return number if number.is_finite() else None


def _is_backfill(point: dict) -> bool:
    return str(point.get("segment", "")).startswith("backfill-")


@dataclass(frozen=True)
class Sample:
    time: float  # epoch milliseconds
    total: Decimal
    realized: Decimal
    unrealized: Decimal
    owner: int


@dataclass
class BotHistory:
    bot: str
    range: str
    quote: Optional[str] = None
    samples: list[Sample] = field(default_factory=list)
    gap_ms: float = SAMPLE_GAP_MS
    bucket_seconds: Optional[int] = None
    truncated: bool = False
    reason: Optional[str] = None


def gap_ms(bucket_seconds: Optional[int]) -> float:
    """Longest spacing inside one segment: native samples are at most 90s apart, a bucketed read adds its width."""
    return SAMPLE_GAP_MS + (bucket_seconds or 0) * 1000


def parse_bot_history(
    payload: Any, bot: str, range_: str, now_ms: float, failed: bool = False
) -> BotHistory:
    """Validate one ``performance-history`` read and keep numeric samples with their owner run.

    ``now_ms`` is the clock the future-sample check uses (the browser adds 5s of slack for the
    observer's newest sample leading a polled clock; callers pass that adjusted clock).
    """
    if failed:
        return BotHistory(bot, range_, reason=HISTORY_READ_FAILED)

    def empty(reason: str, bucket: Optional[int] = None) -> BotHistory:
        return BotHistory(bot, range_, reason=reason, gap_ms=gap_ms(bucket))

    if not isinstance(payload, dict):
        return empty(NOT_READ)
    bucket = payload.get("bucket_seconds")
    valid_bucket = bucket is None or (
        range_ in PERFORMANCE_BUCKETS and bucket == PERFORMANCE_BUCKETS[range_]
    )
    rows = payload.get("points")
    if (
        payload.get("source") != "native_mqtt_observer"
        or payload.get("bot_name") != bot
        or payload.get("range") != range_
        or not valid_bucket
        or not isinstance(rows, list)
    ):
        return empty(HISTORY_INVALID)
    spacing = gap_ms(bucket)
    if not rows:
        return empty(NO_SAMPLES, bucket)
    samples: list[Sample] = []
    owner = 0
    previous: Optional[dict] = None
    quote = rows[0].get("quote") if isinstance(rows[0], dict) else None
    for point in rows:
        if not isinstance(point, dict):
            return empty(HISTORY_INVALID, bucket)
        stamp = point.get("timestamp")
        total, realized, unrealized = (
            _amount(point.get(k))
            for k in ("total_pnl_quote", "realized_pnl_quote", "unrealized_pnl_quote")
        )
        point_quote = point.get("quote")
        if (
            not isinstance(stamp, (int, float))
            or isinstance(stamp, bool)
            or not math.isfinite(stamp)
            or stamp <= 0
            or stamp * 1000 > now_ms
            or total is None
            or realized is None
            or unrealized is None
            or abs(total - realized - unrealized) > Decimal("0.000001")
            or not isinstance(point.get("identity"), str)
            or not point["identity"]
            or not isinstance(point.get("segment"), str)
            or not point["segment"]
            or not isinstance(point_quote, str)
            or not QUOTE.fullmatch(point_quote)
            or point_quote != quote
            or (previous is not None and stamp <= previous["timestamp"])
        ):
            return empty(HISTORY_INVALID, bucket)
        bridged = previous is not None and (
            _is_backfill(previous) or _is_backfill(point)
        )
        if (
            previous is not None
            and previous["identity"] != point["identity"]
            and not bridged
        ):
            owner += 1
        samples.append(Sample(stamp * 1000, total, realized, unrealized, owner))
        previous = point
    return BotHistory(
        bot,
        range_,
        quote=quote,
        samples=samples,
        gap_ms=spacing,
        bucket_seconds=bucket,
        truncated=payload.get("truncated") is True,
    )


def _run_deltas(samples: list[Sample]) -> tuple[Decimal, Decimal, Decimal, int]:
    total = realized = unrealized = Decimal(0)
    restarts = 0
    for a, b in zip(samples, samples[1:]):
        if a.owner != b.owner:
            restarts += 1
            continue
        total += b.total - a.total
        realized += b.realized - a.realized
        unrealized += b.unrealized - a.unrealized
    return total, realized, unrealized, restarts


@dataclass
class BotWindow:
    bot: str
    quote: Optional[str]
    change: Optional[Decimal]
    realized: Optional[Decimal]
    unrealized: Optional[Decimal]
    first_at: Optional[float]
    last_at: Optional[float]
    samples: int
    restarts: int
    full: bool
    stale: bool
    # Time between consecutive samples inside the window beyond the read's spacing: summed across, not observed.
    uncovered_ms: float = 0.0


def bot_window(
    history: BotHistory, from_ms: float, to_ms: float, now_ms: float
) -> BotWindow:
    """One bot's change over [from, to]. ``change`` is None until two samples exist inside the window."""
    inside = [s for s in history.samples if from_ms <= s.time <= to_ms]
    first = inside[0] if inside else None
    last = inside[-1] if inside else None
    deltas = _run_deltas(inside) if len(inside) >= 2 else None
    return BotWindow(
        bot=history.bot,
        quote=history.quote,
        change=deltas[0] if deltas else None,
        realized=deltas[1] if deltas else None,
        unrealized=deltas[2] if deltas else None,
        first_at=first.time if first else None,
        last_at=last.time if last else None,
        samples=len(inside),
        restarts=deltas[3] if deltas else 0,
        full=first is not None and first.time <= from_ms + history.gap_ms,
        stale=last is None or now_ms - last.time > history.gap_ms + SAMPLE_GAP_MS,
        uncovered_ms=sum(
            later.time - earlier.time
            for earlier, later in zip(inside, inside[1:])
            if later.time - earlier.time > history.gap_ms
        ),
    )


@dataclass
class FleetWindow:
    from_ms: float
    to_ms: float
    quote: Optional[str]
    total: Optional[Decimal]
    realized: Optional[Decimal]
    unrealized: Optional[Decimal]
    bots: list[BotWindow]
    counted: int
    expected: int
    missing: list[dict]
    since: Optional[float]
    partial: bool
    full_bots: int
    latest_at: Optional[float]
    # Counted bots whose window contains an unrecorded stretch longer than their sample spacing.
    gaps: list[dict] = field(default_factory=list)

    @property
    def stale(self) -> bool:
        """True when every counted bot's newest sample is older than its read spacing plus 90s."""
        return bool(self.bots) and all(b.stale for b in self.bots)


def fleet_window(
    histories: list[BotHistory],
    bots: list[str],
    from_ms: float,
    to_ms: float,
    now_ms: float,
) -> FleetWindow:
    """Sum of per-bot changes over [from, to]. Quotes never mix: the most common quote wins."""
    missing: list[dict] = []
    windows: list[BotWindow] = []
    by_bot = {h.bot: h for h in histories}
    for bot in bots:
        history = by_bot.get(bot)
        if history is None:
            missing.append({"bot": bot, "reason": NOT_READ})
            continue
        if not history.samples:
            missing.append({"bot": bot, "reason": history.reason or NO_SAMPLES})
            continue
        window = bot_window(history, from_ms, to_ms, now_ms)
        if window.change is None:
            missing.append(
                {"bot": bot, "reason": NEEDS_TWO_SAMPLES, "samples": window.samples}
            )
            continue
        windows.append(window)
    counts: dict[str, int] = {}
    for window in windows:
        if window.quote:
            counts[window.quote] = counts.get(window.quote, 0) + 1
    quote: Optional[str] = None
    best = 0
    for (
        candidate,
        count,
    ) in counts.items():  # insertion order: the first seen wins a tie
        if count > best:
            quote, best = candidate, count
    counted = []
    for window in windows:
        if window.quote == quote:
            counted.append(window)
        else:
            missing.append(
                {"bot": window.bot, "reason": QUOTE_MISMATCH, "quote": window.quote}
            )
    order = {bot: index for index, bot in enumerate(bots)}
    missing.sort(key=lambda item: order.get(item["bot"], 0))

    def total(key: str) -> Optional[Decimal]:
        if not counted:
            return None
        result = Decimal(0)
        for window in counted:
            result += getattr(window, key) or Decimal(0)
        return result

    return FleetWindow(
        from_ms=from_ms,
        to_ms=to_ms,
        quote=quote,
        total=total("change"),
        realized=total("realized"),
        unrealized=total("unrealized"),
        bots=counted,
        counted=len(counted),
        expected=len(bots),
        missing=missing,
        since=min(w.first_at for w in counted) if counted else None,
        partial=any(not w.full for w in counted),
        full_bots=sum(1 for w in counted if w.full),
        latest_at=max(w.last_at for w in counted) if counted else None,
        gaps=[
            {"bot": w.bot, "uncovered_ms": round(w.uncovered_ms)}
            for w in counted
            if w.uncovered_ms > 0
        ],
    )


def decimal_text(value: Optional[Decimal]) -> Optional[str]:
    """Plain decimal string: no exponent, no trailing zeros, no negative zero."""
    if value is None:
        return None
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _ms(value: Optional[float]) -> Optional[int]:
    return None if value is None else int(round(value))


def window_payload(
    window: FleetWindow, *, span_ms: Optional[int], detail: bool
) -> dict:
    """Contract shape of one fleet window (see docs/reference/fleet-summary-v1.md).

    The window bounds are not emitted: a rolling window ends at ``generated_at_ms`` and starts ``span_ms``
    earlier, and putting a moving clock in the body would change its ETag on every request. ``span_ms`` is
    ``None`` for the ``all`` window, which opens at ``since_ms`` of the bounded ALL read.
    """
    payload: dict[str, Any] = {
        "span_ms": span_ms,
        "unit": window.quote,
        "total": decimal_text(window.total),
        "realized": decimal_text(window.realized),
        "unrealized": decimal_text(window.unrealized),
        "counted": window.counted,
        "expected": window.expected,
        "partial": window.partial,
        "since_ms": _ms(window.since),
        "latest_at_ms": _ms(window.latest_at),
        "stale": window.stale,
        "missing": window.missing,
        # Unrecorded time inside this window, summed over counted bots (both views; `gaps` names the bots).
        "uncovered_ms": round(sum(gap["uncovered_ms"] for gap in window.gaps)),
    }
    if detail:
        payload["bots"] = [
            {
                "bot": w.bot,
                "change": decimal_text(w.change),
                "realized": decimal_text(w.realized),
                "unrealized": decimal_text(w.unrealized),
                "first_at_ms": _ms(w.first_at),
                "last_at_ms": _ms(w.last_at),
                "samples": w.samples,
                "restarts": w.restarts,
                "full": w.full,
                "stale": w.stale,
                "uncovered_ms": round(w.uncovered_ms),
            }
            for w in window.bots
        ]
        payload["gaps"] = window.gaps
    return payload


def compute_windows(
    histories_by_range: dict[str, list[BotHistory]], bots: list[str], now_ms: float
) -> dict[str, FleetWindow]:
    """The four fleet windows. ``histories_by_range`` maps '1D'/'1W'/'1M'/'ALL' to one history per bot.

    ``day``/``week``/``month`` are trailing 24h / 7d / 30d from ``now_ms``; ``all`` runs from the earliest
    first sample of the bounded ALL read (one year of retention) to ``now_ms``.
    """
    clock = now_ms + 5_000
    result = {}
    for name, range_ in WINDOWS:
        result[name] = fleet_window(
            histories_by_range.get(range_, []),
            bots,
            now_ms - RANGE_SPAN_MS[range_],
            now_ms,
            clock,
        )
    all_histories = histories_by_range.get("ALL", [])
    starts = [h.samples[0].time for h in all_histories if h.samples]
    result["all"] = fleet_window(
        all_histories, bots, min(starts) if starts else now_ms, now_ms, clock
    )
    return result
