"""Fleet Live Activity: token registry, content state (contract v1) and the ActivityKit sender.

The content is a projection of the fleet-summary glance; the shared fixture
``tests/fixtures/live_activity_content_v1.json`` is this builder's exact output for the
builder-generated glance example, and the iOS tests decode the same file.
"""

import asyncio
import copy
import json
import sqlite3
from pathlib import Path

import pytest

from condor.push import live_activity as la
from condor.push.config import PushConfigError, parse_push_config
from condor.push.store import MAX_LIVE_ACTIVITIES_PER_DEVICE, Registry, RegistryError
from tests.push_support import BUNDLE, TOKEN_A, TOKEN_W, WATCH_BUNDLE
from tests.test_push_config import BASE
from tests.test_push_worker import Rig

FIXTURES = Path(__file__).parent / "fixtures"
GLANCE = json.loads(
    (FIXTURES / "fleet_summary" / "summary_glance.example.json").read_text()
)
SHARED_CONTENT = FIXTURES / "live_activity_content_v1.json"
ACTIVITY = "8a1d3c55-7c2e-4f0b-9a57-2f3e0c7b1d42"
UPDATE_TOKEN = "d4" * 40
UPDATE_TOKEN_2 = "e5" * 40
START_TOKEN = "f6" * 40
LIVE_TOPIC = BUNDLE + ".push-type.liveactivity"
ENABLED = {"live_activity": {"enabled": True}}


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- config


def test_live_activity_is_off_by_default_with_the_contract_defaults():
    config = parse_push_config(BASE).live_activity
    assert (
        config.enabled,
        config.interval_seconds,
        config.stale_after_seconds,
        config.restart_after_seconds,
    ) == (False, 60, 600, 27900)
    on = parse_push_config(
        {
            **BASE,
            "live_activity": {
                "enabled": True,
                "interval_seconds": 30,
                "stale_after_seconds": 900,
                "restart_after_seconds": 25200,
            },
        }
    ).live_activity
    assert (on.enabled, on.interval_seconds, on.stale_after_seconds) == (True, 30, 900)
    assert on.restart_after_seconds == 25200


@pytest.mark.parametrize(
    "section",
    [
        {"enabled": "yes"},
        {"enabled": True, "interval_seconds": 10},
        {"enabled": True, "interval_seconds": 600},
        {"enabled": True, "stale_after_seconds": 30},
        {"enabled": True, "restart_after_seconds": 30000},
        {"enabled": True, "every": 60},
        "on",
    ],
)
def test_invalid_live_activity_sections_are_rejected(section):
    with pytest.raises(PushConfigError):
        parse_push_config({**BASE, "live_activity": section})


# --------------------------------------------------------------------------- content


def test_content_state_of_the_builder_glance_is_the_shared_fixture():
    state = la.content_state(GLANCE)
    assert state == json.loads(SHARED_CONTENT.read_text())
    assert state == {
        "v": 1,
        "generated_at_ms": 1800000030000,
        "day_pnl": "4.50",
        "pnl_unit": "USDC",
        "day_partial": True,
        "equity": "1000.00",
        "equity_unit": "USDC",
        "market_label": "Mixed",
        "market_state": "mixed",
        "bots_running": 2,  # the paper bot is not a live bot, as on the app's Home tile
        "bots_total": 2,
        "incidents_state": "critical",
        "incidents_open": 2,
        "last_fill": {
            "bot": "rsi_modular_v2",
            "pair": "ETH-USDC",
            "side": "buy",
            "time_ms": 1799999910000,
        },
        "stale": False,
    }


@pytest.mark.parametrize(
    "raw,text",
    [
        ("-68.255", "-68.26"),
        ("19746.465", "19746.47"),
        ("1000", "1000.00"),
        ("-0.001", "0.00"),
        ("0", "0.00"),
        ("1E+3", "1000.00"),
        ("NaN", None),
        ("Infinity", None),
        ("abc", None),
        (None, None),
        (True, None),
        (1.5, None),  # money is a string on the wire; a float is not trusted
    ],
)
def test_money_is_a_two_place_string_and_never_invents_a_value(raw, text):
    assert la.money(raw) == text


