"""Bounded, fail-closed reader of the native V5 paper runtime status file.

Source contract: hummingbot ``scripts/component_paper_runtime.py``
``PaperRuntime.status()`` (``schema_version`` 1, ``paper_runtime_schema``
``native_component_paper_runtime_v1``), written atomically as
``<bot>.status.json`` every runtime step. The V5 dashboard reads one fixed,
read-only mounted path through a pinned directory chain. It never writes,
never follows a symlink (in the file or any parent directory), and never
fabricates a value: a missing, oversized or malformed file is UNAVAILABLE with
a reason code, and an old one is STALE.
"""

from __future__ import annotations

import json
import math
import os
import re
import stat
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import HTTPException

# The shared Bots/fleet views classify a bot as paper by its ``_paper`` name suffix, so
# only a paper-suffixed identity may bind; any other name would render as live.
STATUS_NAME = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_-]{0,57}_paper)\.status\.json$")
CONTROLLER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
PAIR = re.compile(r"^[A-Z0-9]+-[A-Z0-9]+$")
HEX32 = re.compile(r"^[a-f0-9]{32}$")
HEX64 = re.compile(r"^[a-f0-9]{64}$")
MAX_STATUS_BYTES = 2 * 1024 * 1024
MAX_CONTROLLERS = 64
STALE_AFTER_SECONDS = 30  # the runtime rewrites status about twice a second
FUTURE_SKEW_SECONDS = 5


def validate_paper_read(payload: dict, *, section: str, bot: str | None, now_ms: int) -> dict:
    states = {"available", "collecting", "not_applicable", "degraded", "stale"}
    unbound = isinstance(payload, dict) and payload.get("state") in {"collecting", "degraded"} and payload.get("data") is None and payload.get("snapshot_id") is None
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != "rsibot.v5-paper.read.v1"
        or payload.get("section") != section
        or (payload.get("bot_id") != bot and not (unbound and payload.get("bot_id") is None))
        or payload.get("execution_mode") != "paper"
        or payload.get("simulated") is not True
        or payload.get("state") not in states
        or (not unbound and (not isinstance(payload.get("snapshot_id"), str) or not payload["snapshot_id"]))
        or (not unbound and (type(payload.get("generated_at_ms")) is not int or payload["generated_at_ms"] < 0 or payload["generated_at_ms"] > now_ms + FUTURE_SKEW_SECONDS * 1000))
        or (payload["state"] != "available" and not isinstance(payload.get("reason"), str))
        or (payload["state"] == "available" and payload.get("data") is None)
    ):
        raise HTTPException(502, detail={"code": "paper_read_schema_invalid"})
    try:
        encoded = json.dumps(payload, allow_nan=False)
    except (TypeError, ValueError):
        raise HTTPException(502, detail={"code": "paper_read_schema_invalid"}) from None
    if len(encoded.encode()) > MAX_STATUS_BYTES:
        raise HTTPException(502, detail={"code": "paper_read_capacity"})
    result = deepcopy(payload)
    if not unbound and now_ms - payload["generated_at_ms"] > STALE_AFTER_SECONDS * 1000:
        result.update(state="stale", reason="Paper observation source is older than 30 seconds.")
    return result


class PaperStatusError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class PaperObservation:
    """One read of the configured status file at ``observed_at`` (seconds)."""

    state: str  # FRESH | STALE | UNAVAILABLE
    reason: str
    bot_name: str | None
    observed_at: float
    status: dict[str, Any] | None = None

    @property
    def bound(self) -> bool:
        return self.state == "FRESH"


def status_file_name_valid(path: Path) -> bool:
    return STATUS_NAME.fullmatch(path.name) is not None


def read_paper_status(path: Path, *, now: float) -> PaperObservation:
    match = STATUS_NAME.fullmatch(path.name)
    bot = match.group(1) if match else None
    try:
        if bot is None or not path.is_absolute():
            raise PaperStatusError("PAPER_STATUS_PATH")
        payload = _parse(_read_regular(path))
        status = validate_status(payload, bot)
    except PaperStatusError as exc:
        return PaperObservation("UNAVAILABLE", exc.code, bot, now)
    generated = status["generated_at"]
    if generated > now + FUTURE_SKEW_SECONDS:
        return PaperObservation("UNAVAILABLE", "PAPER_STATUS_CLOCK_SKEW", bot, now)
    if now - generated > STALE_AFTER_SECONDS:
        return PaperObservation("STALE", "PAPER_STATUS_STALE", bot, now, status)
    return PaperObservation("FRESH", "PAPER_STATUS_FRESH", bot, now, status)


