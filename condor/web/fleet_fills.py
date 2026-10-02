"""Fleet fills feed contract ``fleet-fills.v1``: every bot's fills, one ordered, bot-labelled list.

The Bots and Capital pages, the iPhone app and the Watch glance read this feed instead of each
merging per-bot fill ledgers themselves. The document clients code against is
``docs/reference/fleet-fills-v1.md`` (rsibot workspace); this module is its reference implementation.

Rules that make the feed trustworthy:

* the sources are exactly the ones ``fleet-summary.v1`` reads: the registered reporting source of each
  live bot, behind the same authenticated reader. Nothing here owns storage and nothing is written;
* a bot whose reader is down is listed in ``bots`` with its reason and ``partial`` is true. A bot is
  never silently omitted and an empty list never stands for "no fills" unless every bot said so;
* rows are normalised, never dropped for lacking fields a newer reporting image adds: a V1 row with
  ``exact_amount: null`` and 6-decimal legacy values keeps its numbers and is labelled
  ``receipt: "legacy_6dp"``. Only rows that cannot be identified (no ``fill_id``, another bot's row, a
  duplicate of an identity already seen) are rejected, and every rejection is counted per bot;
* order is total and stable: newest first, then bot, then ``source_db_id``, then ``fill_id``. Rows without
  a trustworthy instant (naive stamps are ambiguous) sort last. The cursor encodes that key, so a page
  never repeats or skips a row that is still inside the window;
* each owner read is the newest ``OWNER_FILL_LIMIT`` rows. When a bot's read is full, rows older than
  its oldest row may be missing, so the merged feed ends at the newest such horizon (``window``) rather
  than interleaving an incomplete history as if it were complete;
* money is a decimal string, times are epoch milliseconds, absent facts are ``null``.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from condor.fetchers.bots import build_bots_page
from condor.web import fleet_pnl
from condor.web.fleet_summary import (
    INVALID,
    NO_REGISTRY,
    PAPER_EXCLUDED,
    PARTIAL_COVERAGE,
    REGISTRY_FROM_STATUS,
    SOURCE_UNAVAILABLE,
    Readers,
    _dec,
    _instant_ms,
    _obj,
    display_name,
    generation,
    is_paper,
)

SCHEMA_VERSION = "fleet-fills.v1"
OWNER_FILL_LIMIT = 500
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
SIDES = ("buy", "sell")
RECEIPTS = ("exact", "legacy_6dp", "unavailable")

# Reject reasons counted per bot (``bots[].rejected``).
NO_FILL_ID = "NO_FILL_ID"
FOREIGN_BOT = "FOREIGN_BOT"
DUPLICATE = "DUPLICATE"
NOT_AN_OBJECT = "NOT_AN_OBJECT"


class FeedQueryError(ValueError):
    """A query parameter the feed does not accept (HTTP 400)."""


@dataclass
class BotRead:
    """One bot's contribution: normalised rows plus an honest account of the read."""

    bot: str
    status: str  # ok | unavailable | excluded
    reason: Optional[str] = None
    rows: list[dict] = field(default_factory=list)
    rows_read: int = 0
    rejected: dict[str, int] = field(default_factory=dict)
    saturated: bool = False


# ── normalisation ──


def _text(value: Any) -> Optional[str]:
    return value.strip() if isinstance(value, str) and value.strip() else None


def normalize_pair(value: Any) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """``(pair, base, quote)``: ``BTC-USDC`` form; base and quote are ``None`` unless the pair has exactly two parts."""
    text = _text(value)
    if text is None:
        return None, None, None
    pair = text.upper().replace("/", "-")
    parts = pair.split("-")
    if len(parts) == 2 and all(parts):
        return pair, parts[0], parts[1]
    return pair, None, None


def normalize_side(value: Any) -> Optional[str]:
    text = _text(value)
    return text.lower() if text and text.lower() in SIDES else None


def _decimal(row: dict, *keys: str, positive: bool = False) -> Optional[str]:
    """The first key that parses as a finite decimal. Exact receipt strings are listed before float projections."""
    for key in keys:
        number = _dec(row.get(key))
        if number is not None and (not positive or number > 0):
            return fleet_pnl.decimal_text(number)
    return None


