"""Pure validation for versioned public OKX stock owner projections.

This contract is separate from the crypto lane contract. Exact exchange IDs
are never converted to Hummingbot pairs or inferred from ticker spelling.
"""

from __future__ import annotations

import math
import re
from typing import Any

STOCK_VIEWS = frozenset({"stocks", "stock-market", "stock-candles"})
REGIONS = frozenset({"eea", "global"})
PRODUCTS = frozenset({"SPOT", "SWAP", "FUTURES"})
STATES = frozenset({"disabled", "starting", "empty", "live", "stale", "error"})
CHANNEL_STATES = frozenset({"waiting", "live", "stale", "gap", "error", "unavailable"})
RANGE_MINUTES = {"1h": 60, "6h": 360, "24h": 1440, "7d": 10080}
LATEST = frozenset({"ticker", "mark_price", "index_price", "funding", "open_interest"})
DATASETS = LATEST | {
    "trades", "books", "candles", "mark_candles", "index_candles",
    "history_candles", "history_trades", "funding_history",
    "history_mark_candles", "history_index_candles",
}
INSTRUMENT_ID = re.compile(r"[A-Z0-9][A-Z0-9._-]{1,79}")
MAX_INTEGER = 2**53 - 1
MAX_TIMESTAMP = 4_102_444_800
MAX_ROWS = 1024
MAX_CAPTURE = 64
COMMON = {"format", "now", "region", "state", "catalog_at", "updated_at", "reason"}
COUNTERS = ("final", "no_trade", "unrecoverable", "missing", "pending", "corrections")


class StockPayloadError(ValueError):
    """A bounded stable failure code safe to project in the unavailable envelope."""


def _fail(code: str) -> None:
    raise StockPayloadError(f"owner_invalid_stock_{code}")


