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
from decimal import Decimal, DecimalException, Inexact, InvalidOperation, localcontext
from typing import Any, Optional

from condor.fleet_identity import is_paper
from condor.performance_history import PERFORMANCE_BUCKETS

RANGE_SPAN_MS = {"1D": 86_400_000, "1W": 7 * 86_400_000, "1M": 30 * 86_400_000}
WINDOWS = (("day", "1D"), ("week", "1W"), ("month", "1M"))
WINDOW_SPAN_MS = {name: RANGE_SPAN_MS[range_] for name, range_ in WINDOWS}
SAMPLE_GAP_MS = 90_000
QUOTE = re.compile(r"^[A-Z0-9]+$")
ASCII_DECIMAL = re.compile(
    r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z"
)
# A bounded wire representation keeps one admitted amount within the 8 KiB glance budget.
MAX_DECIMAL_INPUT_CHARS = 256
MAX_DECIMAL_TEXT_CHARS = 128
MAX_DECIMAL_SIGNIFICANT_DIGITS = 38

# Reason codes. Human text lives in the contract document, never in the payload.
NO_SAMPLES = "NO_SAMPLES"
HISTORY_INVALID = "HISTORY_INVALID"
HISTORY_READ_FAILED = "HISTORY_READ_FAILED"
NEEDS_TWO_SAMPLES = "NEEDS_TWO_SAMPLES"
QUOTE_MISMATCH = "QUOTE_MISMATCH"
NOT_READ = "NOT_READ"


def _amount(value: Any) -> Optional[Decimal]:
    if (
        not isinstance(value, str)
        or len(value) > MAX_DECIMAL_INPUT_CHARS
        or not ASCII_DECIMAL.fullmatch(value)
    ):
        return None
    # A zero coefficient has no scale. Parsing its arbitrarily long exponent is
    # unnecessary and can exceed Decimal's implementation exponent range.
    coefficient = re.split(r"[eE]", value, maxsplit=1)[0]
    if not any(digit in "123456789" for digit in coefficient):
        return Decimal(0)
    try:
        number = Decimal(value)
    except InvalidOperation:
        return None
    return number if decimal_text(number) is not None else None


def exact_sum(values: list[Decimal], *, admitted: bool = False) -> Optional[Decimal]:
    """Add admitted decimals without default-context rounding; reject an unencodable result.

    ``admitted=True`` declares every operand already passed ``_amount`` (or is a sign reversal of one),
    so only the result is checked; the operand check is skipped, not weakened.
    """
    if not values:
        return Decimal(0)
    # A temporary sign reversal of an admitted positive 128-digit operand can use
    # 129 characters. Only the emitted result must fit the signed wire budget.
    if not admitted and any(decimal_text(value.copy_abs()) is None for value in values):
        return None
    nonzero = [value for value in values if value]
    if not nonzero:
        return Decimal(0)
    # Decimal zero can carry an arbitrary exponent without affecting the sum.
    low = min(value.as_tuple().exponent for value in nonzero)
    high = max(value.adjusted() for value in nonzero)
    try:
        with localcontext() as context:
            context.prec = max(28, high - low + 3 + len(str(len(values))))
            context.traps[Inexact] = True
            result = sum(values, Decimal(0))
    except (DecimalException, ValueError):
        return None
    return result if decimal_text(result) is not None else None


