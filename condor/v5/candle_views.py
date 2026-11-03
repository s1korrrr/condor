"""Strict projections for the candle store's cross-venue, coverage heatmap and store-facts reads.

The owner is hummingbot ``services/candle-store/candle_store_dashboard`` in ``--v5-api-only`` mode. Each
validator accepts exactly the documented owner shape, re-derives every identity and window from the request and
the owner's evaluation time, and returns only allowlisted fields. Anything else is ``OwnerUnavailable``: the
browser never receives a partially trusted payload. Spot and perpetual stay separate; nothing is aggregated.
"""

from __future__ import annotations

import math
import re
from typing import Any

ASSET = re.compile(r"[A-Za-z0-9]{1,24}")
LANE = re.compile(r"[a-z0-9_]{1,48}__(spot|perpetual)")
PAIR = re.compile(r"[A-Za-z0-9]{1,24}-[A-Za-z0-9]{1,24}")
DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
SEGMENTS = ("spot", "perpetual")
RANGE_MINUTES = {"1h": 60, "6h": 360, "24h": 1440, "7d": 10080}
AUTO_RESOLUTION = {
    "1h": ("1m", 60),
    "6h": ("1m", 60),
    "24h": ("5m", 300),
    "7d": ("15m", 900),
}
HEAT_FIELDS = ["final", "no_trade", "unrecoverable", "missing", "pending"]
HEAT_HOURS = 168
VERSION_KEYS = ("format", "store_format", "metrics_format")
PROCESS_KEYS = ("rss_mib", "max_rss_mib", "cpu_user_s", "cpu_sys_s")
LAG_KEYS = ("p50", "p99", "max", "max_recent")
FILE_KINDS = ("lanes", "sealed", "metrics")
MAX_INTEGER = 2**53 - 1
MAX_TIMESTAMP = 4_102_444_800
# Any absolute POSIX, Windows or UNC path, or a process id ("pid 42", "process=42"), in a store message means the
# owner failed to redact (it writes ``<path>`` and ``<pid>``).
PATH_TEXT = re.compile(
    r"(?<![\w./-])/[^\s'\"(),;]*|\b[A-Za-z]:[\\/]|\\\\[^\s'\"(),;]+"
    r"|\b(?:pid|process)\s*[=:#]?\s*\d"
)

VIEWS = frozenset({"cross", "heatmap", "store"})


class ViewError(ValueError):
    """Raised with a bounded stable code; the caller maps it to ``OwnerUnavailable``."""


def validate_view_query(view: str, query: dict[str, str]) -> dict[str, str]:
    if view == "store":
        if query:
            raise ValueError("unexpected_query")
        return {}
    if view == "heatmap":
        if set(query) != {"segment"} or query["segment"] not in SEGMENTS:
            raise ValueError("invalid_segment")
        return dict(query)
    if set(query) - {"asset", "segment", "range"}:
        raise ValueError("unexpected_query")
    if not ASSET.fullmatch(query.get("asset", "")):
        raise ValueError("invalid_asset")
    if query.get("segment") not in SEGMENTS:
        raise ValueError("invalid_segment")
    if query.get("range", "24h") not in RANGE_MINUTES:
        raise ValueError("invalid_range")
    return {**query, "range": query.get("range", "24h"), "res": "auto"}