def _read_regular(path: Path) -> bytes:
    # Symlinked parent directories would let the mount point be redirected.
    if os.path.realpath(path.parent) != str(path.parent):
        raise PaperStatusError("PAPER_STATUS_PATH")
    descriptor = _open_pinned(path)
    try:
        return _read_descriptor(descriptor)
    except OSError:
        # EIO and similar faults on an opened status file: the owner is unavailable.
        raise PaperStatusError("PAPER_STATUS_IO") from None
    finally:
        os.close(descriptor)


def _read_descriptor(descriptor: int) -> bytes:
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode):
        raise PaperStatusError("PAPER_STATUS_NOT_REGULAR")
    if metadata.st_size > MAX_STATUS_BYTES:
        raise PaperStatusError("PAPER_STATUS_CAPACITY")
    chunks, total = [], 0
    while total <= MAX_STATUS_BYTES:
        chunk = os.read(descriptor, MAX_STATUS_BYTES + 1 - total)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    if total > MAX_STATUS_BYTES:
        raise PaperStatusError("PAPER_STATUS_CAPACITY")
    return b"".join(chunks)


def _open_pinned(path: Path) -> int:
    """Open ``path`` through a directory chain that cannot be redirected.

    Each directory is opened with ``O_NOFOLLOW`` relative to its already opened
    parent and the file relative to the last one, so no component can be swapped
    for a symlink between the canonical-path check and the open. O_NONBLOCK keeps
    a FIFO from blocking open.
    """
    cloexec = getattr(os, "O_CLOEXEC", 0)
    # O_PATH (Linux) pins a directory that is searchable but not listable, as a
    # read-only bind mount's parents may be; elsewhere fall back to O_RDONLY.
    directory_flags = (
        getattr(os, "O_PATH", os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW | cloexec
    )
    try:
        parent = os.open("/", directory_flags)
    except OSError:
        raise PaperStatusError("PAPER_STATUS_PATH") from None
    try:
        for part in path.parent.parts[1:]:
            try:
                child = os.open(part, directory_flags, dir_fd=parent)
            except FileNotFoundError:
                raise PaperStatusError("PAPER_STATUS_MISSING") from None
            except OSError:
                # ELOOP/ENOTDIR: a directory was replaced after the path check.
                raise PaperStatusError("PAPER_STATUS_PATH") from None
            os.close(parent)
            parent = child
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | cloexec
        try:
            return os.open(path.name, flags, dir_fd=parent)
        except FileNotFoundError:
            raise PaperStatusError("PAPER_STATUS_MISSING") from None
        except OSError:
            # ELOOP: the file itself is a symlink.
            raise PaperStatusError("PAPER_STATUS_NOT_REGULAR") from None
    finally:
        os.close(parent)


# The status file carries counters and epoch times; 19 digits covers any int64.
MAX_INT_DIGITS = 19
# The real runtime status nests about ten levels (custom_info bags, executor configs).
MAX_DEPTH = 32
REQUIRED_KEYS = (
    "controller_kind",
    "controllers",
    "failure",
    "generated_at",
    "native_reports",
    "process_boot_id",
    "ready",
    "reasons",
    "report_observed_at",
    "unavailable_controller_ids",
    "simulation_assumptions",
)


def _parse(raw: bytes) -> Any:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(_name):
        raise ValueError("nonfinite JSON")

    # Every number must be representable: a literal exponent such as 1e999 parses to
    # an infinite float, and an integer of hundreds of digits overflows float
    # conversion later. Both make the whole status malformed, never a fresh value.
    def finite_float(text):
        number = float(text)
        if not math.isfinite(number):
            raise ValueError("nonfinite JSON number")
        return number

    def bounded_int(text):
        if len(text.lstrip("-")) > MAX_INT_DIGITS:
            raise ValueError("JSON integer out of range")
        return int(text)

    try:
        payload = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=pairs,
            parse_constant=constant,
            parse_float=finite_float,
            parse_int=bounded_int,
        )
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise PaperStatusError("PAPER_STATUS_MALFORMED") from None
    # Projections and the response encoder recurse; a status nested deeper than the
    # runtime ever writes is malformed (checked iteratively, never recursively).
    stack = [(payload, 1)]
    while stack:
        value, depth = stack.pop()
        if depth > MAX_DEPTH:
            raise PaperStatusError("PAPER_STATUS_MALFORMED")
        if isinstance(value, dict):
            stack.extend((item, depth + 1) for item in value.values())
            stack.extend((key, depth + 1) for key in value)
        elif isinstance(value, list):
            stack.extend((item, depth + 1) for item in value)
        elif isinstance(value, str):
            # JSON escapes can produce lone surrogates, which no response can encode.
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                raise PaperStatusError("PAPER_STATUS_MALFORMED") from None
    return payload