def test_unknown_values_are_absent_never_zero():
    glance = copy.deepcopy(GLANCE)
    glance.update(
        {"pnl": None, "wallet": None, "market": None, "incidents": None, "fills": None}
    )
    glance["sections"]["pnl"]["status"] = "missing"
    glance["sections"]["wallet"]["status"] = "missing"
    glance["sections"]["bots"]["status"] = "missing"
    state = la.content_state(glance)
    assert state == {"v": 1, "generated_at_ms": 1800000030000, "stale": True}


def test_a_day_without_a_total_omits_its_unit_and_partial_flag():
    glance = copy.deepcopy(GLANCE)
    glance["pnl"]["day"]["total"] = None
    state = la.content_state(glance)
    assert not {"day_pnl", "pnl_unit", "day_partial"} & set(state)
    assert state["equity"] == "1000.00"


@pytest.mark.parametrize(
    "section,status,stale",
    [
        ("pnl", "stale", True),
        ("pnl", "missing", True),
        ("wallet", "stale", True),
        ("wallet", "missing", True),
        ("pnl", "partial", False),
        ("market", "stale", False),  # only the PnL and wallet sections decide `stale`
        ("bots", "stale", False),
    ],
)
def test_stale_follows_the_pnl_and_wallet_sections(section, status, stale):
    glance = copy.deepcopy(GLANCE)
    glance["sections"][section]["status"] = status
    assert la.content_state(glance)["stale"] is stale


def test_a_glance_without_sections_is_stale():
    glance = copy.deepcopy(GLANCE)
    del glance["sections"]
    state = la.content_state(glance)
    assert state["stale"] is True and "bots_running" not in state


def test_bots_count_running_live_bots_against_the_live_total():
    glance = copy.deepcopy(GLANCE)
    glance["bots"][1]["status"] = "stopped"
    glance["bots_total"] = 20  # the glance lists at most 16 cards
    state = la.content_state(glance)
    assert (state["bots_running"], state["bots_total"]) == (1, 19)


def test_an_incomplete_last_fill_is_omitted_rather_than_half_filled():
    glance = copy.deepcopy(GLANCE)
    glance["fills"][0]["time_ms"] = None
    assert "last_fill" not in la.content_state(glance)


def test_a_glance_without_a_generation_time_is_refused():
    glance = copy.deepcopy(GLANCE)
    glance["generated_at_ms"] = None
    with pytest.raises(ValueError):
        la.content_state(glance)


def test_payloads_stay_far_under_the_activitykit_limit():
    state = la.content_state(GLANCE)
    update = la.encode(
        la.build_update_payload(state, now=1_800_000_040, stale_after_seconds=600)
    )
    start = la.encode(
        la.build_start_payload(
            state, server="rsibot-stack-v2", now=1_800_000_040, stale_after_seconds=600
        )
    )
    assert len(update) < 1024 and len(start) < 1024
    oversized = {**state, "market_label": "x" * 5000}
    with pytest.raises(ValueError):
        la.encode(la.build_update_payload(oversized, now=1, stale_after_seconds=600))


def test_digest_ignores_the_generation_clock_only():
    state = la.content_state(GLANCE)
    later = {**state, "generated_at_ms": state["generated_at_ms"] + 60_000}
    assert la.content_digest(state) == la.content_digest(later)
    assert la.content_digest(state) != la.content_digest({**state, "day_pnl": "4.51"})


# --------------------------------------------------------------------------- store


def _registry(tmp_path):
    registry = Registry(tmp_path / "registry.sqlite")
    iphone = registry.upsert_device(
        user_id=1,
        token=TOKEN_A,
        platform="iphone",
        bundle_id=BUNDLE,
        environment="sandbox",
        app_version="1",
        now=100.0,
    )
    watch = registry.upsert_device(
        user_id=1,
        token=TOKEN_W,
        platform="watch",
        bundle_id=WATCH_BUNDLE,
        environment="sandbox",
        app_version="1",
        now=100.0,
    )
    return registry, iphone, watch


