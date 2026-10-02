"""The private ``push`` section: strict, path-only for secrets, no surprises."""

import pytest

from condor.push.config import (
    PushConfigError,
    bundle_allowed,
    heartbeat_host,
    parse_push_config,
)
from tests.push_support import BUNDLE, KEY_ID, TEAM

BASE = {
    "enabled": True,
    "fleet_config": "/run/fleet/telegram/worker.json",
    "key_path": "/run/secrets/apns/AuthKey_ABC123DEFG.p8",
    "key_id": KEY_ID,
    "team_id": TEAM,
    "bundle_id": BUNDLE,
    "environment": "sandbox",
}


def test_minimal_section_gets_safe_defaults():
    config = parse_push_config(BASE)
    assert (
        config.state_dir.as_posix() == "/state/push"
        and config.registry_path.name == "registry.sqlite"
    )
    assert (
        config.outbox_path.name == "outbox.sqlite"
        and config.heartbeat_path.name == "heartbeat.json"
    )
    assert config.environments == ("sandbox",) and parse_push_config(
        {**BASE, "environment": "both"}
    ).environments == ("sandbox", "production")
    assert (config.retention_days, config.max_age_seconds, config.poll_seconds) == (
        14,
        21600,
        10,
    )
    assert (
        config.heartbeat_url is None
        and config.summary.enabled is False
        and config.incident_min_severity == "critical"
    )
    assert config.labels == {
        "ok_rsi": "V1",
        "rsi_modular_v2": "V2",
        "meridian_v3": "V3",
    }
    assert config.thresholds.stale_seconds == 300


def test_every_documented_option_round_trips():
    config = parse_push_config(
        {
            **BASE,
            "environment": "both",
            "state_dir": "/state/push2",
            "heartbeat_url": "https://hc-ping.com/abc-123",
            "heartbeat_interval_seconds": 30,
            "labels": {"breakout": "BRK"},
            "quote_currencies": {"ok_rsi": "USDT"},
            "thresholds": {
                "stale_seconds": 600,
                "confirm_seconds": 120,
                "unreadable_seconds": 900,
                "recover_seconds": 90,
            },
            "incident_min_severity": "warning",
            "summary": {"enabled": True, "hour_utc": 21, "minute": 30},
            "retention_days": 30,
            "max_age_seconds": 3600,
            "poll_seconds": 15,
        }
    )
    assert config.labels["breakout"] == "BRK" and config.labels["ok_rsi"] == "V1"
    assert (
        config.thresholds.confirm_seconds == 120
        and config.summary.hour_utc == 21
        and config.quote_currencies == {"ok_rsi": "USDT"}
    )
    assert config.heartbeat_interval_seconds == 30 and config.retention_days == 30


@pytest.mark.parametrize(
    "change",
    [
        {"enabled": "yes"},
        {"unknown": 1},
        {"key_id": "short"},
        {"key_id": "abc123defg"},
        {"team_id": "2NY8A789T"},
        {"bundle_id": "rsibot"},
        {"bundle_id": "com.rsibot mobile"},
        {"environment": "staging"},
        {"key_path": "relative.p8"},
        {"key_path": "/run/../etc/key.p8"},
        {"fleet_config": ""},
        {"state_dir": "state"},
        {"labels": {"x": "a very long label that is far too long"}},
        {"quote_currencies": {"x": "not a coin"}},
        {"thresholds": {"stale_seconds": 1}},
        {"thresholds": {"bogus": 100}},
        {"incident_min_severity": "info"},
        {"summary": {"hour_utc": 24}},
        {"summary": {"enabled": "no"}},
        {"retention_days": 0},
        {"poll_seconds": 1},
        {"heartbeat_interval_seconds": 5},
        {"heartbeat_url": "http://insecure.example/x"},
    ],
)
def test_invalid_sections_are_rejected(change):
    with pytest.raises(PushConfigError):
        parse_push_config({**BASE, **change})


@pytest.mark.parametrize(
    "missing",
    [
        "enabled",
        "fleet_config",
        "key_path",
        "key_id",
        "team_id",
        "bundle_id",
        "environment",
    ],
)
def test_required_keys(missing):
    raw = {k: v for k, v in BASE.items() if k != missing}
    with pytest.raises(PushConfigError):
        parse_push_config(raw)


def test_section_must_be_an_object():
    for bad in (None, [], "x", 3):
        with pytest.raises(PushConfigError):
            parse_push_config(bad)


def test_watch_bundles_are_beneath_the_app_bundle():
    assert bundle_allowed(BUNDLE, BUNDLE) and bundle_allowed(BUNDLE, BUNDLE + ".watch")
    assert bundle_allowed(BUNDLE, BUNDLE + ".watch.app") and bundle_allowed(
        BUNDLE, BUNDLE + ".watch.app.complication"
    )
    assert (
        not bundle_allowed(BUNDLE, BUNDLE + ".watchx")
        and not bundle_allowed(BUNDLE, "com.rsibot")
        and not bundle_allowed(BUNDLE, BUNDLE + "x")
    )


def test_the_public_view_exposes_neither_paths_nor_ids():
    public = parse_push_config(
        {**BASE, "heartbeat_url": "https://hc.example/secret-id"}
    ).public()
    assert public == {"bundle_id": BUNDLE, "environments": ["sandbox"]}


def test_only_the_host_of_a_ping_url_is_loggable():
    assert heartbeat_host("https://hc-ping.com/aaaa-bbbb-secret") == "hc-ping.com"
