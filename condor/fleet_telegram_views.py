"""Pure, bounded Telegram HTML views for native read-only fleet snapshots."""

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from html import escape
import math
import re
import time

PAGE_SIZE = 5
TITLES = {
    "status": "📊 Status",
    "orders": "📋 Orders",
    "fills": "💱 Fills",
    "executors": "⚙️ Executors",
    "help": "❔ Help",
    "start": "👋 Welcome",
}


@dataclass(frozen=True)
class View:
    text: str
    page: int = 0
    pages: int = 1


def clean(value, limit=80):
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return "—"
    return escape(" ".join(str(value).split())[:limit]) or "—"


def decimal(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = Decimal(str(value))
        return result if result.is_finite() and abs(result) < Decimal("1e30") else None
    except (InvalidOperation, ValueError):
        return None


def number(value, signed=False, money=False, precision=8):
    value = decimal(value)
    if value is None:
        return "—"
    places = 2 if money else precision
    if value and abs(value) < Decimal(10) ** -places:
        return f"{value:+.2E}" if signed else f"{value:.2E}"
    result = f"{value:+,.{places}f}" if signed else f"{value:,.{places}f}"
    if not money:
        result = result.rstrip("0").rstrip(".")
    return result


def stamp(value):
    if isinstance(value, bool):
        raise ValueError("invalid timestamp")
    try:
        result = float(value)
    except (ValueError, TypeError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            result = parsed.timestamp()
        except (ValueError, AttributeError, TypeError, OverflowError):
            raise ValueError("invalid timestamp") from None
    if not math.isfinite(result):
        raise ValueError("invalid timestamp")
    return result


def when(value):
    try:
        return datetime.fromtimestamp(stamp(value), timezone.utc).strftime(
            "%d %b %H:%M UTC"
        )
    except (ValueError, OverflowError, OSError):
        return "Time unavailable"


def age(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60}s"
    return f"{seconds // 3600}h {(seconds % 3600) // 60}m"


def status(payload, currency="quote"):
    runtime = payload.get("runtime_status")
    if not isinstance(runtime, dict):
        raise ValueError("native API response did not contain runtime_status")
    elapsed = time.time() - stamp(runtime.get("updated_at"))
    freshness = (
        "⚠️ Clock mismatch — source time is in the future"
        if elapsed < -5
        else (
            f"⚠️ Stale snapshot · {age(elapsed)} old"
            if elapsed > 60
            else f"🟢 Updated {age(elapsed)} ago"
        )
    )
    mode = {"live": "Live trading", "paper": "Paper trading"}.get(
        payload.get("execution_mode"), "Mode unavailable"
    )
    summary = runtime.get("summary")
    summary = summary if isinstance(summary, dict) else {}

    def count(key):
        value = decimal(summary.get(key))
        return (
            number(value)
            if value is not None and value >= 0 and value == int(value)
            else "—"
        )

    lines = [
        f"<b>{mode}</b> · {freshness}",
        "",
        "<b>Activity</b>",
        f"📋 Active orders: <b>{number(runtime.get('active_orders_count'))}</b>",
        f"⚙️ Active executors: <b>{count('active_executor_count')}</b>",
        f"📦 Held-position records: <b>{count('positions_held_count')}</b>",
        f"🎛 Controllers: <b>{count('controller_count')}</b>",
        "",
        "<b>Strategy PnL</b>",
    ]
    currency = clean(currency, 16)
    if summary.get("pnl_available") is True:
        for label, key, signed in [
            ("Net", "net_pnl_quote", True),
            ("Realized", "realized_pnl_quote", True),
            ("Unrealized", "unrealized_pnl_quote", True),
            ("Fees", "fees_quote", False),
        ]:
            value = number(summary.get(key), signed=signed, money=True)
            lines.append(
                f"{label}: <b>{value} {currency}</b>"
                if value != "—"
                else f"{label}: unavailable"
            )
    else:
        lines.append("— PnL unavailable · accounting basis is not confirmed")
    parity = payload.get("runtime_parity")
    if (
        not isinstance(parity, dict)
        or parity.get("runtime_status_available") is not True
        or not isinstance(parity.get("mismatches"), list)
    ):
        reconciliation = "⚪ Reconciliation unavailable"
    elif parity["mismatches"]:
        reconciliation = (
            f"⚠️ Reconciliation: {len(parity['mismatches'])} reported mismatch(es)"
        )
    else:
        reconciliation = "✅ No reported mismatches"
    lines += [
        "",
        reconciliation,
        "<i>Executors and held records may overlap; counts are not additive.</i>",
    ]
    return "\n".join(lines)


def records(command, rows, page=0):
    pages = max(1, math.ceil(len(rows) / PAGE_SIZE))
    page = min(max(page, 0), pages - 1)
    if not rows:
        empty = {
            "orders": "No order history returned",
            "fills": "No fills returned",
            "executors": "No executor records returned",
        }[command]
        return View(
            f"📭 {empty}.\n<i>This is a history view, not an account balance.</i>"
        )
    start = page * PAGE_SIZE
    lines = [
        f"<i>Recent history · {start + 1}–{min(start + PAGE_SIZE, len(rows))} of {len(rows)} returned records</i>"
    ]
    for row in rows[start : start + PAGE_SIZE]:
        raw_pair = row.get("pair") or row.get("trading_pair") or "—"
        raw_pair = raw_pair if isinstance(raw_pair, str) else "—"
        base, _, quote = raw_pair.rpartition("-")
        base, quote = clean(base, 16), clean(quote, 16)
        side = str(row.get("side") or "").lower()
        direction = {"buy": "🟢 BUY", "sell": "🔴 SELL"}.get(
            side, "⚪ Side unavailable"
        )
        state = str(row.get("normalized_status") or "").lower()
        state_label = {
            "filled": "✅ Filled",
            "canceled": "🚫 Canceled",
            "cancelled": "🚫 Canceled",
            "failed": "❌ Failed",
            "running": "▶️ Running",
            "open": "🟡 Open",
            "active": "▶️ Active",
            "completed": "✅ Completed",
            "closed": "⏹ Executor ended",
            "terminated": "⏹ Ended",
            "partially_filled": "◐ Partially filled",
        }.get(state, clean(state.replace("_", " ").title(), 40))
        lines += ["", f"<b>{clean(raw_pair, 40)} · {direction}</b>"]
        amount, price = number(row.get("amount_base")), number(row.get("price_quote"))
        if command == "orders":
            lines += [
                state_label if state else "Status unavailable",
                f"Size: {amount} {base} · Price: {price} {quote}",
            ]
        elif command == "fills":
            lines += ["✅ Fill recorded", f"{amount} {base} at {price} {quote}"]
            fee = (
                number(row.get("fee_quote"), precision=4)
                if row.get("economics_available") is True
                else "—"
            )
            lines.append(f"Fee: {fee} {quote}" if fee != "—" else "Fee unavailable")
        else:
            lines.append(state_label if state else "Status unavailable")
            pnl = (
                number(row.get("net_pnl_quote"), signed=True, money=True)
                if row.get("pnl_available") is True
                else "—"
            )
            lines.append(f"PnL: {pnl} {quote}" if pnl != "—" else "PnL unavailable")
            if row.get("trailing_state"):
                prefix = (
                    "Last trailing state"
                    if state in {"closed", "completed", "terminated"}
                    else "Trailing"
                )
                lines.append(f"{prefix}: {clean(row['trailing_state'], 40)}")
            if row.get("close_type"):
                # Names match the running native Hummingbot CloseType contract.
                reasons = {
                    "1": "Time limit",
                    "2": "Stop loss",
                    "3": "Take profit",
                    "4": "Expired",
                    "5": "Early stop",
                    "6": "Trailing stop",
                    "7": "Insufficient balance",
                    "8": "Failed",
                    "9": "Completed",
                    "10": "Position retained",
                }
                raw_reason = str(row["close_type"])
                reason = reasons.get(raw_reason)
                if reason is None:
                    reason = {"POSITION_HOLD": "Position retained"}.get(
                        raw_reason,
                        "Reason unavailable (code " + clean(raw_reason, 16) + ")",
                    )
                lines.append(
                    ("📦 " if reason == "Position retained" else "Exit: ") + reason
                )
        timestamp = (
            row.get("timestamp") or row.get("created_at") or row.get("opened_at")
        )
        identity = row.get(
            {"orders": "order_id", "fills": "fill_id", "executors": "executor_id"}[
                command
            ]
        )
        identity = str(identity) if identity is not None else "—"
        short_id = "…" + identity[-10:] if len(identity) > 12 else identity
        lines.append(f"<i>{when(timestamp)} · ID {clean(short_id, 16)}</i>")
    lines += ["", "<i>Times in UTC · — means unavailable.</i>"]
    return View("\n".join(lines), page, pages)


def header(label, command):
    return f"<b>{clean(label)} · {TITLES[command]}</b>\n\n"


def help_text(sources):
    names = ", ".join(clean(source.id) for source in sources)
    return (
        "<b>🦅 Condor · Bot monitor</b>\n\n"
        "Choose a view using the buttons below.\n\n"
        "📊 /status — activity, PnL and data freshness\n"
        "📋 /orders — recent order history\n"
        "💱 /fills — completed trade fills\n"
        "⚙️ /executors — recent execution lifecycles\n"
        "❔ /help — this menu\n\n"
        f"Sources: <b>{names}</b>\n"
        "Use a suffix to select a source, for example <code>/status v2</code>.\n"
        "<i>Read-only monitoring · no trade or cancel buttons.</i>"
    )


def parse_callback(data):
    if not isinstance(data, str) or len(data.encode()) > 64:
        return None
    match = re.fullmatch(
        r"fleet:([a-z0-9][a-z0-9_-]{0,39}):(status|orders|fills|executors|help):([0-9]{1,3})",
        data,
    )
    if not match:
        return None
    target, command, page = match.groups()
    return command, target, int(page)


def chunks(text, limit=3900):
    """Split on balanced HTML lines, measuring Telegram's UTF-16 units."""
    result, current = [], ""
    for line in text.splitlines():
        if len(line.encode("utf-16-le")) // 2 > limit:
            raise ValueError("rendered line exceeds Telegram message budget")
        candidate = current + "\n" + line if current else line
        if len(candidate.encode("utf-16-le")) // 2 > limit:
            result.append(current)
            current = line
        else:
            current = candidate
    if current:
        result.append(current)
    return result