def _register(registry, device_id, *, token=UPDATE_TOKEN, kind="update", **kw):
    fields = {
        "user_id": 1,
        "device_id": device_id,
        "kind": kind,
        "token": token,
        "environment": "sandbox",
        "bundle_id": BUNDLE,
        "activity_id": ACTIVITY if kind == "update" else None,
        "now": 200.0,
        **kw,
    }
    return registry.upsert_live_activity(**fields)


def test_registering_the_same_token_again_keeps_its_id_and_age(tmp_path):
    registry, iphone, _ = _registry(tmp_path)
    first = _register(registry, iphone.device_id)
    assert len(first.id) == 32 and first.active and first.activity_id == ACTIVITY
    again = _register(registry, iphone.device_id, now=500.0)
    assert again.id == first.id
    assert again.created_at == 200.0 and again.registered_at == 500.0
    assert again.registration_nonce != first.registration_nonce
    assert [t.id for t in registry.active_live_activities()] == [first.id]


@pytest.mark.parametrize(
    "change,message",
    [
        ({"token": "zz" * 40}, "hexadecimal"),
        ({"token": "ab" * 8}, "hexadecimal"),
        ({"token": "ab" * 101}, "hexadecimal"),
        ({"kind": "end"}, "update or start"),
        ({"activity_id": None}, "activity id"),
        ({"activity_id": "not-a-uuid"}, "activity id"),
        ({"kind": "start", "activity_id": ACTIVITY}, "no activity id"),
        ({"bundle_id": BUNDLE + ".watch"}, "bundle"),
        ({"environment": "production"}, "environment"),
    ],
)
def test_invalid_live_activity_registrations_are_refused(tmp_path, change, message):
    registry, iphone, _ = _registry(tmp_path)
    with pytest.raises(RegistryError, match=message):
        _register(registry, iphone.device_id, **change)
    assert registry.active_live_activities() == []


def test_only_the_owners_active_iphone_takes_live_activity_tokens(tmp_path):
    registry, iphone, watch = _registry(tmp_path)
    with pytest.raises(LookupError):
        _register(registry, iphone.device_id, user_id=2)
    with pytest.raises(RegistryError, match="iPhone"):
        _register(registry, watch.device_id, bundle_id=WATCH_BUNDLE)
    registry.deactivate(iphone.device_id, "Unregistered")
    with pytest.raises(RegistryError, match="not active"):
        _register(registry, iphone.device_id)


def test_removing_or_handing_over_the_device_removes_its_tokens(tmp_path):
    registry, iphone, _ = _registry(tmp_path)
    token = _register(registry, iphone.device_id)
    assert not registry.delete_live_activity(2, token.id)  # not the owner
    assert registry.delete_device(1, iphone.device_id)
    assert registry.get_live_activity(token.id) is None
    # Same APNs device token registered by another user: the old owner's activities go.
    iphone = registry.upsert_device(
        user_id=1,
        token=TOKEN_A,
        platform="iphone",
        bundle_id=BUNDLE,
        environment="sandbox",
        app_version="1",
    )
    token = _register(registry, iphone.device_id)
    registry.upsert_device(
        user_id=2,
        token=TOKEN_A,
        platform="iphone",
        bundle_id=BUNDLE,
        environment="sandbox",
        app_version="1",
    )
    assert registry.get_live_activity(token.id) is None


def test_a_deactivated_device_hides_its_tokens_from_the_sender(tmp_path):
    registry, iphone, _ = _registry(tmp_path)
    _register(registry, iphone.device_id)
    registry.deactivate(iphone.device_id, "Unregistered")
    assert registry.active_live_activities() == []


