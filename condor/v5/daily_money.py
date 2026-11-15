"""Pure, spot-only daily projection of the existing five-minute money record.

Money stays Decimal/text. Endpoints are the first and last *recorded* sample
inside the UTC day, including gap rows. We never substitute an earlier value.
"""

from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_EVEN, localcontext
from typing import Any

from .money import DAY_MS, DECIMAL, SLOT_MS, common_unit

UNAVAILABLE = "UNAVAILABLE"
BOTS = ("v5", "helm")
COUNTER_UNAVAILABLE_REASON = (
    "realized PnL and fees unavailable: owner provides neither restore-aware "
    "accounting lineage nor authoritative interval totals"
)


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
                # accounting_since_ms is the minimum retained fill timestamp
                # (engine ee8ca6ad), not restore-aware accounting lineage. A
                # restore can preserve it while replacement fees catch up.
                # Neither bot's record carries a sufficient owner contract for
                # daily counter deltas, so do not infer them from any counters.
                unit = common_unit(samples)
                stable_unit = unit is not None
                unit_changed = len({row["unit"] for row in samples
                                    if isinstance(row.get("unit"), str) and row["unit"].strip()}) > 1

                def endpoint(row: dict, field: str) -> str:
                    value = _value(row, field)
                    return format(value, "f") if value is not None and not unit_changed else UNAVAILABLE

                change = UNAVAILABLE
                start, end = _value(first, "equity"), _value(last, "equity")
                if (stable_unit and len(samples) > 1 and first["at_ms"] != last["at_ms"]
                        and start is not None and end is not None):
                    change = format(end - start, "f")
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
                elif not stable_unit:
                    note += "; unit missing or blank in sample: monetary deltas unavailable"
                note += "; " + COUNTER_UNAVAILABLE_REASON
                # The record has no cash, held value, or execution counts. Never
                # derive these from equity/PnL or confuse samples with fills.
                out.append({
                    "day": day, "date": datetime.fromtimestamp(day // 1000, timezone.utc).date().isoformat(),
                    "bot": bot, "unit": unit if stable_unit else UNAVAILABLE,
                    "first_at_ms": first.get("at_ms"), "last_at_ms": last.get("at_ms"),
                    "equity_start": endpoint(first, "equity"), "equity_end": endpoint(last, "equity"),
                    "equity_change": change, "equity_change_pct": change_pct,
                    "realized_pnl": UNAVAILABLE, "fees": UNAVAILABLE,
                    "unrealized_pnl_end": endpoint(last, "unrealized"),
                    "buys": UNAVAILABLE, "sells": UNAVAILABLE, "fills": UNAVAILABLE,
                    "cash_end": UNAVAILABLE, "held_value_end": UNAVAILABLE,
                    "samples": len(samples), "expected_samples": 288, "present_slots": len(slots),
                    "value_slots": len(values), "missing_slots": 288 - len(slots), "gaps": gaps,
                    "partial": partial, "data_quality": note,
                })
    return out
