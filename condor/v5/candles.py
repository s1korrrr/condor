"""Bounded read-only projections over the owner's private Unix socket."""

from __future__ import annotations

import asyncio
import json
import math
import re
from typing import Any

import aiohttp

MAX_BYTES = 2_000_000
RANGES = {"1h", "6h", "24h", "7d"}
LANE = re.compile(r"[a-z0-9_]{1,48}__(spot|perpetual)")
PAIR = re.compile(r"[A-Za-z0-9]{1,24}-[A-Za-z0-9]{1,24}")
ROW_KEYS = {
    "lane",
    "venue",
    "segment",
    "pair",
    "health",
    "volume_unit",
    "last_minute",
    "last_minute_age_s",
    "coverage_1h",
    "coverage_24h",
    "coverage_7d",
    "gaps_7d",
    "pending",
    "unrecoverable_7d",
    "no_trade_7d",
    "ws_state",
    "ws_last_message_age_s",
    "grace_s",
    "health_rules",
}
TILE_KEYS = (ROW_KEYS - {"pair", "ws_state", "ws_last_message_age_s"}) | {
    "pairs_listed",
    "pairs_held",
    "available",
    "unavailable_reason",
    "partition_errors",
    "ws_states",
    "ws_connected",
    "backfill_done",
}


class OwnerUnavailable(ValueError):
    pass


def _reject_constant(value):
    raise OwnerUnavailable("owner_invalid_json")


def validate_query(view: str, items: list[tuple[str, str]]) -> dict[str, str]:
    query = dict(items)
    if len(query) != len(items):
        raise ValueError("duplicate_query")
    if view not in {"overview", "symbols", "candles"}:
        raise KeyError(view)
    if view != "candles":
        if query:
            raise ValueError("unexpected_query")
        return {}
    if set(query) - {"lane", "pair", "range"}:
        raise ValueError("unexpected_query")
    if not LANE.fullmatch(query.get("lane", "")) or not PAIR.fullmatch(
        query.get("pair", "")
    ):
        raise ValueError("invalid_instrument")
    if query.get("range", "24h") not in RANGES:
        raise ValueError("invalid_range")
    return {**query, "range": query.get("range", "24h"), "res": "1m"}


