"""Dead-man's switch for the push sender.

The sender dies with the stack, so it cannot announce its own death. Two
independent signals cover that:

1. An optional external ping. Each healthy interval the worker GETs a
   Healthchecks-style HTTPS URL held in the private config; a degraded worker
   GETs ``<url>/fail`` instead. When the pings stop (stack, host or network
   down) the external service raises the alarm through its own integrations
   (email, ntfy, ...), none of which depend on this stack, Telegram or APNs.
2. ``GET /api/v1/push/heartbeat``: the worker's last heartbeat, which the app
   polls and treats as an alarm when stale (or when Condor itself is unreachable).

The ping URL carries the check id in its path, so only its host is ever logged.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from condor.push.config import HEARTBEAT_MAX_AGE_SECONDS, heartbeat_host


def evaluate_heartbeat(
    meta: Mapping[str, Any] | None,
    now: float,
    *,
    max_age: float = HEARTBEAT_MAX_AGE_SECONDS,
) -> dict[str, Any]:
    """What the app should believe about the sender: fresh, stale or unavailable."""
    updated = meta.get("updated_at") if isinstance(meta, Mapping) else None
    if (
        isinstance(updated, bool)
        or not isinstance(updated, (int, float))
        or updated <= 0
    ):
        return {
            "state": "unavailable",
            "max_age_seconds": max_age,
            "reason": "no worker heartbeat recorded",
        }
    age = now - updated
    status = meta.get("status")
    if age < -5:
        return {
            "state": "unavailable",
            "max_age_seconds": max_age,
            "reason": "worker clock is ahead of the server",
        }
    state = "fresh" if age <= max_age and status in ("running", "degraded") else "stale"
    keep = (
        "status",
        "updated_at",
        "last_cycle_at",
        "pending_deliveries",
        "apns",
        "sources",
        "degraded_reasons",
        "version",
    )
    return {
        "state": state,
        "age_seconds": max(age, 0.0),
        "max_age_seconds": max_age,
        **{k: meta[k] for k in keep if k in meta},
    }


def write_heartbeat_file(path: Path, payload: Mapping[str, Any]) -> None:
    temp = Path(str(path) + ".tmp")
    temp.write_text(
        json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8"
    )
    os.replace(temp, path)


def healthcheck(
    path: Path | str, *, now: float | None = None, max_age: float = 90.0
) -> bool:
    """Docker health: the worker loop wrote a heartbeat recently (APNs trouble is degraded, not dead)."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        age = (time.time() if now is None else now) - float(data["updated_at"])
        return data.get("status") in ("running", "degraded") and 0 <= age <= max_age
    except (OSError, ValueError, TypeError, KeyError):
        return False


class PingTransport(Protocol):
    async def get(self, url: str, timeout: float) -> int: ...


class AiohttpPingTransport:
    """HTTPS GET without redirects or proxies from the environment."""

    async def get(self, url: str, timeout: float) -> int:
        import aiohttp

        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=timeout), trust_env=False
        ) as session:
            async with session.get(url, allow_redirects=False) as response:
                await response.read()
                return response.status


class ExternalPing:
    def __init__(
        self,
        url: str | None,
        transport: PingTransport | None = None,
        *,
        timeout: float = 10.0,
        clock: Callable[[], float] = time.time,
    ):
        self._url = url
        self._transport = transport or AiohttpPingTransport()
        self._timeout = timeout
        self._clock = clock
        self.configured = url is not None
        self.last_success_at: float | None = None
        self.last_error: str | None = None

    @property
    def host(self) -> str | None:
        return heartbeat_host(self._url) if self._url else None

    async def ping(self, healthy: bool) -> bool:
        """One ping: success URL when healthy, ``/fail`` when not. Never raises."""
        if self._url is None:
            return False
        url = self._url.rstrip("/") + ("" if healthy else "/fail")
        try:
            status = await self._transport.get(url, self._timeout)
        except Exception as exc:  # noqa: BLE001 - a failed ping must not stop alerting
            self.last_error = "ping failed: " + exc.__class__.__name__
            return False
        if not 200 <= status < 300:
            self.last_error = f"ping answered HTTP {status}"
            return False
        self.last_success_at, self.last_error = self._clock(), None
        return True
