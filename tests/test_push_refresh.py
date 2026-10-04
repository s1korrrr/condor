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
