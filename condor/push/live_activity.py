"""ActivityKit pushes for the fleet Live Activity (Lock Screen, Dynamic Island, Watch).

The content is a projection of Condor's fleet-summary *glance* (``condor.web.fleet_summary``);
nothing here computes PnL, equity or the market verdict. ``content_state`` maps the glance to
the shared v1 content state the app decodes (``FleetActivityAttributes.ContentState``):
decimals are strings rounded to 2 places, an unknown value is an absent key (never 0).

Pushes (``apns-push-type: liveactivity``, priority 5 so they do not count against the
ActivityKit budget) go to every active ``update`` token when the content changed or the last
send is 5 minutes old, paced by ``push.live_activity.interval_seconds``. iOS ends an activity
after 8 hours, so an activity older than ``restart_after_seconds`` (or a device with a
push-to-start token and no activity) gets one push-to-start per window. Per-token and
per-device send state lives in the outbox kv, so a restart cannot burst. Outcomes use their own
APNs client and never mix into the alert-delivery health; eligibility and the credential pause
are the Deliverer's.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from collections import Counter
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Mapping

from condor.push.apns import MAX_PAYLOAD_BYTES, ApnsClient, ApnsOutcome, ApnsRequest

if TYPE_CHECKING:
    from condor.push.config import PushConfig
    from condor.push.delivery import Deliverer
    from condor.push.store import LiveActivityToken, Outbox, Registry

logger = logging.getLogger("condor.push")

CONTENT_VERSION = 1
ATTRIBUTES_TYPE = "FleetActivityAttributes"
START_ALERT = {"title": "RSIBOT", "body": "Fleet live view"}
STATE_KEY = "live_activity_state"  # {"built_at", "tokens": {id: {...}}, "starts": {device: {...}}}
UNCHANGED_RESEND_SECONDS = (
    300.0  # an unchanged activity still hears from us every 5 minutes
)
MIN_RETRY_SECONDS = 60.0
# iOS ends an activity after 8 hours and removes it from the Lock Screen at most 4 hours later;
# an update token older than that cannot belong to a visible activity.
ACTIVITY_MAX_LIFETIME_SECONDS = 12 * 3600.0
# A freshly registered push-to-start token usually precedes the app's own activity by seconds;
# do not answer it with a second activity before the app had time to register its update token.
START_GRACE_SECONDS = 120.0
SEND_CONCURRENCY = 8
_CENT = Decimal("0.01")
_STALE_SECTION_STATES = frozenset({"stale", "missing"})


# --------------------------------------------------------------------------- content


def money(value: Any) -> str | None:
    """A decimal string rounded half-up to 2 places, or None when it is not a finite decimal."""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    try:
        number = Decimal(value)
    except (InvalidOperation, ValueError):
        return None
    if not number.is_finite():
        return None
    text = format(number.quantize(_CENT, rounding=ROUND_HALF_UP), "f")
    return "0.00" if text == "-0.00" else text


def _text(value: Any, limit: int = 64) -> str | None:
    return value[:limit] if isinstance(value, str) and value else None


def _count(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _section_status(glance: Mapping[str, Any], name: str) -> str | None:
    sections = glance.get("sections")
    section = sections.get(name) if isinstance(sections, Mapping) else None
    return section.get("status") if isinstance(section, Mapping) else None


def _section_unavailable(glance: Mapping[str, Any], name: str) -> bool:
    status = _section_status(glance, name)
    return status is None or status in _STALE_SECTION_STATES


def content_state(glance: Mapping[str, Any]) -> dict[str, Any]:
    """The v1 content state for one fleet-summary glance. Absent means unknown, never zero."""
    generated = glance.get("generated_at_ms")
    if type(generated) is not int or generated <= 0:
        raise ValueError("glance has no generation time")
    state: dict[str, Any] = {"v": CONTENT_VERSION, "generated_at_ms": generated}

    pnl = glance.get("pnl") if isinstance(glance.get("pnl"), Mapping) else {}
    day = pnl.get("day") if isinstance(pnl.get("day"), Mapping) else {}
    day_pnl = money(day.get("total"))
    if day_pnl is not None:
        state["day_pnl"] = day_pnl
        if unit := _text(pnl.get("unit"), 16):
            state["pnl_unit"] = unit
        if isinstance(day.get("partial"), bool):
            state["day_partial"] = day["partial"]

    wallet = glance.get("wallet") if isinstance(glance.get("wallet"), Mapping) else {}
    equity = money(wallet.get("equity"))
    if equity is not None:
        state["equity"] = equity
        if unit := _text(wallet.get("unit"), 16):
            state["equity_unit"] = unit

    market = glance.get("market") if isinstance(glance.get("market"), Mapping) else {}
    if label := _text(market.get("label"), 32):
        state["market_label"] = label
    if market_state := _text(market.get("state"), 32):
        state["market_state"] = market_state

    # Same reading as the app's Home tile: live (non-paper) bots, running = status "running".
    bots = glance.get("bots")
    # A stale bots section (one report out of date) still counts; a missing one is unknown.
    if isinstance(bots, list) and _section_status(glance, "bots") not in (
        None,
        "missing",
    ):
        cards = [b for b in bots if isinstance(b, Mapping)]
        live = [b for b in cards if b.get("paper") is not True]
        paper = len(cards) - len(live)
        listed_total = _count(glance.get("bots_total"))
        state["bots_running"] = sum(
            1
            for b in live
            if isinstance(b.get("status"), str) and b["status"].lower() == "running"
        )
        state["bots_total"] = (
            max(listed_total - paper, len(live))
            if listed_total is not None
            else len(live)
        )

    incidents = glance.get("incidents")
    if isinstance(incidents, Mapping):
        if incident_state := _text(incidents.get("state"), 32):
            state["incidents_state"] = incident_state
        if (open_count := _count(incidents.get("open"))) is not None:
            state["incidents_open"] = open_count

    fills = glance.get("fills")
    if isinstance(fills, list) and fills and isinstance(fills[0], Mapping):
        fill = fills[0]
        bot, pair = _text(fill.get("bot"), 100), _text(fill.get("pair"), 32)
        side = _text(fill.get("side"), 8)
        stamp = fill.get("time_ms")
        if bot and pair and side and type(stamp) is int and stamp > 0:
            state["last_fill"] = {
                "bot": bot,
                "pair": pair,
                "side": side.lower(),
                "time_ms": stamp,
            }

    state["stale"] = _section_unavailable(glance, "pnl") or _section_unavailable(
        glance, "wallet"
    )
    return state


def content_digest(state: Mapping[str, Any]) -> str:
    """Identity of what the activity shows; the generation clock alone is not a change."""
    stable = {k: v for k, v in state.items() if k != "generated_at_ms"}
    return hashlib.sha256(
        json.dumps(stable, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:32]


# --------------------------------------------------------------------------- requests


def topic_for(bundle_id: str) -> str:
    return bundle_id + ".push-type.liveactivity"


def encode(payload: Mapping[str, Any]) -> bytes:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(raw) >= MAX_PAYLOAD_BYTES:
        raise ValueError("Live Activity payload exceeds the APNs limit")
    return raw


def build_update_payload(
    state: Mapping[str, Any], *, now: float, stale_after_seconds: float
) -> dict[str, Any]:
    return {
        "aps": {
            "timestamp": int(now),
            "event": "update",
            "content-state": dict(state),
            "stale-date": int(now + stale_after_seconds),
        }
    }


def build_start_payload(
    state: Mapping[str, Any], *, server: str, now: float, stale_after_seconds: float
) -> dict[str, Any]:
    # No sound: the alert only labels the restarted activity.
    return {
        "aps": {
            "timestamp": int(now),
            "event": "start",
            "content-state": dict(state),
            "stale-date": int(now + stale_after_seconds),
            "attributes-type": ATTRIBUTES_TYPE,
            "attributes": {"server": server},
            "alert": dict(START_ALERT),
        }
    }


def build_request(
    payload: Mapping[str, Any],
    *,
    token: str,
    bundle_id: str,
    environment: str,
    key: str,
    now: float,
    stale_after_seconds: float,
) -> ApnsRequest:
    headers = {
        "apns-push-type": "liveactivity",
        "apns-topic": topic_for(bundle_id),
        "apns-priority": "5",  # not counted against the ActivityKit update budget
        "apns-expiration": str(int(now + stale_after_seconds)),
        "apns-id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"rsibot:live:{key}:{int(now)}")),
    }
    return ApnsRequest(
        environment=environment,
        path=f"/3/device/{token}",
        headers=headers,
        body=encode(payload),
    )


# --------------------------------------------------------------------------- sender


def _retry_wait(outcome: ApnsOutcome, ceiling: float) -> float:
    return min(ceiling, max(MIN_RETRY_SECONDS, outcome.retry_after or 0.0))


class LiveActivitySender:
    """Sends due Live Activity updates and restarts with its own APNs client."""

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
        self.last_start_at: float | None = None
        self.last_content_error: str | None = None

    def _targets(self) -> list["LiveActivityToken"]:
        devices = {
            d.device_id: d
            for d in self.registry.active_devices()
            if d.platform == "iphone" and self.deliverer.eligibility_error(d) is None
        }
        return [
            t
            for t in self.registry.active_live_activities()
            if t.device_id in devices
            and devices[t.device_id].user_id == t.user_id
            and self.deliverer.eligibility_error(t) is None
        ]

    def _load_state(self, targets: list["LiveActivityToken"]) -> dict[str, Any]:
        raw = self.outbox.get_kv(STATE_KEY)
        raw = raw if isinstance(raw, dict) else {}
        ids = {t.id for t in targets}
        devices = {t.device_id for t in targets}
        tokens = raw.get("tokens") if isinstance(raw.get("tokens"), dict) else {}
        starts = raw.get("starts") if isinstance(raw.get("starts"), dict) else {}
        return {
            "built_at": raw.get("built_at"),
            "tokens": {
                k: dict(v)
                for k, v in tokens.items()
                if k in ids and isinstance(v, dict)
            },
            # A device's restart window survives while it is registered, with or without tokens.
            "starts": {
                k: dict(v)
                for k, v in starts.items()
                if isinstance(v, dict)
                and (k in devices or self.registry.get_device(k) is not None)
            },
        }

    def _expire_old_activities(
        self, targets: list["LiveActivityToken"], now: float
    ) -> list["LiveActivityToken"]:
        kept = []
        for token in targets:
            if (
                token.kind == "update"
                and now - token.created_at >= ACTIVITY_MAX_LIFETIME_SECONDS
            ):
                self.registry.deactivate_live_activity(token, "ActivityEnded")
            else:
                kept.append(token)
        return kept

    def _token_due(
        self, entry: Mapping[str, Any] | None, digest: str, now: float
    ) -> bool:
        if not entry:
            return True
        retry_at = entry.get("retry_at")
        if retry_at is not None and now < retry_at:
            return False
        last = entry.get("last")
        if last is None or now < last:
            return True  # a clock that moved backwards never blocks updates forever
        elapsed = now - last
        if elapsed < self.config.live_activity.interval_seconds:
            return False
        return entry.get("digest") != digest or elapsed >= UNCHANGED_RESEND_SECONDS

    def _restarts(
        self, targets: list["LiveActivityToken"], starts: Mapping[str, Any], now: float
    ) -> list["LiveActivityToken"]:
        """The start token of every device whose activity is missing or about to be ended."""
        cfg = self.config.live_activity
        by_device: dict[str, dict[str, list["LiveActivityToken"]]] = {}
        for token in targets:
            by_device.setdefault(token.device_id, {"update": [], "start": []})[
                token.kind
            ].append(token)
        due = []
        for device_id, kinds in sorted(by_device.items()):
            if not kinds["start"]:
                continue
            start = max(kinds["start"], key=lambda t: (t.registered_at, t.id))
            newest = max((t.created_at for t in kinds["update"]), default=None)
            if newest is None:
                needed = now - start.registered_at >= START_GRACE_SECONDS
            else:
                needed = now - newest >= cfg.restart_after_seconds
            entry = starts.get(device_id) or {}
            retry_at, last = entry.get("retry_at"), entry.get("last")
            allowed = (retry_at is None or now >= retry_at) and (
                last is None or now < last or now - last >= cfg.restart_after_seconds
            )
            if needed and allowed:
                due.append(start)
        return due

    async def run(
        self, glance_source: Callable[[], Awaitable[Mapping[str, Any] | None]]
    ) -> Counter[str]:
        """One pass: build the glance once when anything may be due, then send."""
        cfg = self.config.live_activity
        now = self._clock()
        if not cfg.enabled or self.deliverer.auth_paused(now):
            return Counter()
        targets = self._expire_old_activities(self._targets(), now)
        state = self._load_state(targets)
        built_at = state["built_at"]
        if not targets or (
            isinstance(built_at, (int, float))
            and built_at <= now
            and now - built_at < cfg.interval_seconds
        ):
            self.outbox.set_kv(STATE_KEY, state)
            return Counter()
        state["built_at"] = now
        try:
            glance = await glance_source()
            content = content_state(glance) if glance is not None else None
            server = glance.get("server") if glance is not None else None
            self.last_content_error = None if content is not None else "unavailable"
        except (
            Exception
        ) as exc:  # noqa: BLE001 - a missing glance must never stop the cycle
            content, server = None, None
            self.last_content_error = exc.__class__.__name__
        if content is None:
            logger.warning(
                "live activity content unavailable error=%s", self.last_content_error
            )
            self.outbox.set_kv(STATE_KEY, state)
            return Counter({"content_unavailable": 1})
        digest = content_digest(content)
        updates = [
            t
            for t in targets
            if t.kind == "update"
            and self._token_due(state["tokens"].get(t.id), digest, now)
        ]
        starts = (
            self._restarts(targets, state["starts"], now)
            if isinstance(server, str) and server
            else []
        )
        stats = await self._send(updates, starts, content, digest, server, state, now)
        self.outbox.set_kv(STATE_KEY, state)
        if stats:
            self.last_stats = stats
        return stats

    async def _send(
        self,
        updates: list["LiveActivityToken"],
        starts: list["LiveActivityToken"],
        content: Mapping[str, Any],
        digest: str,
        server: str | None,
        state: dict[str, Any],
        now: float,
    ) -> Counter[str]:
        cfg = self.config.live_activity
        semaphore = asyncio.Semaphore(SEND_CONCURRENCY)
        update_payload = build_update_payload(
            content, now=now, stale_after_seconds=cfg.stale_after_seconds
        )
        start_payload = (
            build_start_payload(
                content,
                server=server,
                now=now,
                stale_after_seconds=cfg.stale_after_seconds,
            )
            if starts and server
            else None
        )
        try:
            for payload in (update_payload, start_payload):
                if payload is not None:
                    encode(payload)
        except ValueError:
            logger.warning("live activity payload exceeds the APNs limit; nothing sent")
            return Counter({"too_large": 1})

        async def one(token: "LiveActivityToken", payload: Mapping[str, Any]):
            async with semaphore:
                request = build_request(
                    payload,
                    token=token.token,
                    bundle_id=token.bundle_id,
                    environment=token.environment,
                    key=token.id,
                    now=now,
                    stale_after_seconds=cfg.stale_after_seconds,
                )
                return token, await self.apns.send(request)

        jobs = [one(t, update_payload) for t in updates]
        if start_payload is not None:
            jobs += [one(t, start_payload) for t in starts]
        stats: Counter[str] = Counter()
        sent: list[str] = []
        for token, outcome in await asyncio.gather(*jobs):
            is_start = token.kind == "start"
            stats[("start_" if is_start else "") + outcome.kind] += 1
            entry = (
                state["starts"].setdefault(token.device_id, {})
                if is_start
                else state["tokens"].setdefault(token.id, {})
            )
            if outcome.kind == "sent":
                entry["last"] = now
                entry.pop("retry_at", None)
                if not is_start:
                    entry["digest"] = digest
                    self.last_sent_at = now
                else:
                    self.last_start_at = now
                sent.append(token.id)
            elif outcome.kind == "dead":
                # Fenced by the registration it was sent to: a token registered again
                # meanwhile stays active.
                self.registry.deactivate_live_activity(
                    token,
                    outcome.reason or "Unregistered",
                    apns_timestamp=outcome.apns_timestamp,
                )
                if not is_start:
                    state["tokens"].pop(token.id, None)
            elif outcome.kind == "auth":
                rejected_at = self._clock()
                self.deliverer.pause_for_auth(rejected_at)
                entry["retry_at"] = rejected_at + MIN_RETRY_SECONDS
                logger.warning("live activity paused: APNs rejected the credentials")
            elif outcome.kind == "retry":
                wait = _retry_wait(outcome, float(UNCHANGED_RESEND_SECONDS))
                entry["retry_at"] = now + wait
                logger.warning(
                    "live activity %s will retry status=%s reason=%s in=%ss",
                    token.kind,
                    outcome.status,
                    outcome.reason,
                    int(wait),
                )
            else:  # rejected: retrying the same request cannot help; keep the pace
                entry["last"] = now
                entry.pop("retry_at", None)
                if not is_start:
                    entry["digest"] = digest
                logger.warning(
                    "live activity %s rejected status=%s reason=%s",
                    token.kind,
                    outcome.status,
                    outcome.reason,
                )
        self.registry.mark_live_activities_sent(sent, now)
        return stats

    def heartbeat(self) -> dict[str, Any]:
        cfg = self.config.live_activity
        return {
            "enabled": cfg.enabled,
            "interval_seconds": cfg.interval_seconds,
            "last_sent_at": self.last_sent_at,
            "last_start_at": self.last_start_at,
            "last_stats": dict(self.last_stats),
            "content_error": self.last_content_error,
            "apns_auth_ok": self.apns.auth_ok,
        }
