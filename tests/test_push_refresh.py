"""Silent data-refresh pushes: a paced background push that makes the iPhone refresh and relay
the fleet to its Watch and widgets. Nothing is shown; nothing is sent unless enabled."""

import json

import pytest

from condor.push import refresh
from condor.push.config import PushConfigError, parse_push_config
from tests.push_support import BUNDLE, TOKEN_A, TOKEN_W
from tests.test_push_config import BASE
from tests.test_push_worker import Rig


def background(r):
    return [
        q
        for q in r.apple.requests
        if q["headers"].get("apns-push-type") == "background"
    ]


# --------------------------------------------------------------------------- request


def test_refresh_request_is_a_silent_background_push():
    request = refresh.build_refresh_request(
        token=TOKEN_A,
        topic=BUNDLE,
        environment="sandbox",
        device_id="d1",
        now=1_790_000_000.0,
        ttl_seconds=900,
    )
    assert request.path == f"/3/device/{TOKEN_A}"
    assert request.headers["apns-push-type"] == "background"
    assert request.headers["apns-priority"] == "5"
    assert request.headers["apns-topic"] == BUNDLE
    assert request.headers["apns-collapse-id"] == "rsibot-refresh"
    assert request.headers["apns-expiration"] == str(1_790_000_000 + 900)
    payload = json.loads(request.body)
    assert payload == {
        "aps": {"content-available": 1},
        "rsibot": {"v": 1, "kind": "refresh", "ts": 1_790_000_000},
    }
    assert not {"alert", "sound", "badge"} & set(payload["aps"])


def test_due_paces_by_the_interval():
    assert refresh.refresh_due(1000.0, None, 900)
    assert not refresh.refresh_due(1000.0, 500.0, 900)
    assert refresh.refresh_due(1400.0, 500.0, 900)
    # A clock that jumped backwards never blocks refresh forever.
    assert refresh.refresh_due(1000.0, 5000.0, 900)


# --------------------------------------------------------------------------- config


def test_refresh_is_off_by_default_and_bounded():
    config = parse_push_config(BASE)
    assert config.refresh.enabled is False and config.refresh.interval_seconds == 900
    enabled = parse_push_config(
        {**BASE, "refresh": {"enabled": True, "interval_seconds": 600}}
    )
    assert enabled.refresh.enabled and enabled.refresh.interval_seconds == 600


@pytest.mark.parametrize(
    "section",
    [
        {"enabled": "yes"},
        {"enabled": True, "interval_seconds": 60},
        {"enabled": True, "interval_seconds": 7200},
        {"enabled": True, "every": 600},
        "on",
    ],
)
def test_invalid_refresh_sections_are_rejected(section):
    with pytest.raises(PushConfigError):
        parse_push_config({**BASE, "refresh": section})


# --------------------------------------------------------------------------- worker


def test_enabled_refresh_reaches_iphones_only_and_is_paced_across_restarts(tmp_path):
    r = Rig(tmp_path, extra={"refresh": {"enabled": True, "interval_seconds": 600}})
    try:
        r.devices()
        r.cycle()
        sent = background(r)
        assert [q["path"] for q in sent] == [
            f"/3/device/{TOKEN_A}"
        ]  # the Watch relays via the iPhone
        assert json.loads(sent[0]["body"])["rsibot"]["kind"] == "refresh"
        r.cycle(300)
        assert len(background(r)) == 1
        r.restart()
        r.cycle(100)
        assert len(background(r)) == 1  # a restart does not reset the pace
        r.cycle(300)
        assert len(background(r)) == 2
        assert all(f"/3/device/{TOKEN_W}" != q["path"] for q in background(r))
    finally:
        r.close()


def test_disabled_refresh_sends_nothing(tmp_path):
    r = Rig(tmp_path)
    try:
        r.devices()
        for _ in range(5):
            r.cycle(900)
        assert background(r) == []
    finally:
        r.close()


def test_a_dead_token_is_deactivated_like_an_alert_delivery(tmp_path):
    r = Rig(tmp_path, extra={"refresh": {"enabled": True, "interval_seconds": 600}})
    try:
        r.devices()
        r.apple.unregistered[TOKEN_A] = r.clock() * 1000 + 1
        r.cycle()
        iphone = [d for d in r.registry.active_devices() if d.token == TOKEN_A]
        assert iphone == []
    finally:
        r.close()


def test_rejected_credentials_pause_refresh_without_stopping_the_cycle(tmp_path):
    r = Rig(tmp_path, extra={"refresh": {"enabled": True, "interval_seconds": 600}})
    try:
        r.devices()
        r.apple.script = [(403, {"reason": "InvalidProviderToken"}, None)] * 4
        r.cycle()
        assert r.worker.last_cycle_error is None
        r.apple.script = []
        r.cycle(600)
        assert background(r)[-1]["headers"]["apns-push-type"] == "background"
    finally:
        r.close()


def test_a_transient_failure_retries_soon_instead_of_waiting_a_whole_interval(tmp_path):
    r = Rig(tmp_path, extra={"refresh": {"enabled": True, "interval_seconds": 900}})
    try:
        r.devices()
        r.apple.script = [(503, {"reason": "ServiceUnavailable"}, None)]
        r.cycle()
        assert len(background(r)) == 1
        r.cycle(30)
        assert len(background(r)) == 1  # waits at least a minute
        r.cycle(40)
        assert len(background(r)) == 2  # retried well before the 15-minute interval
        r.cycle(60)
        assert len(background(r)) == 2  # delivered: back to the normal pace
    finally:
        r.close()


def test_a_rejected_refresh_is_logged_and_paced_not_hammered(tmp_path, caplog):
    r = Rig(tmp_path, extra={"refresh": {"enabled": True, "interval_seconds": 600}})
    try:
        r.devices()
        r.apple.script = [(400, {"reason": "TopicDisallowed"}, None)]
        with caplog.at_level("WARNING", logger="condor.push"):
            r.cycle()
        assert (
            "background refresh rejected" in caplog.text
            and "TopicDisallowed" in caplog.text
        )
        assert TOKEN_A not in caplog.text
        r.cycle(300)
        assert len(background(r)) == 1
        r.cycle(300)
        assert len(background(r)) == 2
    finally:
        r.close()


def test_a_credential_pause_from_alert_delivery_also_holds_refresh(tmp_path):
    r = Rig(tmp_path, extra={"refresh": {"enabled": True, "interval_seconds": 600}})
    try:
        r.devices()
        r.deliverer.pause_for_auth(r.clock() + 5)
        r.cycle()
        assert background(r) == []
        r.cycle(120)
        assert len(background(r)) == 1
    finally:
        r.close()


def test_refresh_outcomes_stay_out_of_alert_health_and_show_in_the_heartbeat(tmp_path):
    r = Rig(tmp_path, extra={"refresh": {"enabled": True, "interval_seconds": 600}})
    try:
        r.devices()
        r.cycle()
        assert r.deliverer.apns.last_success_at is None  # the alert client sent nothing
        beat = r.worker.heartbeat_payload(r.clock())
        assert beat["refresh"]["enabled"] is True
        assert beat["refresh"]["last_stats"] == {"sent": 1}
        assert beat["refresh"]["last_sent_at"] == r.clock()
        assert "apns" not in beat["degraded_reasons"]
    finally:
        r.close()


def test_disabled_refresh_adds_nothing_to_the_heartbeat(tmp_path):
    r = Rig(tmp_path)
    try:
        assert "refresh" not in r.worker.heartbeat_payload(r.clock())
    finally:
        r.close()
