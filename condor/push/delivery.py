"""Outbox to APNs: per-device delivery with retries, quiet hours and token hygiene.

Delivery is at-least-once. A crash between Apple accepting a notification and
the outbox recording it repeats the send on restart; the repeat carries the same
``apns-collapse-id``, so a device that still shows the first replaces it instead
of stacking a duplicate.
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from typing import Callable

from condor.push.apns import ApnsClient, ApnsOutcome, build_request
from condor.push.config import PushConfig
from condor.push.store import (
    MAX_ATTEMPTS,
    DeliveryRow,
    Outbox,
    Registry,
    backoff_seconds,
    in_quiet_hours,
)

AUTH_PAUSE_SECONDS = 60.0  # after Apple rejects our credentials, do not hammer it


class Deliverer:
    def __init__(
        self,
        outbox: Outbox,
        registry: Registry,
        apns: ApnsClient,
        config: PushConfig,
        *,
        clock: Callable[[], float] = time.time,
    ):
        self.outbox, self.registry, self.apns, self.config, self._clock = (
            outbox,
            registry,
            apns,
            config,
            clock,
        )
        self._auth_paused_until = 0.0
        self.last_stats: Counter[str] = Counter()

    def eligibility_error(self, device) -> str | None:
        """Why this server must not send to the device, or None. Shared by every sender."""
        if (
            device.environment not in self.config.environments
            or not self.config.allows_bundle(device.bundle_id)
        ):
            return "device environment or bundle is not enabled for this server"
        return None

    def auth_paused(self, now: float) -> bool:
        """True while Apple is rejecting our credentials; every sender honours the pause."""
        return now < self._auth_paused_until

    def pause_for_auth(self, now: float) -> None:
        self._auth_paused_until = now + AUTH_PAUSE_SECONDS

    async def deliver_due(
        self, *, limit: int = 100, concurrency: int = 8
    ) -> Counter[str]:
        now = self._clock()
        rows = self.outbox.due(now, limit)
        stats: Counter[str] = Counter()
        semaphore = asyncio.Semaphore(concurrency)

        async def one(row: DeliveryRow) -> None:
            async with semaphore:
                stats[await self._deliver(row)] += 1

        await asyncio.gather(*(one(row) for row in rows))
        self.last_stats = stats
        return stats

    async def _deliver(self, row: DeliveryRow) -> str:
        now = self._clock()
        event = row.event
        device = self.registry.get_device(row.device_id)

        def finish(state: str, error: str | None = None, **kwargs) -> str:
            self.outbox.mark(event.id, row.device_id, state, now, error=error, **kwargs)
            return state

        if device is None or not device.active:
            return finish("cancelled", "device is not registered or was deactivated")
        if not device.class_enabled(event.cls):
            return finish("suppressed", "alert class is switched off on this device")
        if now - min(row.created, event.occurred_at) > self.config.max_age_seconds:
            return finish("expired", "too old to deliver")
        if (reason := self.eligibility_error(device)) is not None:
            return finish("failed", reason)
        if self.auth_paused(now):
            return "paused"  # stays pending; retried after the pause
        quiet = in_quiet_hours(device.quiet, now) and not (
            device.quiet.get("bypass_critical", True) and event.severity == "critical"
        )
        request = build_request(
            event,
            token=device.token,
            topic=device.bundle_id,
            environment=device.environment,
            device_id=device.device_id,
            now=now,
            expires_at=min(row.created, event.occurred_at)
            + self.config.max_age_seconds,
            silent=quiet,
        )
        outcome = await self.apns.send(request)
        return self._record(row, outcome, now)

    def _record(self, row: DeliveryRow, outcome: ApnsOutcome, now: float) -> str:
        event_id, device_id = row.event.id, row.device_id
        label = f"{outcome.status or 'transport'} {outcome.reason or ''}".strip()
        if outcome.kind == "sent":
            self.outbox.mark(event_id, device_id, "sent", now, apns_id=outcome.apns_id)
            return "sent"
        if outcome.kind == "dead":
            if self.registry.deactivate(
                device_id,
                outcome.reason or "Unregistered",
                apns_timestamp=outcome.apns_timestamp,
            ):
                self.outbox.mark(event_id, device_id, "dead", now, error=label)
                return "dead"
            # Re-registered after Apple last saw the token die: it may be valid again.
            self.outbox.mark(
                event_id,
                device_id,
                "pending",
                now,
                error=label,
                retry_at=now + backoff_seconds(row.attempts + 1),
            )
            return "retry"
        if outcome.kind == "auth":
            self.pause_for_auth(now)
            self.outbox.mark(
                event_id,
                device_id,
                "pending",
                now,
                error=label,
                retry_at=now + AUTH_PAUSE_SECONDS,
                attempt=False,
            )
            return "auth"
        if outcome.kind == "retry":
            if row.attempts + 1 >= MAX_ATTEMPTS:
                self.outbox.mark(event_id, device_id, "failed", now, error=label)
                return "failed"
            delay = max(backoff_seconds(row.attempts + 1), outcome.retry_after or 0.0)
            self.outbox.mark(
                event_id, device_id, "pending", now, error=label, retry_at=now + delay
            )
            return "retry"
        self.outbox.mark(
            event_id, device_id, "failed", now, error=label
        )  # rejected: retrying cannot help
        return "failed"
