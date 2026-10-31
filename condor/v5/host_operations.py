"""Bounded, read-only host monitor transport. No Docker or lifecycle authority."""

import json
import math
import os
from pathlib import Path
import stat


def finite_number(text):
    value = float(text)
    if not math.isfinite(value) or abs(value) > 9007199254740991:
        raise ValueError("Unrepresentable host observation number")
    return value


def read_host_operations(path: Path, now_ms: int) -> dict:
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        if not path.is_absolute() or ".." in path.parts:
            raise ValueError("Host operations path must be absolute and normalized")
        for part in path.parts[1:-1]:
            child = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent
            )
            os.close(parent)
            parent = child
        try:
            descriptor = os.open(
                path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent
            )
        except FileNotFoundError:
            return dict(
                schema="rsibot.v5-paper.read.v1",
                section="operations",
                execution_mode="paper",
                simulated=True,
                state="collecting",
                reason="Host monitor export is not yet published.",
                data=None,
                snapshot_id=None,
                generated_at_ms=None,
            )
    except OSError as exc:
        raise ValueError("Host operations file unavailable or symlink refused") from exc
    finally:
        os.close(parent)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("Host operations must be a regular file")
        raw = stream.read(2097153)
    if len(raw) > 2097152:
        raise ValueError("Host operations byte budget exceeded")
    value = json.loads(
        raw,
        parse_float=finite_number,
        parse_constant=lambda _: (_ for _ in ()).throw(
            ValueError("Nonfinite host observation")
        ),
    )
    if (
        not isinstance(value, dict)
        or value.get("schema") != "rsibot.v5-paper.read.v1"
        or value.get("section") != "operations"
        or value.get("execution_mode") != "paper"
        or value.get("simulated") is not True
        or not isinstance(value.get("data"), dict)
        or not isinstance(value.get("snapshot_id"), str)
        or value.get("state") not in {"available", "degraded"}
    ):
        raise ValueError("Host operations identity invalid")
    stamp = value.get("generated_at_ms")
    if type(stamp) is not int or stamp < 1 or stamp > now_ms:
        raise ValueError("Host operations timestamp invalid")
    if now_ms - stamp > 90000:
        value.update(
            state="stale", reason="Host monitor export is older than 90 seconds."
        )
    return value