def test_tokens_per_device_are_bounded_and_dead_ones_make_room(tmp_path):
    registry, iphone, _ = _registry(tmp_path)
    tokens = [
        _register(registry, iphone.device_id, token=f"{i:02x}" * 40)
        for i in range(MAX_LIVE_ACTIVITIES_PER_DEVICE)
    ]
    with pytest.raises(RegistryError, match="too many"):
        _register(registry, iphone.device_id, token="ee" * 40)
    assert registry.deactivate_live_activity(tokens[0], "Unregistered")
    assert _register(registry, iphone.device_id, token="ee" * 40).active


def test_a_dead_answer_never_deactivates_a_token_registered_again(tmp_path):
    registry, iphone, _ = _registry(tmp_path)
    old = _register(registry, iphone.device_id)
    _register(registry, iphone.device_id, now=300.0)
    assert not registry.deactivate_live_activity(old, "BadDeviceToken")
    current = registry.get_live_activity(old.id)
    assert not registry.deactivate_live_activity(
        current, "Unregistered", apns_timestamp=250.0
    )
    assert registry.deactivate_live_activity(
        current, "Unregistered", apns_timestamp=301.0
    )
    assert registry.get_live_activity(old.id).deactivated_reason == "Unregistered"


def test_an_existing_registry_gains_the_table_without_losing_devices(tmp_path):
    path = tmp_path / "registry.sqlite"
    registry, iphone, _ = _registry(tmp_path)
    db = sqlite3.connect(path)
    db.execute("DROP TABLE live_activities")
    db.commit()
    db.close()
    reopened = Registry(path)
    assert reopened.get_device(iphone.device_id) is not None
    assert _register(reopened, iphone.device_id).active


# --------------------------------------------------------------------------- sender


class Glances:
    """The worker's glance source: the builder's example, adjustable per test."""

    def __init__(self, clock):
        self.clock = clock
        self.glance = copy.deepcopy(GLANCE)
        self.calls = 0
        self.fail = False

    async def __call__(self):
        self.calls += 1
        if self.fail:
            raise TimeoutError("fleet summary exceeded its deadline")
        return {**self.glance, "generated_at_ms": int(self.clock() * 1000)}


def live_rig(tmp_path, extra=ENABLED):
    holder = {}

    async def source():
        return await holder["glances"]()

    r = Rig(tmp_path, extra=extra, fleet_glance=source)
    holder["glances"] = r.glances = Glances(r.clock)
    for token in (UPDATE_TOKEN, UPDATE_TOKEN_2, START_TOKEN):
        r.apple.add_device(token, LIVE_TOPIC)
    r.devices()
    r.iphone = next(d for d in r.registry.active_devices() if d.platform == "iphone")
    return r


def live(r):
    return [
        q
        for q in r.apple.requests
        if q["headers"].get("apns-push-type") == "liveactivity"
    ]


def register(r, token=UPDATE_TOKEN, kind="update", activity_id=ACTIVITY):
    return r.registry.upsert_live_activity(
        user_id=1,
        device_id=r.iphone.device_id,
        kind=kind,
        token=token,
        environment="sandbox",
        bundle_id=BUNDLE,
        activity_id=activity_id if kind == "update" else None,
        now=r.clock(),
    )


def test_an_update_push_carries_the_contract_headers_and_body(tmp_path):
    r = live_rig(tmp_path)
    try:
        token = register(r)
        r.cycle()
        [request] = live(r)
        now = int(r.clock())
        assert request["path"] == f"/3/device/{UPDATE_TOKEN}"
        assert request["environment"] == "sandbox"
        headers = request["headers"]
        assert headers["apns-push-type"] == "liveactivity"
        assert headers["apns-topic"] == "com.rsibot.mobile.push-type.liveactivity"
        assert headers["apns-priority"] == "5"
        assert headers["apns-expiration"] == str(now + 600)
        body = json.loads(request["body"])
        expected = {**la.content_state(GLANCE), "generated_at_ms": now * 1000}
        assert body == {
            "aps": {
                "timestamp": now,
                "event": "update",
                "content-state": expected,
                "stale-date": now + 600,
            }
        }
        assert len(request["body"]) < 1024
        assert r.registry.get_live_activity(token.id).last_sent_at == r.clock()
    finally:
        r.close()


