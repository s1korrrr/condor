"""Read the razer watch's incident log, read-only, for the ``watch`` push source.

The watch (``deploy/rsibot-stack/razer/ops/always_on.py``) appends one JSON line per incident to
``incidents.jsonl`` in its state folder. condor-push gets that folder through a read-only mount and
names the file in ``push.watch_incidents_path``. This module only reads: it opens the file for
reading, never creates, locks, renames or writes anything, and calls no control route.

Failure is visible, never silent (the worker turns each into a degraded heartbeat reason):

* ``error`` is set when nothing could be read: the folder is missing (the mount is absent), the path
  is not a regular file, or a read failed. The worker then keeps its checkpoint and tries again.
* ``bad_lines`` counts lines that are not a JSON object. They are skipped and counted; the readable
  lines still alert.

A file that does not exist inside a mounted folder is a watch that has never raised an incident: an
empty, healthy read. A last line without its newline is a write in progress and is read next time.
"""

from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MAX_BYTES = 8 * 1024 * 1024  # an incident line is a few hundred bytes; only the tail is read beyond this


@dataclass(frozen=True)
class WatchRead:
    records: list[dict[str, Any]] = field(default_factory=list)
    bad_lines: int = 0
    error: str | None = None  # a short reason code; never a path, never file content


def read_watch_records(path: Path | str) -> WatchRead:
    target = Path(path)
    try:
        descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        # The folder is mounted but the watch has not written an incident yet; a missing folder is a missing mount.
        return WatchRead() if target.parent.is_dir() else WatchRead(error="mount_missing")
    except OSError as exc:
        return WatchRead(error=f"open_failed:{exc.__class__.__name__}")
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            return WatchRead(error="not_a_file")
        tail_only = info.st_size > MAX_BYTES
        if tail_only:
            os.lseek(descriptor, info.st_size - MAX_BYTES, os.SEEK_SET)
        chunks = []
        while True:
            block = os.read(descriptor, 1 << 20)
            if not block:
                break
            chunks.append(block)
    except OSError as exc:
        return WatchRead(error=f"read_failed:{exc.__class__.__name__}")
    finally:
        os.close(descriptor)
    lines = b"".join(chunks).split(b"\n")
    lines.pop()  # after the last newline: empty, or a line still being written
    if tail_only and lines:
        lines.pop(0)  # the first line is cut in the middle
    records: list[dict[str, Any]] = []
    bad = 0
    for raw in lines:
        if not raw.strip():
            continue
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            bad += 1
            continue
        if isinstance(value, dict):
            records.append(value)
        else:
            bad += 1
    return WatchRead(records, bad)
