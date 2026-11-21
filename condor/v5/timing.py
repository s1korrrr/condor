"""Server-Timing for the V5 API routes.

A request that starts a ``Timing`` lets the code below it record how long owner calls and the paper status parse took.
The header carries only metric names and millisecond numbers: no paths, URLs, owner names or token material.
"""

from __future__ import annotations

import time
from contextvars import ContextVar, Token


class Timing:
    def __init__(self) -> None:
        self.started = time.perf_counter()
        self.owner = 0.0  # summed over calls, so concurrent calls can add up to more than ``app``
        self.owner_calls = 0
        self.parse = 0.0
        self.parses = 0

    def header(self) -> str:
        parts = [f"app;dur={_ms(time.perf_counter() - self.started)}"]
        if self.owner_calls:
            parts.append(f'owner;dur={_ms(self.owner)};desc="calls={self.owner_calls}"')
        if self.parses:
            parts.append(f"parse;dur={_ms(self.parse)}")
        return ", ".join(parts)


_current: ContextVar[Timing | None] = ContextVar("v5_server_timing", default=None)


def begin() -> tuple[Timing, Token]:
    timing = Timing()
    return timing, _current.set(timing)


def end(token: Token) -> None:
    _current.reset(token)


def record_owner(seconds: float) -> None:
    timing = _current.get()
    if timing is not None:
        timing.owner += seconds
        timing.owner_calls += 1


def record_parse(seconds: float) -> None:
    timing = _current.get()
    if timing is not None:
        timing.parse += seconds
        timing.parses += 1


def _ms(seconds: float) -> str:
    return f"{max(seconds, 0.0) * 1000:.2f}"