def test_updates_go_on_change_or_every_five_minutes_and_survive_a_restart(tmp_path):
    r = live_rig(tmp_path)
    try:
        register(r)
        r.cycle()
        assert len(live(r)) == 1
        r.cycle(30)
        assert (
            len(live(r)) == 1 and r.glances.calls == 1
        )  # not even built before the interval
        r.cycle(40)
        assert len(live(r)) == 1  # built, unchanged: nothing to send
        r.glances.glance["pnl"]["day"]["total"] = "5.25"
        r.cycle(60)
        assert len(live(r)) == 2
        assert (
            json.loads(live(r)[-1]["body"])["aps"]["content-state"]["day_pnl"] == "5.25"
        )
        r.restart()
        r.cycle(10)
        assert len(live(r)) == 2  # a restart neither rebuilds early nor bursts
        for _ in range(4):
            r.cycle(60)
        assert len(live(r)) == 2
        r.cycle(60)
        assert len(live(r)) == 3  # unchanged for 5 minutes: resent
    finally:
        r.close()


def test_every_active_update_token_gets_the_same_content(tmp_path):
    r = live_rig(tmp_path)
    try:
        register(r)
        register(r, UPDATE_TOKEN_2, activity_id="0b0f7a30-2a4e-4c8e-8f43-0d8a6c3e9b11")
        r.cycle()
        paths = sorted(q["path"] for q in live(r))
        assert paths == [f"/3/device/{UPDATE_TOKEN}", f"/3/device/{UPDATE_TOKEN_2}"]
        bodies = {q["body"] for q in live(r)}
        assert len(bodies) == 1
    finally:
        r.close()


def test_a_device_with_only_a_start_token_gets_one_push_to_start_per_window(tmp_path):
    r = live_rig(tmp_path)
    try:
        register(r, START_TOKEN, kind="start")
        r.cycle()
        assert live(r) == []  # the app is about to register its own activity
        r.cycle(120)
        [start] = live(r)
        assert start["path"] == f"/3/device/{START_TOKEN}"
        assert start["headers"]["apns-topic"] == LIVE_TOPIC
        aps = json.loads(start["body"])["aps"]
        assert aps["event"] == "start"
        assert aps["attributes-type"] == "FleetActivityAttributes"
        assert aps["attributes"] == {"server": GLANCE["server"]}
        assert aps["alert"] == {"title": "RSIBOT", "body": "Fleet live view"}
        assert "sound" not in aps
        assert aps["content-state"]["v"] == 1
        r.restart()
        for _ in range(10):
            r.cycle(600)
        assert len(live(r)) == 1  # at most once per restart window, restarts included
        r.cycle(27900 - 6000)
        assert len(live(r)) == 2
    finally:
        r.close()


def test_an_activity_near_the_8_hour_limit_is_restarted_once(tmp_path):
    r = live_rig(tmp_path)
    try:
        register(r)
        register(r, START_TOKEN, kind="start")
        r.cycle()
        assert [q["path"] for q in live(r)] == [f"/3/device/{UPDATE_TOKEN}"]
        r.cycle(27900)
        starts = [q for q in live(r) if q["path"] == f"/3/device/{START_TOKEN}"]
        assert len(starts) == 1
        r.cycle(300)
        r.cycle(300)
        starts = [q for q in live(r) if q["path"] == f"/3/device/{START_TOKEN}"]
        assert len(starts) == 1
        # The restarted activity registers its update token: no further restart is due.
        register(r, UPDATE_TOKEN_2, activity_id="0b0f7a30-2a4e-4c8e-8f43-0d8a6c3e9b11")
        r.cycle(27900 - 600)
        starts = [q for q in live(r) if q["path"] == f"/3/device/{START_TOKEN}"]
        assert len(starts) == 1
    finally:
        r.close()