def exact_difference(later: Decimal, earlier: Decimal) -> Optional[Decimal]:
    return exact_sum([later, earlier.copy_negate()])


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
    # A paper bot's history is simulated and recorded from reporting; a live bot's is native. Never crossed.
    paper = is_paper(bot)
    expected_source = "reporting_paper_runtime" if paper else "native_mqtt_observer"
    if (
        payload.get("source") != expected_source
        or (paper and payload.get("simulated") is not True)
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
            or (
                residual := exact_sum(
                    # all three passed ``_amount`` just above
                    [total, realized.copy_negate(), unrealized.copy_negate()],
                    admitted=True,
                )
            )
            is None
            or residual.copy_abs() > Decimal("0.000001")
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


def _run_deltas_per_pair(
    samples: list[Sample],
) -> Optional[tuple[Decimal, Decimal, Decimal, int]]:
    """The reference accumulation: every same-owner pair's delta, each delta and running total checked."""
    totals = [Decimal(0), Decimal(0), Decimal(0)]
    restarts = 0
    for a, b in zip(samples, samples[1:]):
        if a.owner != b.owner:
            restarts += 1
            continue
        for index, key in enumerate(("total", "realized", "unrealized")):
            delta = exact_difference(getattr(b, key), getattr(a, key))
            updated = exact_sum([totals[index], delta]) if delta is not None else None
            if updated is None:
                return None
            totals[index] = updated
    return totals[0], totals[1], totals[2], restarts


def _intermediates_representable(samples: list[Sample], runs: int) -> bool:
    """Whether every value the per-pair accumulation checks is provably representable.

    Each pair delta and running total is an integer multiple of ``10**low`` (the lowest exponent of any
    nonzero sample) with magnitude below ``2 * runs * 10**(high + 1)`` (``high`` the largest adjusted
    exponent): a running total is a sum of at most ``runs`` differences of two samples. When that bound
    fits ``decimal_text``'s digit and width budgets (and float range), no per-pair check can fail, so
    one exact difference per owner run gives exactly the per-pair result.
    """
    low = high = None
    for sample in samples:
        for value in (sample.total, sample.realized, sample.unrealized):
            if value:
                exponent, adjusted = value.as_tuple().exponent, value.adjusted()
                low = exponent if low is None or exponent < low else low
                high = adjusted if high is None or adjusted > high else high
    if low is None:
        return True  # every sample is zero
    top = high + 1 + len(str(2 * runs))  # |intermediate| < 10**top
    width = 1 + max(top, top - low + 1, 2 - low)
    return (
        top - low <= MAX_DECIMAL_SIGNIFICANT_DIGITS
        and width <= MAX_DECIMAL_TEXT_CHARS
        and -300 <= low
        and top <= 300
    )


def _run_deltas(
    samples: list[Sample],
) -> Optional[tuple[Decimal, Decimal, Decimal, int]]:
    """Change across the samples, summed per owner run; an owner change (restart) is never bridged.

    Admission is exactly the per-pair accumulation's (``_run_deltas_per_pair``). Inside one run the
    consecutive deltas telescope exactly (the arithmetic is exact, ``Inexact`` is trapped), so when the
    representability bound holds a run contributes one exact ``last - first``. That replaces per-pair
    arithmetic that held the event loop for seconds on month and all-time windows. Near the digit or
    width boundary the per-pair path runs instead, so an intermediate the old code rejected is still
    rejected.
    """
    boundaries = [
        end
        for end in range(1, len(samples))
        if samples[end].owner != samples[end - 1].owner
    ]
    if not _intermediates_representable(samples, len(boundaries) + 1):
        return _run_deltas_per_pair(samples)
    totals = [Decimal(0), Decimal(0), Decimal(0)]
    start = 0
    for end in [*boundaries, len(samples)]:
        if end - start >= 2:
            first, last = samples[start], samples[end - 1]
            for index, key in enumerate(("total", "realized", "unrealized")):
                delta = exact_difference(getattr(last, key), getattr(first, key))
                updated = (
                    exact_sum([totals[index], delta]) if delta is not None else None
                )
                if updated is None:
                    return None
                totals[index] = updated
        start = end
    return totals[0], totals[1], totals[2], len(boundaries)


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
    numeric_invalid: bool = False


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
        numeric_invalid=len(inside) >= 2 and deltas is None,
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
                {
                    "bot": bot,
                    "reason": (
                        HISTORY_INVALID if window.numeric_invalid else NEEDS_TWO_SAMPLES
                    ),
                    "samples": window.samples,
                }
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

    totals = [
        exact_sum([getattr(window, key) for window in counted]) if counted else None
        for key in ("change", "realized", "unrealized")
    ]
    if counted and any(total is None for total in totals):
        missing.extend(
            {"bot": window.bot, "reason": HISTORY_INVALID} for window in counted
        )
        missing.sort(key=lambda item: order.get(item["bot"], 0))
        counted = []
        totals = [None, None, None]

    return FleetWindow(
        from_ms=from_ms,
        to_ms=to_ms,
        quote=quote,
        total=totals[0],
        realized=totals[1],
        unrealized=totals[2],
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
    if value is None or not value.is_finite():
        return None
    if not value:
        return "0"
    digits, exponent = value.as_tuple().digits, value.as_tuple().exponent
    trailing = 0
    while trailing < len(digits) - 1 and digits[-1 - trailing] == 0:
        trailing += 1
    significant = len(digits) - trailing
    if significant > MAX_DECIMAL_SIGNIFICANT_DIGITS:
        return None
    exponent += trailing
    point = significant + exponent
    width = (1 if value.is_signed() else 0) + (
        point
        if point >= significant
        else significant + 1 if point > 0 else 2 - point + significant
    )
    if width > MAX_DECIMAL_TEXT_CHARS:
        return None
    try:
        converted = float(value)
    except (OverflowError, ValueError):
        return None
    if not math.isfinite(converted) or converted == 0:
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
