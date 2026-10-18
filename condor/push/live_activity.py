"""ActivityKit pushes for the fleet Live Activity (Lock Screen, Dynamic Island, Watch).

The content is a projection of Condor's fleet-summary *glance* (``condor.web.fleet_summary``);
nothing here computes PnL, equity or the market verdict. ``content_state`` maps the glance to
the shared v1 content state the app decodes (``FleetActivityAttributes.ContentState``):
decimals are strings rounded to 2 places, an unknown value is an absent key (never 0).

Content has one owner, the Condor web process: it builds the glance for every (owner, server)
with an active token and publishes ``content_state`` into the shared registry
(``publish_content``). The push worker only reads it (``read_published``); content missing or
older than twice the interval is never sent.

Pushes (``apns-push-type: liveactivity``, priority 5 so they do not count against the
ActivityKit budget) go to every active ``update`` token when the content changed or the last
send is 5 minutes old, paced by ``push.live_activity.interval_seconds``. iOS ends an activity
after 8 hours, so an activity older than ``restart_after_seconds`` (its age follows the
activity id, not a rotated token) is replaced by one push-to-start per window; a device with no
activity (dismissed or switched off in the app) is never started by the server. Per-token and
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
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext
from typing import TYPE_CHECKING, Any, Callable, Mapping

from condor.push.apns import MAX_PAYLOAD_BYTES, ApnsClient, ApnsOutcome, ApnsRequest

if TYPE_CHECKING:
    from condor.push.config import PushConfig
    from condor.push.delivery import Deliverer
    from condor.push.store import LiveActivityToken, Outbox, Registry

logger = logging.getLogger("condor.push")

CONTENT_VERSION = 1
ATTRIBUTES_TYPE = "FleetActivityAttributes"
START_ALERT = {"title": "RSIBOT", "body": "Fleet live view"}
STATE_KEY = "live_activity_state"  # {"tokens": {id: {...}}, "starts": {device: {...}}}
# Registry meta key prefix of the content Condor web publishes per (owner, server).
CONTENT_META_PREFIX = "live_activity_content"
# Registry meta key of the web publisher's last pass (counts, incl. ``dropped_pairs``).
PUBLISHER_META_KEY = "live_activity_publisher"
MAX_PUBLISHED_PAIRS = 8
UNCHANGED_RESEND_SECONDS = (
    300.0  # an unchanged activity still hears from us every 5 minutes
)
MIN_RETRY_SECONDS = 60.0
# iOS ends an activity after 8 hours and removes it from the Lock Screen at most 4 hours later;
# an update token older than that cannot belong to a visible activity.
ACTIVITY_MAX_LIFETIME_SECONDS = 12 * 3600.0
SEND_CONCURRENCY = 8
_CENT = Decimal("0.01")
_STALE_SECTION_STATES = frozenset({"stale", "missing"})


# --------------------------------------------------------------------------- content


def money(value: Any) -> str | None:
    """A decimal string rounded half-up to 2 places, or None when it is not a finite decimal."""

    if (
        isinstance(value, bool)
        or not isinstance(value, (str, int))
        or (isinstance(value, str) and len(value) > 256)
    ):
        return None
    try:
        number = Decimal(value)
    except (InvalidOperation, ValueError):
        return None
    if not number.is_finite():
        return None
    digits, exponent = number.as_tuple().digits, number.as_tuple().exponent
    if len(digits) > 128 or abs(exponent) > 128:
        return None
    try:
        with localcontext() as context:
            context.prec = max(28, len(digits) + max(exponent, 0) + 2)
            text = format(number.quantize(_CENT, rounding=ROUND_HALF_UP), "f")
    except InvalidOperation:
        return None
    if len(text) > 128:
        text = text.rstrip("0").rstrip(".") if "." in text else text
        if len(text) > 128:
            return None
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


def content_state(
    glance: Mapping[str, Any], *, stale_after_seconds: int = 600
) -> dict[str, Any]:
    """The v1 content state for one fleet-summary glance. Absent means unknown, never zero."""
    generated = glance.get("generated_at_ms")
    if type(generated) is not int or generated <= 0:
        raise ValueError("glance has no generation time")
    if type(stale_after_seconds) is not int or not 120 <= stale_after_seconds <= 3600:
        raise ValueError("invalid Live Activity stale interval")
    state: dict[str, Any] = {
        "v": CONTENT_VERSION,
        "generated_at_ms": generated,
        "stale_after_ms": stale_after_seconds * 1000,
    }

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
        # These additive qualifiers originate only from the fleet summary's admitted
        # native account scope. Legacy bot-observed values retain no coverage claim.
        scope = wallet.get("account_scope")
        wallet_status = _section_status(glance, "wallet")
        complete = wallet.get("valuation_complete")
        unpriced = wallet.get("unpriced_count")
        if (
            wallet.get("source") == "native_account_portfolio"
            and wallet.get("source_bot") is None
            and wallet.get("unit") == "USDT"
            and isinstance(scope, Mapping)
            and scope.get("account") == "master_account"
            and scope.get("connector") == "okx"
            and scope.get("market") == "spot"
            and isinstance(scope.get("identity"), str)
            and bool(scope["identity"].strip())
            and len(scope["identity"]) <= 80
            and type(complete) is bool
            and _count(unpriced) is not None
            and complete == (unpriced == 0)
            and type(wallet.get("stale")) is bool
            and wallet_status
            == (
                "partial"
                if not complete
                else "stale" if wallet.get("stale") is True else "ok"
            )
        ):
            state["equity_source"] = "native_account_portfolio"
            state["equity_valuation_complete"] = complete

    market = glance.get("market") if isinstance(glance.get("market"), Mapping) else {}
    section = glance.get("sections")
    market_section = section.get("market") if isinstance(section, Mapping) else None
    cutoff = market.get("cutoff_ms")
    expires = market.get("expires_at_ms")
    observed = (
        market_section.get("observed_at_ms")
        if isinstance(market_section, Mapping)
        else None
    )
    stale_after = (
        market_section.get("stale_after_ms")
        if isinstance(market_section, Mapping)
        else None
    )
    valid_until = (
        min(expires, cutoff + stale_after)
        if all(type(value) is int for value in (cutoff, expires, observed, stale_after))
        and cutoff == observed
        and stale_after > 0
        and cutoff <= generated + 5_000
        else None
    )
    if (
        not _section_unavailable(glance, "market")
        and market.get("freshness") == "fresh"
        and valid_until is not None
        and valid_until > generated
    ):
        state["market_valid_until_ms"] = valid_until
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
        listed_running = sum(
            isinstance(b.get("status"), str) and b["status"].lower() == "running"
            for b in live
        )
        listed_stale = sum(b.get("report_stale") is True for b in live)
        listed_total = _count(glance.get("bots_total"))
        counts = glance.get("bot_counts")
        if isinstance(counts, Mapping):
            running, total, paper_total, stale_reports = (
                _count(counts.get(key))
                for key in (
                    "live_running",
                    "live_total",
                    "paper_total",
                    "live_stale_reports",
                )
            )
            if (
                None not in (running, total, paper_total, stale_reports)
                and listed_total is not None
                and len(live) <= total <= listed_total
                and paper <= paper_total
                and total + paper_total == listed_total
                and listed_running <= running <= listed_running + total - len(live)
                and listed_stale <= stale_reports <= listed_stale + total - len(live)
            ):
                state["bots_running"], state["bots_total"] = running, total
        elif "bot_counts" not in glance and (
            listed_total is not None and listed_total == len(cards)
        ):
            # A legacy complete list is sufficient; a capped list cannot prove
            # either the fleet running count or its omitted paper population.
            state["bots_running"] = listed_running
            state["bots_total"] = len(live)

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

    state["stale"] = (
        _section_unavailable(glance, "pnl")
        or _section_unavailable(glance, "wallet")
        or wallet.get("stale") is True
    )
    return state


def content_digest(state: Mapping[str, Any]) -> str:
    """Identity of what the activity shows; the generation clock alone is not a change."""
    stable = {k: v for k, v in state.items() if k != "generated_at_ms"}
    return hashlib.sha256(
        json.dumps(stable, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:32]


# --------------------------------------------------------------------------- published content


def content_key(user_id: int, server: str) -> str:
    return f"{CONTENT_META_PREFIX}:{int(user_id)}:{server}"


def publish_content(
    registry: "Registry",
    user_id: int,
    server: str,
    state: Mapping[str, Any],
    *,
    built_at: float,
) -> None:
    """Condor web: store the content for one owner and server, with its build time."""
    registry.set_meta(
        content_key(user_id, server), {"built_at": built_at, "content": dict(state)}
    )


def read_published(
    registry: "Registry",
    user_id: int,
    server: str,
    *,
    now: float,
    max_age_seconds: float,
) -> dict[str, Any] | None:
    """The worker: the published content, or None when it is missing, malformed or too old."""
    stored = registry.get_meta(content_key(user_id, server))
    if not isinstance(stored, dict):
        return None
    built_at, content = stored.get("built_at"), stored.get("content")
    if (
        isinstance(built_at, bool)
        or not isinstance(built_at, (int, float))
        or not isinstance(content, dict)
        or content.get("v") != CONTENT_VERSION
        or built_at > now + 60  # a clock far ahead is not "fresh"
        or now - built_at > max_age_seconds
    ):
        return None
    return content


# --------------------------------------------------------------------------- requests


def topic_for(bundle_id: str) -> str:
    return bundle_id + ".push-type.liveactivity"


def encode(payload: Mapping[str, Any]) -> bytes:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(raw) >= MAX_PAYLOAD_BYTES:
        raise ValueError("Live Activity payload exceeds the APNs limit")
    return raw


def _stale_date(
    state: Mapping[str, Any], now: float, stale_after_seconds: float
) -> int:
    """Wake ActivityKit at the first source expiry, retaining the global clock."""
    deadlines = [now + stale_after_seconds]
    generated, global_age = state.get("generated_at_ms"), state.get("stale_after_ms")
    if (
        type(generated) is int
        and type(global_age) is int
        and generated > 0
        and global_age > 0
    ):
        deadlines.append((generated + global_age) / 1000)
    market_expiry = state.get("market_valid_until_ms")
    if type(market_expiry) is int and market_expiry > 0:
        deadlines.append(market_expiry / 1000)
    return int(min(deadlines))


def build_update_payload(
    state: Mapping[str, Any], *, now: float, stale_after_seconds: float
) -> dict[str, Any]:
    stale_date = _stale_date(state, now, stale_after_seconds)
    return {
        "aps": {
            "timestamp": int(now),
            "event": "update",
            "content-state": dict(state),
            "stale-date": stale_date,
        }
    }


def build_start_payload(
    state: Mapping[str, Any], *, server: str, now: float, stale_after_seconds: float
) -> dict[str, Any]:
    # No sound: the alert only labels the restarted activity.
    stale_date = _stale_date(state, now, stale_after_seconds)
    return {
        "aps": {
            "timestamp": int(now),
            "event": "start",
            "content-state": dict(state),
            "stale-date": stale_date,
            "attributes-type": ATTRIBUTES_TYPE,
            "attributes": {"server": server},
            "alert": dict(START_ALERT),
            # iOS 18+: the started activity reports a new update token to the app.
            "input-push-token": 1,
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


def _activity_start(token: "LiveActivityToken") -> float:
    """When the token's activity began; a token without a recorded start counts from itself."""
    started = token.activity_started_at
    return token.created_at if started is None else started


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
        self.last_error: str | None = None

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
                and now - _activity_start(token) >= ACTIVITY_MAX_LIFETIME_SECONDS
            ):
                self.registry.deactivate_live_activity(token, "ActivityEnded")
            else:
                kept.append(token)
        return kept

    def _pace_allows(self, entry: Mapping[str, Any] | None, now: float) -> bool:
        """Whether a token may be sent to now, whatever the content."""
        if not entry:
            return True
        retry_at = entry.get("retry_at")
        if retry_at is not None and now < retry_at:
            return False
        last = entry.get("last")
        if last is None or now < last:
            return True  # a clock that moved backwards never blocks updates forever
        return now - last >= self.config.live_activity.interval_seconds

    def _token_due(
        self, entry: Mapping[str, Any] | None, digest: str, now: float
    ) -> bool:
        """Paced, and the content changed or the activity has not heard from us in 5 min."""
        if not self._pace_allows(entry, now):
            return False
        last = (entry or {}).get("last")
        if last is None or now < last:
            return True
        return entry.get("digest") != digest or now - last >= UNCHANGED_RESEND_SECONDS

    def _restarts(
        self, targets: list["LiveActivityToken"], starts: Mapping[str, Any], now: float
    ) -> list["LiveActivityToken"]:
        """The start token of every device whose current activity has aged out.

        Only an activity iOS is about to end is replaced. A device with no activity (the
        user dismissed it, or turned it off) is never started by the server: the app owns
        that choice. At most once per ``restart_after_seconds`` per device.
        """
        cfg = self.config.live_activity
        by_device: dict[str, dict[str, list["LiveActivityToken"]]] = {}
        for token in targets:
            by_device.setdefault(token.device_id, {"update": [], "start": []})[
                token.kind
            ].append(token)
        due = []
        for device_id, kinds in sorted(by_device.items()):
            if not kinds["start"] or not kinds["update"]:
                continue
            start = max(kinds["start"], key=lambda t: (t.registered_at, t.id))
            current = max(_activity_start(t) for t in kinds["update"])
            entry = starts.get(device_id) or {}
            retry_at, last = entry.get("retry_at"), entry.get("last")
            allowed = (retry_at is None or now >= retry_at) and (
                last is None or now < last or now - last >= cfg.restart_after_seconds
            )
            if now - current >= cfg.restart_after_seconds and allowed:
                due.append(start)
        return due

    def _published(
        self, cache: dict[tuple[int, str], Any], token: "LiveActivityToken", now: float
    ) -> Mapping[str, Any] | None:
        key = (token.user_id, token.server)
        if key not in cache:
            cache[key] = read_published(
                self.registry,
                token.user_id,
                token.server,
                now=now,
                max_age_seconds=2.0 * self.config.live_activity.interval_seconds,
            )
        return cache[key]

    async def send_due(self) -> Counter[str]:
        """Send what is due, with the content Condor web published for each token's owner
        and server. Missing or old content sends nothing and counts as ``stale_source``.
        """
        cfg = self.config.live_activity
        now = self._clock()
        if not cfg.enabled or self.deliverer.auth_paused(now):
            return Counter()
        targets = self._expire_old_activities(self._targets(), now)
        state = self._load_state(targets)
        stats: Counter[str] = Counter()
        published: dict[tuple[int, str], Any] = {}
        jobs: list[tuple["LiveActivityToken", dict[str, Any], str]] = []
        for token in targets:
            if token.kind != "update":
                continue
            entry = state["tokens"].get(token.id)
            if not self._pace_allows(entry, now):
                continue
            content = self._published(published, token, now)
            if content is None:
                stats["stale_source"] += 1
                continue
            digest = content_digest(content)
            if self._token_due(entry, digest, now):
                payload = build_update_payload(
                    content, now=now, stale_after_seconds=cfg.stale_after_seconds
                )
                jobs.append((token, payload, digest))
        for start in self._restarts(targets, state["starts"], now):
            content = self._published(published, start, now)
            if content is None:
                stats["stale_source"] += 1
                continue
            payload = build_start_payload(
                content,
                server=start.server,
                now=now,
                stale_after_seconds=cfg.stale_after_seconds,
            )
            jobs.append((start, payload, content_digest(content)))
        stats.update(await self._send(jobs, state, now))
        self.outbox.set_kv(STATE_KEY, state)
        if stats:
            self.last_stats = stats
            self.last_error = None
        return stats

    def record_failure(self, exc: BaseException) -> None:
        """A pass that raised: reported in the heartbeat, never in alert health."""
        self.last_stats = Counter({"error": 1})
        self.last_error = exc.__class__.__name__

    async def _send(
        self,
        jobs: list[tuple["LiveActivityToken", dict[str, Any], str]],
        state: dict[str, Any],
        now: float,
    ) -> Counter[str]:
        cfg = self.config.live_activity
        semaphore = asyncio.Semaphore(SEND_CONCURRENCY)
        stats: Counter[str] = Counter()
        requests = []
        for token, payload, digest in jobs:
            try:
                request = build_request(
                    payload,
                    token=token.token,
                    bundle_id=token.bundle_id,
                    environment=token.environment,
                    key=token.id,
                    now=now,
                    stale_after_seconds=cfg.stale_after_seconds,
                )
            except ValueError:
                stats["too_large"] += 1
                logger.warning("live activity payload exceeds the APNs limit; not sent")
                continue
            requests.append((token, request, digest))

        async def one(token: "LiveActivityToken", request: ApnsRequest, digest: str):
            async with semaphore:
                return token, digest, await self.apns.send(request)

        sent: list[str] = []
        for token, digest, outcome in await asyncio.gather(
            *(one(*job) for job in requests)
        ):
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
            "last_error": self.last_error,
            "apns_auth_ok": self.apns.auth_ok,
            "publisher": self._publisher_pass(),
        }

    def _publisher_pass(self) -> Any:
        try:
            return self.registry.get_meta(PUBLISHER_META_KEY)
        except Exception:  # noqa: BLE001 - the heartbeat must still go out
            return None