def normalize_fill(row: Any, bot: str) -> tuple[Optional[dict], Optional[str]]:
    """``(item, None)`` or ``(None, reject_reason)``. Never raises for a malformed row."""
    fill = _obj(row)
    if not fill:
        return None, NOT_AN_OBJECT
    fill_id = fill.get("fill_id")
    if not isinstance(fill_id, str) or not fill_id.strip():
        return None, NO_FILL_ID
    if fill.get("bot_name") != bot:
        return None, FOREIGN_BOT
    pair, base, quote = normalize_pair(fill.get("pair"))
    amount = _decimal(fill, "exact_amount", "amount_base", positive=True)
    price = _decimal(fill, "exact_price", "price_quote", positive=True)
    exact = (
        _decimal(fill, "exact_amount", positive=True) is not None
        and _decimal(fill, "exact_price", positive=True) is not None
    )
    receipt = (
        "exact" if exact else "legacy_6dp" if amount is not None and price is not None else "unavailable"
    )
    item = {
        "bot": bot,
        "display_name": display_name(bot),
        "generation": generation(bot),
        "fill_id": fill_id,
        "order_id": _text(fill.get("order_id")),
        "source_db_id": _text(fill.get("source_db_id")),
        "connector": _text(fill.get("connector_name")),
        "pair": pair,
        "base": base,
        "quote": quote,
        "side": normalize_side(fill.get("side")),
        "order_type": _text(fill.get("order_type")),
        "amount": amount,
        "price": price,
        "volume": _decimal(
            fill,
            "value_quote_exact",
            "gross_volume_quote_decimal",
            "gross_volume_quote",
            positive=True,
        ),
        "fee": _decimal(fill, "exact_trade_fee_in_quote", "fee_quote"),
        "fee_unit": quote,
        "time_ms": _instant_ms(fill.get("timestamp")),
        "receipt": receipt,
        "simulated": fill.get("simulated") is True,
        # Owner fill rows carry no per-fill realised PnL, and a ledger window cannot support an average-cost
        # replay: the field is reserved (v1 only adds fields) and stays null until an owner publishes it.
        "realized_pnl": _decimal(fill, "realized_pnl_quote"),
    }
    item["missing"] = sorted(
        name
        for name in ("pair", "side", "amount", "price", "volume", "fee", "time_ms")
        if item[name] is None
    )
    item["id"] = f"{bot}|{item['source_db_id'] or ''}|{fill_id}"
    return item, None


def normalize_owner_rows(payload: Any, bot: str, limit: int = OWNER_FILL_LIMIT) -> BotRead:
    """Rows of one owner ``fills`` response. A payload that is not ``{rows: [...]}`` is ``INVALID``."""
    rows = _obj(payload).get("rows")
    if not isinstance(rows, list):
        return BotRead(bot, "unavailable", INVALID)
    out = BotRead(bot, "ok", rows_read=len(rows), saturated=len(rows) >= limit)
    seen: set[str] = set()
    for row in rows:
        item, reason = normalize_fill(row, bot)
        if item is None:
            out.rejected[reason] = out.rejected.get(reason, 0) + 1
        elif item["id"] in seen:
            out.rejected[DUPLICATE] = out.rejected.get(DUPLICATE, 0) + 1
        else:
            seen.add(item["id"])
            out.rows.append(item)
    return out


# ── ordering and cursor ──


def order_key(item: dict) -> tuple:
    """Total order, ascending = newest first. Untimed rows sort after every timed row."""
    time_ms = item["time_ms"]
    return (
        time_ms is None,
        -(time_ms or 0),
        item["bot"],
        item["source_db_id"] or "",
        item["fill_id"],
    )