def _number(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _rows(payload, key, limit, fields):
    rows = payload.get(key)
    if not isinstance(rows, list) or len(rows) > limit:
        raise OwnerUnavailable("owner_invalid_rows")
    safe = []
    for row in rows:
        if (
            not isinstance(row, dict)
            or not LANE.fullmatch(str(row.get("lane", "")))
            or row.get("segment") not in {"spot", "perpetual"}
            or row.get("lane") != f"{row.get('venue')}__{row.get('segment')}"
            or row.get("health") not in {"green", "amber", "red"}
        ):
            raise OwnerUnavailable("owner_invalid_identity")
        if key == "rows" and not PAIR.fullmatch(str(row.get("pair", ""))):
            raise OwnerUnavailable("owner_invalid_identity")
        rules = row.get("health_rules")
        if not isinstance(rules, list) or len(rules) > 32:
            raise OwnerUnavailable("owner_invalid_health_rules")
        for rule in rules:
            if (
                not isinstance(rule, dict)
                or rule.get("level") not in {"green", "amber", "red"}
                or any(
                    not isinstance(rule.get(name), str) or len(rule[name]) > 2048
                    for name in ("name", "detail")
                )
            ):
                raise OwnerUnavailable("owner_invalid_health_rules")
        numeric = {
            "last_minute",
            "last_minute_age_s",
            "coverage_1h",
            "coverage_24h",
            "coverage_7d",
            "gaps_7d",
            "pending",
            "unrecoverable_7d",
            "no_trade_7d",
            "ws_last_message_age_s",
            "grace_s",
            "pairs_listed",
            "pairs_held",
            "ws_connected",
        }
        for name, value in row.items():
            if name in numeric and value is not None and not _number(value):
                raise OwnerUnavailable("owner_invalid_number")
            if name in numeric and value is not None and value < 0:
                raise OwnerUnavailable("owner_invalid_number")
            if name == "last_minute" and value is not None and value > payload["now"]:
                raise OwnerUnavailable("owner_invalid_timestamp")
            if (
                name in {"ws_state", "volume_unit", "unavailable_reason"}
                and value is not None
            ):
                if not isinstance(value, str) or len(value) > 1024:
                    raise OwnerUnavailable("owner_invalid_text")
            if name in fields and type(value) in (int, float) and not _number(value):
                raise OwnerUnavailable("owner_invalid_number")
            if name.startswith("coverage_") and name in fields and value is not None:
                if not _number(value) or not 0 <= value <= 1:
                    raise OwnerUnavailable("owner_invalid_coverage")
        if key == "tiles":
            errors = row.get("partition_errors")
            if not isinstance(errors, list) or len(errors) > 128:
                raise OwnerUnavailable("owner_invalid_partition_errors")
            for error in errors:
                if not isinstance(error, dict) or any(
                    not isinstance(error.get(name), str) or len(error[name]) > 2048
                    for name in ("day", "error")
                ):
                    raise OwnerUnavailable("owner_invalid_partition_errors")
        safe.append({name: row.get(name) for name in fields})
    return safe


def validate_payload(view: str, payload: Any) -> dict:
    if (
        not isinstance(payload, dict)
        or not _number(payload.get("now"))
        or payload["now"] <= 0
        or payload["now"] > 4_102_444_800
    ):
        raise OwnerUnavailable("owner_invalid_payload")
    if view == "overview":
        age = payload.get("status_age_s")
        error = payload.get("status_error")
        if (age is not None and (not _number(age) or age < -5)) or (
            error is not None and (not isinstance(error, str) or len(error) > 2048)
        ):
            raise OwnerUnavailable("owner_invalid_status")
        return {
            "now": payload["now"],
            "status_age_s": payload.get("status_age_s"),
            "status_error": payload.get("status_error"),
            "tiles": _rows(payload, "tiles", 128, TILE_KEYS),
        }
    if view == "symbols":
        return {"now": payload["now"], "rows": _rows(payload, "rows", 1024, ROW_KEYS)}
    buckets = payload.get("buckets")
    if (
        not isinstance(buckets, list)
        or len(buckets) > 10080
        or payload.get("res_s") != 60
        or not LANE.fullmatch(str(payload.get("lane", "")))
        or payload.get("lane") != f"{payload.get('venue')}__{payload.get('segment')}"
        or not PAIR.fullmatch(str(payload.get("pair", "")))
        or payload.get("range") not in RANGES
    ):
        raise OwnerUnavailable("owner_invalid_candles")
    previous = -1
    totals = {
        name: 0
        for name in (
            "final",
            "no_trade",
            "unrecoverable",
            "missing",
            "pending",
            "corrections",
        )
    }
    for row in buckets:
        if (
            not isinstance(row, list)
            or len(row) != 12
            or type(row[0]) is not int
            or row[0] <= previous
            or row[0] % 60
            or row[0] < 0
            or row[0] > payload["now"]
            or any(
                value is not None and (not _number(value) or value < 0)
                for value in row[1:6]
            )
            or any(type(value) is not int or value < 0 for value in row[6:])
        ):
            raise OwnerUnavailable("owner_invalid_candles")
        prices = row[1:5]
        if row[6] == 1:
            if (
                any(value is None for value in prices)
                or not row[3] <= min(row[1], row[4]) <= max(row[1], row[4]) <= row[2]
            ):
                raise OwnerUnavailable("owner_invalid_prices")
        elif any(value is not None for value in row[1:6]):
            raise OwnerUnavailable("owner_invalid_prices")
        if sum(row[6:11]) != 1:
            raise OwnerUnavailable("owner_invalid_minute_state")
        for index, name in enumerate(totals):
            totals[name] += row[index + 6]
        previous = row[0]
    if payload.get("totals") != totals or any(
        type(value) is not int for value in payload["totals"].values()
    ):
        raise OwnerUnavailable("owner_inconsistent_totals")
    if (
        not isinstance(payload.get("volume_unit"), str)
        or len(payload["volume_unit"]) > 128
    ):
        raise OwnerUnavailable("owner_invalid_volume_unit")
    fields = {
        "now",
        "lane",
        "venue",
        "segment",
        "pair",
        "range",
        "res_s",
        "start",
        "end",
        "volume_unit",
        "buckets",
        "totals",
    }
    return {name: payload.get(name) for name in fields}


class CandleOwner:
    def __init__(self, socket_path: str, *, session_factory=aiohttp.ClientSession):
        self.socket_path = str(socket_path)
        self.session_factory = session_factory
        self._slots = asyncio.Semaphore(2)

    async def read(self, view: str, query: dict[str, str]) -> dict:
        try:
            async with asyncio.timeout(8):
                async with self._slots:
                    connector = aiohttp.UnixConnector(path=self.socket_path, limit=2)
                    async with self.session_factory(
                        connector=connector,
                        timeout=aiohttp.ClientTimeout(total=6),
                        trust_env=False,
                        auto_decompress=False,
                    ) as session:
                        async with session.get(
                            f"http://owner/api/{view}",
                            params=query,
                            allow_redirects=False,
                        ) as response:
                            if response.status != 200:
                                raise OwnerUnavailable("owner_http_error")
                            raw = bytearray()
                            async for chunk in response.content.iter_chunked(65536):
                                raw.extend(chunk)
                                if len(raw) > MAX_BYTES:
                                    raise OwnerUnavailable("owner_response_too_large")
            payload = json.loads(raw, parse_constant=_reject_constant)
            safe = validate_payload(view, payload)
            if view == "candles" and any(
                safe[name] != query[name] for name in ("lane", "pair", "range")
            ):
                raise OwnerUnavailable("owner_identity_mismatch")
            return safe
        except OwnerUnavailable:
            raise
        except (aiohttp.ClientError, OSError, TimeoutError) as exc:
            raise OwnerUnavailable("owner_unreachable") from exc
        except (ValueError, TypeError, RecursionError) as exc:
            raise OwnerUnavailable("owner_invalid_json") from exc