def _number(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _integer(value: Any, maximum: int = MAX_INTEGER) -> bool:
    return type(value) is int and 0 <= value <= maximum


def _text(value: Any, limit: int = 2048, *, nullable: bool = False) -> bool:
    return (nullable and value is None) or (isinstance(value, str) and len(value) <= limit)


def _enum(value: Any, choices: set | frozenset | dict) -> bool:
    return isinstance(value, str) and value in choices


def _shape(value: Any, required: set | frozenset, optional: set | frozenset = frozenset()) -> None:
    if not isinstance(value, dict) or not required <= value.keys() or value.keys() - required - optional:
        _fail("shape")


def _tree(payload: Any) -> None:
    stack = [(payload, 0)]
    visited = 0
    while stack:
        value, depth = stack.pop()
        visited += 1
        if depth > 24 or visited > 200_000:
            _fail("bounds")
        if isinstance(value, dict):
            if any(not isinstance(key, str) for key in value):
                _fail("json")
            stack.extend((key, depth + 1) for key in value)
            stack.extend((item, depth + 1) for item in value.values())
        elif isinstance(value, list):
            stack.extend((item, depth + 1) for item in value)
        elif isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                _fail("json")
            if len(value) > 16384:
                _fail("bounds")
        elif value is not None and type(value) is not bool:
            if not _number(value) or abs(value) > MAX_INTEGER:
                _fail("number")


def _id(value: Any) -> bool:
    return isinstance(value, str) and "-" in value and ".." not in value and INSTRUMENT_ID.fullmatch(value) is not None


def validate_stock_query(view: str, items: list[tuple[str, str]]) -> dict[str, str]:
    if view not in STOCK_VIEWS:
        raise KeyError(view)
    query = dict(items)
    if len(query) != len(items):
        raise ValueError("duplicate_query")
    allowed = {"region"} if view == "stocks" else {"region", "instId", "instType"}
    if view == "stock-candles":
        allowed.add("range")
    if query.keys() - allowed or query.get("region") not in REGIONS:
        raise ValueError("invalid_stock_query")
    if view != "stocks" and (not _id(query.get("instId")) or query.get("instType") not in PRODUCTS):
        raise ValueError("invalid_stock_identity")
    if view == "stock-candles":
        if query.get("range", "24h") not in RANGE_MINUTES:
            raise ValueError("invalid_stock_range")
        return {**query, "range": query.get("range", "24h")}
    return query


def _seconds(value: Any, now: float, *, nullable: bool = True) -> None:
    if value is None and nullable:
        return
    if not _number(value) or not 0 <= value <= min(MAX_TIMESTAMP, now + 5):
        _fail("timestamp")


def _millis(value: Any, now: float) -> None:
    if value is not None and (not _integer(value, MAX_TIMESTAMP * 1000) or value > (now + 5) * 1000):
        _fail("timestamp")


def _identity(payload: dict, query: dict[str, str], *, instrument: bool) -> None:
    if not _enum(payload.get("region"), REGIONS) or payload.get("region") != query.get("region"):
        _fail("identity")
    if instrument and (
        not _id(payload.get("instId"))
        or not _enum(payload.get("instType"), PRODUCTS)
        or any(payload.get(key) != query.get(key) for key in ("instId", "instType"))
    ):
        _fail("identity")


def _instrument(value: Any) -> dict:
    if not isinstance(value, dict) or len(value) > 128 or not _id(value.get("instId")) or not _enum(value.get("instType"), PRODUCTS) or value.get("instCategory") != "3":
        _fail("instrument")
    for key in value:
        if not key or len(key) > 128:
            _fail("metadata")
    # Official metadata includes numeric instIdCode and nested upcChg objects.
    # Preserve the entire bounded JSON record; _tree checks every nested value.
    return value


def _event(value: Any, dataset: str, identity: dict, now: float) -> None:
    if value is None:
        return
    _shape(value, {"region", "instId", "instType", "dataset", "event_time_ms", "received_at_ms", "source", "data"}, {"action", "projection"})
    _identity(value, identity, instrument=True)
    if value["dataset"] != dataset or not _enum(value["source"], {"rest", "ws"}):
        _fail("event")
    _millis(value["event_time_ms"], now)
    _millis(value["received_at_ms"], now)
    if value["received_at_ms"] is None or not isinstance(value["data"], dict) or len(value["data"]) > 128:
        _fail("event")
    if "action" in value and not _enum(value["action"], {"snapshot", "update"}):
        _fail("event")
    if "projection" in value and (dataset != "books" or value["projection"] != "top50_from_standard_books" or value.get("action") != "snapshot"):
        _fail("event")


def _latest(value: Any, identity: dict, now: float, *, market: bool) -> None:
    keys = LATEST | ({"books"} if market else set())
    _shape(value, keys)
    for dataset, observation in value.items():
        _event(observation, dataset, identity, now)
    if identity["instType"] == "SPOT" and any(value[key] is not None for key in LATEST - {"ticker"}):
        _fail("spot_derivatives")


def _channels(value: Any, now: float) -> None:
    if not isinstance(value, dict) or value.keys() - DATASETS:
        _fail("channels")
    for channel in value.values():
        _shape(channel, {"state", "event_time_ms", "received_at_ms", "age_s", "reason"})
        if not _enum(channel["state"], CHANNEL_STATES) or not _text(channel["reason"], nullable=True):
            _fail("channels")
        _millis(channel["event_time_ms"], now)
        _millis(channel["received_at_ms"], now)
        age = channel["age_s"]
        if age is not None and (not _number(age) or not 0 <= age <= MAX_TIMESTAMP or channel["received_at_ms"] is None):
            _fail("channels")


def _coverage(value: Any, now: float) -> None:
    _shape(value, {"capture_started_at", "candle_start", "candle_end", "historical_trades", "historical_books"})
    if value["historical_trades"] is not False or value["historical_books"] is not False:
        _fail("coverage")
    _seconds(value["capture_started_at"], now)
    for key in ("candle_start", "candle_end"):
        stamp = value[key]
        if stamp is not None and (not _integer(stamp, MAX_TIMESTAMP) or stamp % 60 or stamp >= (int(now) // 60) * 60):
            _fail("coverage")
    start, end = value["candle_start"], value["candle_end"]
    if (start is None) != (end is None) or (start is not None and start > end):
        _fail("coverage")


def _discovery(value: Any) -> None:
    if value is None:
        return
    _shape(value, {"complete", "families", "warnings"})
    if type(value["complete"]) is not bool or not isinstance(value["families"], dict) or value["families"].keys() - PRODUCTS:
        _fail("discovery")
    warnings = value["warnings"]
    if not isinstance(warnings, list) or len(warnings) > 16 or any(not _text(item, 512) for item in warnings):
        _fail("discovery")
    for family in value["families"].values():
        _shape(family, {"total", "classified", "unclassified", "stocks"})
        if any(not _integer(count, 100000) for count in family.values()) or family["classified"] + family["unclassified"] != family["total"] or family["stocks"] > family["classified"]:
            _fail("discovery")
        if value["complete"] and family["unclassified"]:
            _fail("discovery")
    if value["complete"] and value["families"].keys() != PRODUCTS:
        _fail("discovery")


def _captured(value: Any) -> bool:
    if type(value) is not bool:
        _fail("captured")
    return value


def _capture(value: Any) -> list[tuple[str, str, bool]]:
    """Operator allowlist: exact identities, strictly sorted, so no duplicates."""
    if not isinstance(value, list) or len(value) > MAX_CAPTURE:
        _fail("capture")
    entries = []
    for entry in value:
        _shape(entry, {"instType", "instId", "listed"})
        if not _enum(entry["instType"], PRODUCTS) or not _id(entry["instId"]) or type(entry["listed"]) is not bool:
            _fail("capture")
        entries.append((entry["instType"], entry["instId"], entry["listed"]))
    if any(left[:2] >= right[:2] for left, right in zip(entries, entries[1:])):
        _fail("capture")
    return entries


def _book(payload: dict) -> None:
    book, depth = payload["latest"]["books"], payload["book_depth"]
    if book is None:
        if depth is not None:
            _fail("book_depth")
        return
    _shape(depth, {"bids", "asks"})
    for side in ("bids", "asks"):
        levels = book["data"].get(side)
        if not isinstance(levels, list) or len(levels) > 50 or not _integer(depth[side], 50) or depth[side] != len(levels):
            _fail("book_depth")
        for level in levels:
            if not isinstance(level, list) or not 2 <= len(level) <= 4 or any(not _text(item, 128) for item in level):
                _fail("book_levels")


def _candles(payload: dict, query: dict[str, str]) -> None:
    if not _enum(payload["range"], RANGE_MINUTES) or payload["range"] != query.get("range", "24h") or type(payload["res_s"]) is not int or payload["res_s"] != 60:
        _fail("range")
    if payload["price_basis"] != "trade" or payload["adjustment"] != "raw" or not _text(payload["volume_unit"], 128) or not payload["volume_unit"]:
        _fail("price_basis")
    start, end, buckets = payload["start"], payload["end"], payload["buckets"]
    count = RANGE_MINUTES[payload["range"]]
    if not _integer(start, MAX_TIMESTAMP) or not _integer(end, MAX_TIMESTAMP) or start % 60 or end % 60 or end != (int(payload["now"]) // 60 - 1) * 60 or end - start != (count - 1) * 60 or not isinstance(buckets, list) or len(buckets) != count:
        _fail("window")
    totals = dict.fromkeys(COUNTERS, 0)
    for index, row in enumerate(buckets):
        if not isinstance(row, list) or len(row) != 12 or type(row[0]) is not int or row[0] != start + index * 60 or any(not _integer(item) for item in row[6:]):
            _fail("candles")
        if sum(row[6:11]) != 1:
            _fail("minute_state")
        if row[6] == 1:
            if any(not _number(price) or price <= 0 for price in row[1:5]) or not row[3] <= min(row[1], row[4]) <= max(row[1], row[4]) <= row[2]:
                _fail("prices")
            if row[5] is not None and (not _number(row[5]) or row[5] < 0):
                _fail("volume")
        elif any(item is not None for item in row[1:6]):
            _fail("prices")
        for offset, name in enumerate(COUNTERS, 6):
            totals[name] += row[offset]
    _shape(payload["totals"], set(COUNTERS))
    if payload["totals"] != totals or any(not _integer(value) for value in payload["totals"].values()):
        _fail("totals")


def validate_stock_payload(view: str, payload: Any, query: dict[str, str]) -> dict:
    if view not in STOCK_VIEWS:
        _fail("view")
    _tree(payload)
    if not isinstance(payload, dict) or not _number(payload.get("now")) or not 0 < payload["now"] <= MAX_TIMESTAMP:
        _fail("timestamp")
    expected_format = {"stocks": "okx-stocks-v1", "stock-market": "okx-stock-market-v1", "stock-candles": "okx-stock-candles-v1"}[view]
    if payload.get("format") != expected_format or not _enum(payload.get("state"), STATES) or not _text(payload.get("reason"), nullable=True):
        _fail("envelope")
    _identity(payload, query, instrument=view != "stocks")
    now = payload["now"]
    if view == "stock-candles":
        _shape(payload, {"format", "now", "region", "state", "reason", "instId", "instType", "range", "res_s", "start", "end", "volume_unit", "price_basis", "adjustment", "buckets", "totals", "captured"}, {"catalog_at", "updated_at", "discovery"})
        _captured(payload["captured"])
        for key in ("catalog_at", "updated_at"):
            if key in payload:
                _seconds(payload[key], now)
        _discovery(payload.get("discovery"))
        _candles(payload, query)
        return payload
    _shape(payload, COMMON | ({"rows", "capture"} if view == "stocks" else {"instId", "instType", "latest", "channels", "coverage", "recent_trades", "book_depth", "captured"}), {"discovery"})
    _discovery(payload.get("discovery"))
    _seconds(payload["catalog_at"], now)
    _seconds(payload["updated_at"], now)
    if payload["state"] in {"live", "empty", "stale"} and (payload["catalog_at"] is None or payload["updated_at"] is None):
        _fail("catalog_time")
    if payload["state"] in {"disabled", "error"} and not payload["reason"]:
        _fail("reason")
    if view == "stocks":
        rows = payload["rows"]
        if not isinstance(rows, list) or len(rows) > MAX_ROWS or (payload["state"] in {"disabled", "empty"} and rows):
            _fail("rows")
        capture = _capture(payload["capture"])
        if payload["state"] == "disabled" and capture:
            _fail("capture")
        allowlisted = {(kind, inst_id) for kind, inst_id, _ in capture}
        identities = set()
        for row in rows:
            _shape(row, {"instrument", "latest", "channels", "coverage", "captured"})
            instrument = _instrument(row["instrument"])
            key = (instrument["instType"], instrument["instId"])
            if key in identities:
                _fail("duplicate_identity")
            identities.add(key)
            identity = {"region": payload["region"], "instId": instrument["instId"], "instType": instrument["instType"]}
            captured = _captured(row["captured"])
            if captured != (key in allowlisted):
                _fail("capture")
            _latest(row["latest"], identity, now, market=False)
            _channels(row["channels"], now)
            if not captured and (row["channels"] or any(item is not None for item in row["latest"].values())):
                _fail("captured")
            _coverage(row["coverage"], now)
        if any(listed != ((kind, inst_id) in identities) for kind, inst_id, listed in capture):
            _fail("capture")
    else:
        _captured(payload["captured"])
        _latest(payload["latest"], query, now, market=True)
        _channels(payload["channels"], now)
        _coverage(payload["coverage"], now)
        trades = payload["recent_trades"]
        if not isinstance(trades, list) or len(trades) > 50:
            _fail("trades")
        for trade in trades:
            if trade is None:
                _fail("trades")
            _event(trade, "trades", query, now)
        _book(payload)
    return payload