def test_update_tokens_past_any_activity_lifetime_are_retired(tmp_path):
    r = live_rig(tmp_path)
    try:
        token = register(r)
        r.cycle()
        r.cycle(12 * 3600)
        assert r.registry.get_live_activity(token.id).active is False
        assert (
            r.registry.get_live_activity(token.id).deactivated_reason == "ActivityEnded"
        )
    finally:
        r.close()


@pytest.mark.parametrize(
    "dead",
    ["unregistered", "bad_token"],
    ids=["410-Unregistered", "400-BadDeviceToken"],
)
def test_a_dead_live_activity_token_is_deactivated(tmp_path, dead):
    r = live_rig(tmp_path)
    try:
        token = register(r)
        if dead == "unregistered":
            r.apple.unregistered[UPDATE_TOKEN] = r.clock() * 1000 + 1
        else:
            r.apple.valid_tokens.pop(UPDATE_TOKEN)
        r.cycle()
        assert r.registry.get_live_activity(token.id).active is False
        assert r.worker.last_cycle_error is None
        r.cycle(600)
        assert len(live(r)) == 1
        assert any(d.token == TOKEN_A for d in r.registry.active_devices())
    finally:
        r.close()


def test_disabled_live_activity_sends_nothing_and_builds_nothing(tmp_path):
    r = live_rig(tmp_path, extra=None)
    try:
        register(r)
        register(r, START_TOKEN, kind="start")
        for _ in range(5):
            r.cycle(28000)
        assert live(r) == [] and r.glances.calls == 0
        assert "live_activity" not in r.worker.heartbeat_payload(r.clock())
    finally:
        r.close()


def test_enabling_without_a_glance_source_is_refused(tmp_path):
    with pytest.raises(PushConfigError, match="glance"):
        Rig(tmp_path, extra=ENABLED)


def test_the_shared_credential_pause_holds_live_activity(tmp_path):
    r = live_rig(tmp_path)
    try:
        register(r)
        r.deliverer.pause_for_auth(r.clock() + 5)
        r.cycle()
        assert live(r) == []
        r.cycle(120)
        assert len(live(r)) == 1
    finally:
        r.close()


def test_rejected_credentials_pause_every_sender(tmp_path):
    r = live_rig(tmp_path)
    try:
        register(r)
        r.apple.script = [(403, {"reason": "InvalidProviderToken"}, None)]
        r.cycle()
        assert r.deliverer.auth_paused(r.clock())
        assert r.worker.last_cycle_error is None
        r.cycle(30)
        assert len(live(r)) == 1
        r.cycle(60)
        assert len(live(r)) == 2
    finally:
        r.close()


def test_a_failed_glance_sends_nothing_and_is_reported(tmp_path):
    r = live_rig(tmp_path)
    try:
        register(r)
        r.glances.fail = True
        r.cycle()
        assert live(r) == [] and r.worker.last_cycle_error is None
        assert r.worker.heartbeat_payload(r.clock())["live_activity"][
            "content_error"
        ] == ("TimeoutError")
        r.glances.fail = False
        r.cycle(60)
        assert len(live(r)) == 1
    finally:
        r.close()


def test_outcomes_stay_out_of_alert_health_and_show_in_the_heartbeat(tmp_path):
    r = live_rig(tmp_path)
    try:
        register(r)
        r.cycle()
        assert r.deliverer.apns.last_success_at is None
        beat = r.worker.heartbeat_payload(r.clock())["live_activity"]
        assert beat["enabled"] is True and beat["last_stats"] == {"sent": 1}
        assert beat["last_sent_at"] == r.clock() and beat["content_error"] is None
    finally:
        r.close()


def test_a_transient_failure_retries_after_a_minute(tmp_path):
    r = live_rig(tmp_path)
    try:
        register(r)
        r.apple.script = [(503, {"reason": "ServiceUnavailable"}, None)]
        r.cycle()
        r.cycle(30)
        assert len(live(r)) == 1
        r.cycle(40)
        assert len(live(r)) == 2
    finally:
        r.close()