def encode_cursor(item: dict) -> str:
    raw = json.dumps(
        [item["time_ms"], item["bot"], item["source_db_id"], item["fill_id"]],
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple:
    """The order key of the last row of the previous page. Anything else is a 400, never a silent restart."""
    try:
        if len(cursor) > 512:
            raise ValueError
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        time_ms, bot, source, fill_id = json.loads(raw)
    except (ValueError, TypeError, binascii.Error, UnicodeDecodeError):
        raise FeedQueryError("before is not a cursor this feed issued") from None
    if (
        not (time_ms is None or (isinstance(time_ms, int) and not isinstance(time_ms, bool)))
        or not isinstance(bot, str)
        or not (source is None or isinstance(source, str))
        or not isinstance(fill_id, str)
    ):
        raise FeedQueryError("before is not a cursor this feed issued")
    return order_key(
        {"time_ms": time_ms, "bot": bot, "source_db_id": source, "fill_id": fill_id}
    )


# ── the window: what every owner said, merged once ──


async def read_window(
    server: str, readers: Readers, now_ms: float, *, limit: int = OWNER_FILL_LIMIT
) -> dict:
    """Read every registered bot's ledger and merge. Independent of any request filter, so it can be cached."""
    status_raw = await readers.bots_status(server)
    page = build_bots_page(status_raw) if status_raw is not None else None
    status_names = [
        b["bot_name"] for b in (page or {}).get("bots", []) if b.get("bot_name")
    ]
    registry = readers.registered_bots(server)
    notes: list[dict] = []
    if registry:
        bots = list(dict.fromkeys(registry))
    elif status_names:
        bots = list(dict.fromkeys(status_names))
        notes.append({"reason": REGISTRY_FROM_STATUS})
    else:
        bots = []
    live = [b for b in bots if not is_paper(b)]

    async def one(bot: str) -> BotRead:
        try:
            read = await readers.owner(bot, "fills", {"limit": str(limit)})
        except Exception:  # a reader that raises is a reader that is down
            return BotRead(bot, "unavailable", SOURCE_UNAVAILABLE)
        if read.payload is None:
            return BotRead(bot, "unavailable", read.reason or SOURCE_UNAVAILABLE)
        return normalize_owner_rows(read.payload, bot, limit)

    reads = dict(zip(live, await asyncio.gather(*(one(bot) for bot in live))))
    reads_in_order = [
        reads[bot] if bot in reads else BotRead(bot, "excluded", PAPER_EXCLUDED)
        for bot in bots
    ]

    items: list[dict] = []
    for read in reads_in_order:
        items.extend(read.rows)
    items.sort(key=order_key)

    # A full read may have more rows below its oldest row: nothing older than the newest such horizon is
    # known to be complete across bots.
    horizons = [
        min(t for t in (r["time_ms"] for r in read.rows) if t is not None)
        for read in reads_in_order
        if read.saturated and any(r["time_ms"] is not None for r in read.rows)
    ]
    horizon = max(horizons) if horizons else None
    if horizon is not None:
        items = [i for i in items if i["time_ms"] is None or i["time_ms"] >= horizon]

    bot_meta = []
    for read in reads_in_order:
        times = [r["time_ms"] for r in read.rows if r["time_ms"] is not None]
        bot_meta.append(
            {
                "bot": read.bot,
                "display_name": display_name(read.bot),
                "generation": generation(read.bot),
                "paper": is_paper(read.bot),
                "status": read.status,
                "reason": read.reason,
                "rows_read": read.rows_read,
                "rows_accepted": len(read.rows),
                "rejected": dict(sorted(read.rejected.items())),
                "receipts": {
                    kind: sum(1 for r in read.rows if r["receipt"] == kind)
                    for kind in RECEIPTS
                },
                "saturated": read.saturated,
                "oldest_ms": min(times) if times else None,
                "newest_ms": max(times) if times else None,
            }
        )
    return {
        "server": server,
        "generated_at_ms": int(now_ms),
        "items": items,
        "bots": bot_meta,
        "horizon_ms": horizon,
        "notes": notes,
    }


# ── the page: filters, cursor, limit ──


def _list_param(value: Optional[Iterable[str]]) -> list[str]:
    return [v for v in (value or [])]


def build_page(
    window: dict,
    *,
    limit: int = DEFAULT_LIMIT,
    before: Optional[str] = None,
    bots: Optional[Iterable[str]] = None,
    side: Optional[str] = None,
    pair: Optional[str] = None,
) -> dict:
    """One page of the window. Pure: the same window and query give the same body."""
    if not 1 <= limit <= MAX_LIMIT:
        raise FeedQueryError(f"limit must be 1..{MAX_LIMIT}")
    known = {b["bot"] for b in window["bots"]}
    wanted = _list_param(bots)
    if any(b not in known for b in wanted):
        raise FeedQueryError("unknown bot")
    side_n = None
    if side is not None:
        side_n = normalize_side(side)
        if side_n is None:
            raise FeedQueryError("side must be buy or sell")
    pair_n = None
    if pair is not None:
        pair_n = normalize_pair(pair)[0]
        if pair_n is None:
            raise FeedQueryError("pair must not be empty")
    after = decode_cursor(before) if before else None

    filtered = [
        item
        for item in window["items"]
        if (not wanted or item["bot"] in wanted)
        and (side_n is None or item["side"] == side_n)
        and (pair_n is None or item["pair"] == pair_n)
    ]
    remaining = (
        filtered
        if after is None
        else [item for item in filtered if order_key(item) > after]
    )
    page = remaining[:limit]
    has_more = len(remaining) > limit
    meta = [b for b in window["bots"] if not wanted or b["bot"] in wanted]
    live_meta = [b for b in meta if b["status"] != "excluded"]
    down = [b for b in live_meta if b["status"] == "unavailable"]
    if not live_meta:
        status, reason = "missing", (PAPER_EXCLUDED if window["bots"] else NO_REGISTRY)
    elif len(down) == len(live_meta):
        status, reason = "missing", down[0]["reason"]
    elif down:
        status, reason = "partial", PARTIAL_COVERAGE
    else:
        status, reason = "ok", None
    return {
        "schema_version": SCHEMA_VERSION,
        "server": window["server"],
        "generated_at_ms": window["generated_at_ms"],
        "status": status,
        "reason": reason,
        "partial": status != "ok",
        "items": page,
        "limit": limit,
        "has_more": has_more,
        "next_cursor": encode_cursor(page[-1]) if has_more and page else None,
        "matched": len(filtered),
        "window": {
            "horizon_ms": window["horizon_ms"],
            "truncated": window["horizon_ms"] is not None
            or any(b["saturated"] for b in live_meta),
            "owner_limit": OWNER_FILL_LIMIT,
        },
        "bots": meta,
        "notes": window["notes"],
    }