def _finite(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _require(condition: bool) -> None:
    if not condition:
        raise PaperStatusError("PAPER_STATUS_SCHEMA")


def validate_status(payload: Any, bot: str) -> dict[str, Any]:
    """Check the identity and shape fields every projection depends on."""
    if not isinstance(payload, dict):
        raise PaperStatusError("PAPER_STATUS_MALFORMED")
    _require(payload.get("schema_version") == 1)
    _require(payload.get("paper_runtime_schema") == "native_component_paper_runtime_v1")
    _require(
        payload.get("execution_mode") == "paper" and payload.get("bot_name") == bot
    )
    _require(_finite(payload.get("generated_at")) and payload["generated_at"] > 0)
    _require(
        isinstance(payload.get("process_boot_id"), str)
        and HEX32.fullmatch(payload["process_boot_id"]) is not None
    )
    _require(
        isinstance(payload.get("source_sha256"), str)
        and HEX64.fullmatch(payload["source_sha256"]) is not None
    )
    _require(
        isinstance(payload.get("controller_kind"), str)
        and 0 < len(payload["controller_kind"]) <= 64
    )
    _require(isinstance(payload.get("ready"), bool))
    reasons = payload.get("reasons")
    _require(isinstance(reasons, list) and len(reasons) <= 64)
    _require(all(isinstance(item, str) and len(item) <= 300 for item in reasons))
    # Keys every projection indexes directly must be present, even when null.
    _require(all(key in payload for key in REQUIRED_KEYS))
    failure = payload.get("failure")
    _require(failure is None or (isinstance(failure, str) and len(failure) <= 200))
    report_time = payload.get("report_observed_at")
    _require(report_time is None or _finite(report_time))
    _require(isinstance(payload.get("native_reports"), dict))
    unavailable = payload.get("unavailable_controller_ids")
    _require(
        isinstance(unavailable, list)
        and all(isinstance(item, str) for item in unavailable)
    )
    _require(isinstance(payload.get("simulation_assumptions"), dict))
    controllers = payload.get("controllers")
    _require(isinstance(controllers, list) and len(controllers) <= MAX_CONTROLLERS)
    seen = set()
    for row in controllers:
        _require(isinstance(row, dict))
        identity = row.get("id")
        _require(
            isinstance(identity, str)
            and CONTROLLER_ID.fullmatch(identity) is not None
            and identity not in seen
        )
        seen.add(identity)
        pair = row.get("pair")
        pairs = pair if isinstance(pair, list) else [pair]
        _require(
            0 < len(pairs) <= 64
            and all(isinstance(p, str) and PAIR.fullmatch(p) for p in pairs)
        )
        _require(
            isinstance(row.get("controller_name"), str)
            and len(row["controller_name"]) <= 128
        )
        _require(isinstance(row.get("custom_info", {}), dict))
    # The runtime declares every controller it owns, and each one is either reported
    # (native_reports) or listed unavailable, never both. A truncated declaration
    # would let projections present partial inventory as complete.
    _require(bool(seen))
    reported, missing = set(payload["native_reports"]), set(unavailable)
    _require(not reported & missing and reported | missing == seen)
    retained = payload.get("retained_reports") or {}
    _require(isinstance(retained, dict) and set(retained) <= seen)
    return payload
