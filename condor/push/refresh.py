"""Silent data-refresh pushes for the iPhone app.

A background push (``content-available``, no alert, sound or badge) asks the iPhone app to
refresh the fleet now and relay it to its Watch and widgets. Nothing is shown. Apple budgets
background pushes, so they are paced (``push.refresh.interval_seconds``, 5 to 60 minutes) and
the last send is persisted so a restart cannot burst. Only iPhone registrations receive them:
the Watch holds no credential and gets its data through the iPhone relay.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import Counter
from typing import TYPE_CHECKING, Any, Callable

from condor.push.apns import ApnsClient, ApnsRequest

if TYPE_CHECKING:
    from condor.push.config import PushConfig
    from condor.push.delivery import Deliverer
    from condor.push.store import Device, Outbox, Registry

logger = logging.getLogger("condor.push")

REFRESH_KIND = "refresh"
COLLAPSE_ID = "rsibot-refresh"
STATE_KEY = "refresh_state"  # {device_id: {"last": sent_at, "retry_at": not_before}}
MIN_RETRY_SECONDS = 60.0
SEND_CONCURRENCY = 8


def build_refresh_payload(now: float) -> dict[str, Any]:
    return {
        "aps": {"content-available": 1},
        "rsibot": {"v": 1, "kind": REFRESH_KIND, "ts": int(now)},
    }


def build_refresh_request(
    *,
    token: str,
    topic: str,
    environment: str,
    device_id: str,
    now: float,
    ttl_seconds: float,
) -> ApnsRequest:
    headers = {
        "apns-topic": topic,
        "apns-push-type": "background",
        "apns-priority": "5",  # Apple requires 5 for background pushes
        "apns-expiration": str(
            int(now + ttl_seconds)
        ),  # useless once the next one is due
        "apns-collapse-id": COLLAPSE_ID,
        "apns-id": str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"rsibot:refresh:{device_id}:{int(now)}")
        ),
    }
    body = json.dumps(build_refresh_payload(now), separators=(",", ":")).encode("utf-8")
    return ApnsRequest(
        environment=environment, path=f"/3/device/{token}", headers=headers, body=body
    )


def refresh_due(now: float, last_sent: float | None, interval_seconds: float) -> bool:
    """Due after the interval; a clock that moved backwards never blocks refresh forever."""
    if last_sent is None or now < last_sent:
        return True
    return now - last_sent >= interval_seconds


def device_due(
    entry: dict[str, float] | None, now: float, interval_seconds: float
) -> bool:
    """Per device: paced by its last send; a transient failure waits for its retry time."""
    if not entry:
        return True
    retry_at = entry.get("retry_at")
    if retry_at is not None and now < retry_at:
        return False
    return refresh_due(now, entry.get("last"), interval_seconds)


class RefreshSender:
    """Sends due refresh pushes with its own APNs client, so refresh outcomes never mix into the
    alert-delivery health the heartbeat reports. Eligibility and the credential pause are the
    Deliverer's, shared with alert delivery."""

    def __init__(
        self,
        config: "PushConfig",
        registry: "Registry",
        outbox: "Outbox",
        deliverer: "Deliverer",
        apns: ApnsClient,
        *,
        clock: Callable[[], float] = time.time,
    ):
        self.config, self.registry, self.outbox, self.deliverer, self.apns = (
            config,
            registry,
            outbox,
            deliverer,
            apns,
        )
        self._clock = clock
        self.last_stats: Counter[str] = Counter()
        self.last_sent_at: float | None = None

    def _targets(self) -> list["Device"]:
        # Re-read after alert delivery: a token found dead this cycle is not pushed again.
        return [
            d
            for d in self.registry.active_devices()
            if d.platform == "iphone" and self.deliverer.eligibility_error(d) is None
        ]

    async def send_due(self) -> Counter[str]:
        cfg = self.config.refresh
        now = self._clock()
        if not cfg.enabled or self.deliverer.auth_paused(now):
            return Counter()
        targets = self._targets()
        raw = self.outbox.get_kv(STATE_KEY)
        live = {d.device_id for d in targets}
        state: dict[str, dict[str, float]] = {
            k: dict(v)
            for k, v in (raw or {}).items()
            if k in live and isinstance(v, dict)
        }
        due = [
            d
            for d in targets
            if device_due(state.get(d.device_id), now, cfg.interval_seconds)
        ]
        semaphore = asyncio.Semaphore(SEND_CONCURRENCY)

        async def one(device: "Device"):
            async with semaphore:
                request = build_refresh_request(
                    token=device.token,
                    topic=device.bundle_id,
                    environment=device.environment,
                    device_id=device.device_id,
                    now=now,
                    ttl_seconds=cfg.interval_seconds,
                )
                return device, await self.apns.send(request)

        stats: Counter[str] = Counter()
        for device, outcome in await asyncio.gather(*(one(d) for d in due)):
            stats[outcome.kind] += 1
            entry = state.setdefault(device.device_id, {})
            if outcome.kind == "sent":
                entry["last"] = now
                entry.pop("retry_at", None)
                self.last_sent_at = now
            elif outcome.kind == "dead":
                # Fenced by the registration it was sent to, like alert delivery: a token
                # re-registered meanwhile is not deactivated by this answer.
                self.registry.deactivate(
                    device.device_id,
                    outcome.reason or "Unregistered",
                    apns_timestamp=outcome.apns_timestamp,
                    expected=device,
                )
                state.pop(device.device_id, None)
            elif outcome.kind == "auth":
                rejected_at = self._clock()
                self.deliverer.pause_for_auth(rejected_at)
                entry["retry_at"] = rejected_at + MIN_RETRY_SECONDS
                logger.warning(
                    "background refresh paused: APNs rejected the credentials"
                )
            elif outcome.kind == "retry":
                wait = min(
                    float(cfg.interval_seconds),
                    max(MIN_RETRY_SECONDS, outcome.retry_after or 0.0),
                )
                entry["retry_at"] = now + wait
                logger.warning(
                    "background refresh will retry status=%s reason=%s in=%ss",
                    outcome.status,
                    outcome.reason,
                    int(wait),
                )
            else:  # rejected: retrying cannot help; keep the pace so it is not hammered
                entry["last"] = now
                entry.pop("retry_at", None)
                logger.warning(
                    "background refresh rejected status=%s reason=%s",
                    outcome.status,
                    outcome.reason,
                )
        self.outbox.set_kv(STATE_KEY, state)
        self.last_stats = stats
        return stats

    def heartbeat(self) -> dict[str, Any]:
        return {
            "enabled": self.config.refresh.enabled,
            "interval_seconds": self.config.refresh.interval_seconds,
            "last_sent_at": self.last_sent_at,
            "last_stats": dict(self.last_stats),
            "apns_auth_ok": self.apns.auth_ok,
        }
