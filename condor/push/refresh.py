"""Silent data-refresh pushes for the iPhone app.

A background push (``content-available``, no alert, sound or badge) asks the iPhone app to
refresh the fleet now and relay it to its Watch and widgets. Nothing is shown. Apple budgets
background pushes, so they are paced (``push.refresh.interval_seconds``, 5 to 60 minutes) and
the last send is persisted so a restart cannot burst. Only iPhone registrations receive them:
the Watch holds no credential and gets its data through the iPhone relay.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from condor.push.apns import ApnsRequest

REFRESH_KIND = "refresh"
COLLAPSE_ID = "rsibot-refresh"
LAST_SENT_KEY = "refresh_last_at"


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