def _number(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _optional_number(value: Any, minimum: float | None = None) -> bool:
    return value is None or (_number(value) and (minimum is None or value >= minimum))


def _integer_or_float(value: Any, maximum: float) -> bool:
    """A finite number in [-5, maximum]; times and durations the browser formats as dates must stay in range."""
    return _number(value) and -5 <= value <= maximum


def _integer(value: Any, maximum: int = MAX_INTEGER) -> bool:
    return type(value) is int and 0 <= value <= maximum


def _minute(value: Any) -> bool:
    return _integer(value, MAX_TIMESTAMP) and value % 60 == 0


def _text(value: Any, limit: int, optional: bool = False) -> bool:
    return (optional and value is None) or (
        isinstance(value, str) and len(value) <= limit
    )


def _lane_identity(row: dict, segment: str | None) -> bool:
    return (
        isinstance(row.get("lane"), str)
        and LANE.fullmatch(row["lane"]) is not None
        and isinstance(row.get("venue"), str)
        and row["lane"] == f"{row['venue']}__{row['lane'].rsplit('__', 1)[1]}"
        and (segment is None or row["lane"].endswith(f"__{segment}"))
    )


def _last_closed(now: float) -> int:
    return (int(now) // 60 - 1) * 60


def _points(
    points: Any, start: int, end: int, res_s: int, limit: int, minimum: float | None
) -> list:
    if not isinstance(points, list) or len(points) > limit:
        raise ViewError("owner_invalid_cross")
    previous = None
    first_bucket = (start // res_s) * res_s
    for point in points:
        if (
            not isinstance(point, list)
            or len(point) != 2
            or not _integer(point[0], MAX_TIMESTAMP)
            or point[0] % res_s
            or not first_bucket <= point[0] <= end
            or (previous is not None and point[0] <= previous)
            or not _number(point[1])
            or (minimum is not None and point[1] <= minimum)
        ):
            raise ViewError("owner_invalid_cross")
        previous = point[0]
    return [[t, v] for t, v in points]


def validate_cross(payload: dict, query: dict[str, str]) -> dict:
    now = payload["now"]
    range_name = payload.get("range")
    if (
        payload.get("asset") != query["asset"]
        or payload.get("segment") != query["segment"]
        or range_name != query["range"]
    ):
        raise ViewError("owner_identity_mismatch")
    res, res_s = AUTO_RESOLUTION[range_name]
    minutes = RANGE_MINUTES[range_name]
    start, end = payload.get("start"), payload.get("end")
    if (
        payload.get("res") != res
        or payload.get("res_s") != res_s
        or type(payload.get("res_s")) is not int
        or payload.get("auto") is not True
        or not _minute(start)
        or not _minute(end)
        or end != _last_closed(now)
        or end - start != (minutes - 1) * 60
        or payload.get("minutes") != minutes
        or not _integer(payload.get("minutes_with_median"), minutes)
        or not _integer(payload.get("venues_per_minute_max"), 128)
        or not _text(payload.get("note"), 1024)
    ):
        raise ViewError("owner_invalid_window")
    series, table = payload.get("series"), payload.get("table")
    if (
        not isinstance(series, list)
        or not isinstance(table, list)
        or len(series) > 128
        or len(series) != len(table)
    ):
        raise ViewError("owner_invalid_cross")
    limit = (end - (start // res_s) * res_s) // res_s + 1
    safe_series, safe_table, identities = [], [], set()
    for line, stats in zip(series, table):
        if not isinstance(line, dict) or not isinstance(stats, dict):
            raise ViewError("owner_invalid_cross")
        identity = (line.get("lane"), line.get("pair"))
        if (
            not _lane_identity(line, query["segment"])
            or not isinstance(line.get("pair"), str)
            or not PAIR.fullmatch(line["pair"])
            or identity in identities
            or (stats.get("lane"), stats.get("pair")) != identity
            or stats.get("venue") != line["venue"]
        ):
            raise ViewError("owner_invalid_identity")
        identities.add(identity)
        n, with_close = stats.get("n"), stats.get("minutes_with_close")
        if (
            not _integer(with_close, minutes)
            or not _integer(n, with_close)
            or stats.get("quote") != line["pair"].split("-", 1)[1]
            or not all(
                _optional_number(stats.get(k)) for k in ("mean_bps", "max_abs_bps")
            )
            or not all(
                _optional_number(stats.get(k), 0)
                for k in ("mean_abs_bps", "p95_abs_bps")
            )
            or not (
                stats.get("max_at") is None
                or (_minute(stats["max_at"]) and start <= stats["max_at"] <= end)
            )
            or (n == 0) != (stats.get("mean_bps") is None)
        ):
            raise ViewError("owner_invalid_cross_stats")
        safe_series.append(
            {
                "lane": line["lane"],
                "venue": line["venue"],
                "pair": line["pair"],
                "close": _points(line.get("close"), start, end, res_s, limit, 0),
                "deviation_bps": _points(
                    line.get("deviation_bps"), start, end, res_s, limit, None
                ),
            }
        )
        safe_table.append(
            {
                k: stats.get(k)
                for k in (
                    "lane",
                    "venue",
                    "pair",
                    "quote",
                    "n",
                    "minutes_with_close",
                    "mean_bps",
                    "mean_abs_bps",
                    "p95_abs_bps",
                    "max_abs_bps",
                    "max_at",
                )
            }
        )
    return {
        "now": now,
        "asset": query["asset"],
        "segment": query["segment"],
        "range": range_name,
        "res": res,
        "res_s": res_s,
        "start": start,
        "end": end,
        "minutes": minutes,
        "minutes_with_median": payload["minutes_with_median"],
        "venues_per_minute_max": payload["venues_per_minute_max"],
        "note": payload["note"],
        "series": safe_series,
        "table": safe_table,
    }


def validate_heatmap(payload: dict, query: dict[str, str]) -> dict:
    now = payload["now"]
    segment = query["segment"]
    if payload.get("segment") != segment:
        raise ViewError("owner_identity_mismatch")
    hours, last_closed = payload.get("hours"), payload.get("last_closed")
    if (
        payload.get("fields") != HEAT_FIELDS
        or not _minute(last_closed)
        or last_closed != _last_closed(now)
        or not isinstance(hours, list)
        or len(hours) != HEAT_HOURS
        or any(type(h) is not int for h in hours)
        or hours[-1] != (last_closed // 3600) * 3600
        or any(b - a != 3600 for a, b in zip(hours, hours[1:]))
    ):
        raise ViewError("owner_invalid_heatmap")
    rows = payload.get("rows")
    if not isinstance(rows, list) or len(rows) > 1024:
        raise ViewError("owner_invalid_heatmap")
    safe, identities = [], set()
    for row in rows:
        if (
            not isinstance(row, dict)
            or not _lane_identity(row, segment)
            or row.get("segment") != segment
            or not isinstance(row.get("pair"), str)
            or not PAIR.fullmatch(row["pair"])
            or not isinstance(row.get("asset"), str)
            or not ASSET.fullmatch(row["asset"])
            or (row["lane"], row["pair"]) in identities
        ):
            raise ViewError("owner_invalid_identity")
        identities.add((row["lane"], row["pair"]))
        cells = row.get("cells")
        if not isinstance(cells, list) or len(cells) != HEAT_HOURS:
            raise ViewError("owner_invalid_heatmap")
        for hour, cell in zip(hours, cells):
            # Only minutes that have closed can be counted: the newest hour is partial.
            closed = min(60, (last_closed - hour) // 60 + 1)
            if cell is not None and (
                not isinstance(cell, list)
                or len(cell) != len(HEAT_FIELDS)
                or not all(_integer(v, 60) for v in cell)
                or sum(cell) > closed
            ):
                raise ViewError("owner_invalid_heatmap_cell")
        safe.append(
            {
                "lane": row["lane"],
                "venue": row["venue"],
                "segment": segment,
                "pair": row["pair"],
                "asset": row["asset"],
                "cells": [None if c is None else list(c) for c in cells],
            }
        )
    return {
        "now": now,
        "segment": segment,
        "hours": list(hours),
        "fields": list(HEAT_FIELDS),
        "last_closed": last_closed,
        "rows": safe,
    }


def _days(value: Any) -> list:
    if not isinstance(value, list) or len(value) > 64:
        raise ViewError("owner_invalid_store")
    if any(
        not isinstance(d, str) or not DAY.fullmatch(d) for d in value
    ) or value != sorted(set(value)):
        raise ViewError("owner_invalid_store")
    return list(value)


def _store_text(value: Any, limit: int = 512, optional: bool = True) -> Any:
    if not _text(value, limit, optional):
        raise ViewError("owner_invalid_store")
    if isinstance(value, str) and PATH_TEXT.search(value):
        raise ViewError("owner_path_disclosure")
    return value


def validate_store(payload: dict) -> dict:
    now = payload["now"]
    status, retention, versions, config = (
        payload.get(k) for k in ("status", "retention", "versions", "config")
    )
    if not all(isinstance(x, dict) for x in (status, retention, versions, config)):
        raise ViewError("owner_invalid_store")
    process = status.get("process")
    lag = process.get("loop_lag_s") if isinstance(process, dict) else None
    if (
        type(status.get("present")) is not bool
        or not isinstance(lag, dict)
        or set(process) != {*PROCESS_KEYS, "loop_lag_s"}
        or set(lag) != set(LAG_KEYS)
        or not all(_optional_number(process[k], 0) for k in PROCESS_KEYS)
        or not all(_optional_number(lag[k], 0) for k in LAG_KEYS)
        or not _optional_number(status.get("age_s"), -5)
        or not all(
            status.get(k) is None or _integer_or_float(status[k], MAX_TIMESTAMP)
            for k in ("age_s", "started_at", "uptime_s")
        )
        or not all(
            _optional_number(status.get(k), 0) for k in ("started_at", "uptime_s")
        )
        or not _integer(status.get("fault_injections"), 1_000_000)
        or not all(
            _optional_number(retention.get(k), 0)
            and (retention.get(k) is None or retention[k] <= MAX_TIMESTAMP)
            for k in ("window_s", "margin_s", "window_days", "keep_days")
        )
        or versions.get("expected") is None
        or not isinstance(versions.get("found"), dict)
        or set(versions["found"]) != set(VERSION_KEYS)
        or not isinstance(versions.get("mismatches"), list)
        or len(versions["mismatches"]) > 8
        or not isinstance(config.get("assets"), list)
        or len(config["assets"]) > 128
        or any(
            not isinstance(a, str) or not ASSET.fullmatch(a) for a in config["assets"]
        )
        or config.get("source") not in {"argument", "status.json", "none"}
        or not _integer(payload.get("bytes_total"))
    ):
        raise ViewError("owner_invalid_store")
    expected = versions["expected"]
    if not isinstance(expected, dict) or set(expected) != set(VERSION_KEYS):
        raise ViewError("owner_invalid_store")
    lanes = payload.get("lanes")
    if not isinstance(lanes, list) or len(lanes) > 128:
        raise ViewError("owner_invalid_store")
    safe_lanes, identities, total = [], set(), 0
    for lane in lanes:
        if (
            not isinstance(lane, dict)
            or not _lane_identity(lane, None)
            or lane["lane"] in identities
        ):
            raise ViewError("owner_invalid_identity")
        identities.add(lane["lane"])
        size = lane.get("bytes")
        if (
            lane.get("segment") != lane["lane"].rsplit("__", 1)[1]
            or not isinstance(size, dict)
            or set(size) != set(FILE_KINDS)
            or not all(_integer(size[k]) for k in FILE_KINDS)
            or lane.get("bytes_total") != sum(size.values())
            or not _integer(lane.get("wal_bytes"), size["lanes"])
            or not _integer(lane.get("metrics_files"), 4096)
        ):
            raise ViewError("owner_invalid_store")
        days = _days(lane.get("days"))
        if lane.get("days_held") != len(days):
            raise ViewError("owner_invalid_store")
        total += lane["bytes_total"]
        safe_lanes.append(
            {
                "lane": lane["lane"],
                "venue": lane["venue"],
                "segment": lane["segment"],
                "bytes": {k: size[k] for k in FILE_KINDS},
                "bytes_total": lane["bytes_total"],
                "wal_bytes": lane["wal_bytes"],
                "days": days,
                "days_held": len(days),
                "sealed_days": _days(lane.get("sealed_days")),
                "metrics_files": lane["metrics_files"],
            }
        )
    if payload["bytes_total"] < total:
        raise ViewError("owner_invalid_store")
    return {
        "now": now,
        "status": {
            "present": status["present"],
            "error": _store_text(status.get("error")),
            "age_s": status.get("age_s"),
            "started_at": status.get("started_at"),
            "uptime_s": status.get("uptime_s"),
            "fatal_error": _store_text(status.get("fatal_error")),
            "process": {
                **{k: process[k] for k in PROCESS_KEYS},
                "loop_lag_s": {k: lag[k] for k in LAG_KEYS},
            },
            "fault_injections": status["fault_injections"],
        },
        "retention": {
            k: retention.get(k)
            for k in ("window_s", "margin_s", "window_days", "keep_days")
        },
        "versions": {
            "found": {k: _store_text(versions["found"][k], 64) for k in VERSION_KEYS},
            "expected": {
                k: _store_text(expected[k], 64, optional=False) for k in VERSION_KEYS
            },
            "mismatches": [
                _store_text(m, 512, optional=False) for m in versions["mismatches"]
            ],
        },
        "config": {
            "source": config["source"],
            "error": _store_text(config.get("error")),
            "assets": list(config["assets"]),
        },
        "bytes_total": payload["bytes_total"],
        "lanes": safe_lanes,
        "read_method": _store_text(payload.get("read_method"), 256, optional=False),
    }


def validate_view_payload(view: str, payload: dict, query: dict[str, str]) -> dict:
    if view == "cross":
        return validate_cross(payload, query)
    if view == "heatmap":
        return validate_heatmap(payload, query)
    return validate_store(payload)
