"""Pure, spot-only daily projection of the existing five-minute money record.

Money stays Decimal/text. Endpoints are the first and last *recorded* sample
inside the UTC day, including gap rows. We never substitute an earlier value.
"""

from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_EVEN, localcontext
from typing import Any

from .money import DAY_MS, DECIMAL, SLOT_MS

UNAVAILABLE = "UNAVAILABLE"
BOTS = ("v5", "helm")


def _value(row: dict, field: str) -> Decimal | None:
    value = row.get(field)
    if row.get("gap") or not isinstance(value, str) or not DECIMAL.fullmatch(value):
        return None
    return Decimal(value)


def daily_report(rows: list[dict], start_ms: int, end_ms: int, as_of_ms: int | None = None) -> list[dict[str, Any]]:
    """One row per UTC day per bot in [start_ms, end_ms), newest day first.

    Bounds must be UTC midnights. A missing day/bot still gets an explicit
    unavailable row. Duplicate samples count once for coverage; all samples
    still participate in endpoint selection. No process state or wall clock.
    """
    if any(type(bound) is not int or bound % DAY_MS for bound in (start_ms, end_ms)) or end_ms <= start_ms:
        raise ValueError("report bounds must be increasing UTC midnights in milliseconds")
    if as_of_ms is None:
        as_of_ms = end_ms
    if type(as_of_ms) is not int:
        raise ValueError("as_of_ms must be integer milliseconds")
    grouped: dict[tuple[int, str], list[dict]] = {}
    for row in rows:
        if (isinstance(row, dict) and row.get("bot") in BOTS
                and type(row.get("at_ms")) is int and start_ms <= row["at_ms"] < end_ms
                and row["at_ms"] <= as_of_ms):
            grouped.setdefault((row["at_ms"] // DAY_MS * DAY_MS, row["bot"]), []).append(row)
    out = []
    # Accepted source amounts have at most 18 integer and 30 fractional digits.
    # 120 digits covers subtraction and the percentage's 12-place rounding.
    with localcontext() as context:
        context.prec = 120
        for day in range(end_ms - DAY_MS, start_ms - 1, -DAY_MS):
            for bot in BOTS:
                samples = sorted(grouped.get((day, bot), []), key=lambda row: row["at_ms"])
                first, last = (samples[0], samples[-1]) if samples else ({}, {})
                slots = {(row["at_ms"] - day) // SLOT_MS for row in samples}
                gaps = sum(bool(row.get("gap")) for row in samples)
                values = {slot for row in samples if not row.get("gap")
                          and any(_value(row, field) is not None for field in ("equity", "realized", "unrealized", "fees"))
                          for slot in [(row["at_ms"] - day) // SLOT_MS]}
                partial = 0 not in slots or 287 not in slots or as_of_ms < day + DAY_MS
                fee_values = [_value(row, "fees") for row in samples if _value(row, "fees") is not None]
                counter_reset = any(b < a for a, b in zip(fee_values, fee_values[1:]))
                # A counter decrease is not a continuity test: resets can leave
                # fees flat or higher, and Helm has no fee counter at all.
                # Require the owner's accounting identity in EVERY sample, and
                # an identity established before this day (including boundary
                # resets). Historical/Helm rows without it stay unavailable.
                accounting_since = first.get("accounting_since_ms")
                accounting_continuity = (
                    type(accounting_since) is int and 0 <= accounting_since < day
                    and all(type(row.get("accounting_since_ms")) is int
                            and row["accounting_since_ms"] == accounting_since
                            and not row.get("gap") for row in samples)
                )
                unit = first.get("unit")
                stable_unit = (bool(samples) and isinstance(unit, str) and bool(unit)
                               and all(row.get("unit") == unit for row in samples if not row.get("gap")))
                unit_changed = len({row["unit"] for row in samples
                                    if isinstance(row.get("unit"), str)}) > 1

                def endpoint(row: dict, field: str) -> str:
                    value = _value(row, field)
                    return format(value, "f") if value is not None and not unit_changed else UNAVAILABLE

                def delta(field: str) -> str:
                    start, end = _value(first, field), _value(last, field)
                    if len(samples) < 2 or first["at_ms"] == last["at_ms"] or start is None or end is None or unit_changed:
                        return UNAVAILABLE
                    # A decreasing cumulative fee counter invalidates lifetime
                    # PnL/fee differences even if the counter later catches up.
                    if field in ("fees", "realized") and (not accounting_continuity or counter_reset):
                        return UNAVAILABLE
                    return format(end - start, "f")

                change = delta("equity")
                start = _value(first, "equity")
                change_pct = UNAVAILABLE
                if change != UNAVAILABLE and start is not None and start > 0:
                    change_pct = format((Decimal(change) * 100 / start).quantize(
                        Decimal("0.000000000001"), rounding=ROUND_HALF_EVEN), "f")
                reasons = sorted({str(row["gap"]) for row in samples if row.get("gap")})
                note = (f"{len(slots)}/288 slots present; {len(values)}/288 with values; "
                        f"{288 - len(slots)} missing slots; {gaps} gap samples; "
                        f"{len(samples) - len(slots)} duplicate-slot samples; "
                        f"{'partial day' if partial else 'day boundary slots present'}")
                if reasons:
                    note += "; " + "; ".join(reasons)
                if unit_changed:
                    note += "; unit changed: amounts unavailable"
                if not accounting_continuity:
                    note += "; accounting continuity unverified: realized PnL and fees unavailable"
                if counter_reset:
                    note += "; cumulative fees decreased: possible owner reset; realized PnL and fees unavailable"
                # The record has no cash, held value, or execution counts. Never
                # derive these from equity/PnL or confuse samples with fills.
                out.append({
                    "day": day, "date": datetime.fromtimestamp(day // 1000, timezone.utc).date().isoformat(),
                    "bot": bot, "unit": unit if stable_unit else UNAVAILABLE,
                    "first_at_ms": first.get("at_ms"), "last_at_ms": last.get("at_ms"),
                    "equity_start": endpoint(first, "equity"), "equity_end": endpoint(last, "equity"),
                    "equity_change": change, "equity_change_pct": change_pct,
                    "realized_pnl": delta("realized"), "fees": delta("fees"),
                    "unrealized_pnl_end": endpoint(last, "unrealized"),
                    "buys": UNAVAILABLE, "sells": UNAVAILABLE, "fills": UNAVAILABLE,
                    "cash_end": UNAVAILABLE, "held_value_end": UNAVAILABLE,
                    "samples": len(samples), "expected_samples": 288, "present_slots": len(slots),
                    "value_slots": len(values), "missing_slots": 288 - len(slots), "gaps": gaps,
                    "partial": partial, "data_quality": note,
                })
    return out
