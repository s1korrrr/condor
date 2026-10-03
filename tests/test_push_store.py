"""Device registry, quiet hours and the worker outbox."""

import json
import sqlite3
import stat
import threading
from contextlib import contextmanager

import pytest

from condor.push import events as ev
from condor.push import store as push_store
from condor.push.store import (
    MAX_DEVICES_PER_USER,
    Outbox,
    Registry,
    RegistryError,
    backoff_seconds,
    device_id_for,
    in_quiet_hours,
    normalize_classes,
    normalize_quiet,
    normalize_token,
)
from tests.push_support import BUNDLE, TOKEN_A, TOKEN_B

NOW = 1_790_001_000.0


def _event(event_id="e1", cls="fill_entry", severity="notice", collapse="c1"):
    return ev.AlertEvent(
        id=event_id,
        cls=cls,
        severity=severity,
        title="V2 · BUY BNB-USDT",
        body="body",
        deep_link="rsibot://bot/rsi_modular_v2/fills",
        collapse_key=collapse,
        thread_id="bot:rsi_modular_v2",
        occurred_at=NOW,
        bot="rsi_modular_v2",
        bot_tag="V2",
        kind="entry",
    )


@pytest.fixture
def registry(tmp_path):
    return Registry(tmp_path / "state" / "registry.sqlite")


def _register(registry, token=TOKEN_A, user=1, **kw):
    return registry.upsert_device(
        user_id=user,
        token=token,
        platform=kw.pop("platform", "iphone"),
        bundle_id=kw.pop("bundle_id", BUNDLE),
        environment=kw.pop("environment", "sandbox"),
        app_version="1.0",
        now=kw.pop("now", NOW),
        **kw,
    )


# ------------------------------------------------------------------ registry


def test_registry_file_and_directory_are_private(registry):
    assert stat.S_IMODE(registry.path.stat().st_mode) == 0o600
    assert stat.S_IMODE(registry.path.parent.stat().st_mode) == 0o700


def test_register_is_an_upsert_by_token_and_keeps_settings_unless_given(registry):
    first = _register(
        registry,
        classes={"summary": True},
        quiet=normalize_quiet(
            {"enabled": True, "start": "23:00", "end": "06:00", "tz": "Europe/Warsaw"}
        ),
    )
    assert first.device_id == device_id_for(TOKEN_A) and first.active
    again = registry.upsert_device(
        user_id=1,
        token=TOKEN_A.upper(),
        platform="iphone",
        bundle_id=BUNDLE,
        environment="sandbox",
        app_version="1.1",
        now=NOW + 60,
    )
    assert again.device_id == first.device_id and again.app_version == "1.1"
    assert again.classes == {"summary": True} and again.quiet["tz"] == "Europe/Warsaw"
    assert again.registered_at == NOW + 60 and again.last_seen == NOW + 60
    assert len(registry.devices_for_user(1)) == 1


def test_reassigning_token_to_another_user_does_not_inherit_old_alert_preferences(
    registry,
):
    _register(
        registry,
        classes={"fill_entry": False},
        quiet=normalize_quiet(
            {
                "enabled": True,
                "start": "00:00",
                "end": "23:59",
                "tz": "UTC",
            }
        ),
    )
    new_owner = _register(registry, user=2, now=NOW + 1)
    assert new_owner.user_id == 2
    assert new_owner.classes == {}
    assert new_owner.quiet == normalize_quiet({})


def test_public_view_never_contains_the_token(registry):
    device = _register(registry)
    public = device.public()
    assert TOKEN_A not in str(public) and public["token_suffix"] == TOKEN_A[-6:]
    assert public["recipient_server_id"] == registry.recipient_server_id
    assert (
        public["classes"]["fill_entry"] is True
        and public["classes"]["summary"] is False
    )


def test_token_and_field_validation(registry):
    for bad in ("", "xyz", "g" * 64, "a" * 31, "a" * 201, None, 5):
        with pytest.raises(RegistryError):
            normalize_token(bad)
    with pytest.raises(RegistryError):
        _register(registry, platform="mac")
    with pytest.raises(RegistryError):
        normalize_classes({"fill_entry": "yes"})
    with pytest.raises(RegistryError):
        normalize_classes({"trade": True})
    with pytest.raises(RegistryError):
        normalize_classes([])


def test_device_count_is_bounded_per_user_but_re_registration_is_not_blocked(registry):
    tokens = [f"{i:02x}" * 32 for i in range(MAX_DEVICES_PER_USER)]
    for token in tokens:
        _register(registry, token=token)
    with pytest.raises(RegistryError, match="too many"):
        _register(registry, token="ff" * 32)
    _register(registry, token=tokens[0], now=NOW + 1)  # same token again is fine
    _register(registry, token="ff" * 32, user=2)  # another user has their own budget


def test_reassignment_cannot_exceed_new_owners_device_cap(registry):
    original = _register(registry, token="aa" * 32, user=1, classes={"summary": True})
    for index in range(MAX_DEVICES_PER_USER):
        _register(registry, token=f"{index + 1:02x}" * 32, user=2)
    with pytest.raises(RegistryError, match="too many registered devices"):
        _register(registry, token="aa" * 32, user=2, now=NOW + 1)
    retained = registry.get_device(original.device_id)
    assert retained.user_id == 1 and retained.classes == {"summary": True}
    assert len(registry.devices_for_user(2)) == MAX_DEVICES_PER_USER


def test_registration_response_remains_bound_to_its_committed_owner(
    registry, monkeypatch
):
    committed = threading.Event()
    release = threading.Event()
    original_transaction = push_store._transaction

    @contextmanager
    def pause_after_first_commit(db):
        with original_transaction(db):
            yield db
        if threading.current_thread().name == "register-first":
            committed.set()
            assert release.wait(timeout=5)

    monkeypatch.setattr(push_store, "_transaction", pause_after_first_commit)
    result = []
    errors = []

    def first_registration():
        try:
            result.append(_register(registry, token="aa" * 32, user=1, now=NOW))
        except Exception as error:
            errors.append(error)

    thread = threading.Thread(target=first_registration, name="register-first")
    thread.start()
    try:
        assert committed.wait(timeout=5)
        second = _register(registry, token="aa" * 32, user=2, now=NOW + 1)
    finally:
        release.set()
        thread.join(timeout=5)
    assert not thread.is_alive() and errors == []
    assert second.user_id == 2
    assert result[0].user_id == 1 and result[0].registered_at == NOW


def test_delete_is_scoped_to_the_owner(registry):
    device = _register(registry, user=1)
    assert registry.delete_device(2, device.device_id) is False
    assert registry.delete_device(1, device.device_id) is True
    assert registry.get_device(device.device_id) is None


def test_deactivation_honours_apns_timestamp_so_a_fresh_registration_wins(registry):
    device = _register(registry, now=NOW)
    assert (
        registry.deactivate(device.device_id, "Unregistered", apns_timestamp=NOW + 10)
        is True
    )
    assert registry.get_device(device.device_id).active is False
    assert registry.active_devices() == []
    again = _register(
        registry, now=NOW + 100
    )  # the app registered again after Apple saw it die
    assert again.active and again.deactivated_reason is None
    assert (
        registry.deactivate(device.device_id, "Unregistered", apns_timestamp=NOW + 10)
        is False
    )
    assert registry.get_device(device.device_id).active is True


def test_test_requests_are_rate_limited_and_scoped(registry):
    device = _register(registry)
    request = registry.add_test_request(1, [device.device_id], now=NOW)
    with pytest.raises(RegistryError, match="wait"):
        registry.add_test_request(1, [], now=NOW + 1)
    assert registry.get_request(2, request) is None
    assert registry.get_request(1, request)["state"] == "pending"
    registry.set_request(request, "done", {"ok": True}, now=NOW + 5)
    assert registry.get_request(1, request)["result"] == {"ok": True}
    for i in range(4):
        registry.add_test_request(1, [], now=NOW + 20 + 20 * i)
    with pytest.raises(RegistryError, match="too many"):
        registry.add_test_request(1, [], now=NOW + 200)


def test_meta_round_trips_and_two_handles_share_state(registry, tmp_path):
    registry.set_meta("worker_heartbeat", {"status": "running", "updated_at": NOW})
    other = Registry(registry.path)
    assert other.get_meta("worker_heartbeat") == {
        "status": "running",
        "updated_at": NOW,
    }
    assert other.get_meta("missing") is None
    _register(other)
    assert (
        len(registry.active_devices()) == 1
    )  # writes from one handle are visible to the other


# ------------------------------------------------------------------ quiet hours


def test_quiet_hours_cross_midnight_in_the_devices_time_zone():
    quiet = normalize_quiet(
        {"enabled": True, "start": "22:00", "end": "07:00", "tz": "Europe/Warsaw"}
    )
    from datetime import datetime
    from zoneinfo import ZoneInfo

    def at(hour, minute=0):
        return datetime(
            2026, 10, 2, hour, minute, tzinfo=ZoneInfo("Europe/Warsaw")
        ).timestamp()

    assert (
        in_quiet_hours(quiet, at(23))
        and in_quiet_hours(quiet, at(3))
        and in_quiet_hours(quiet, at(6, 59))
    )
    assert (
        not in_quiet_hours(quiet, at(7))
        and not in_quiet_hours(quiet, at(12))
        and not in_quiet_hours(quiet, at(21, 59))
    )
    assert in_quiet_hours(quiet, at(22))


def test_quiet_hours_same_day_window_and_disabled():
    day = normalize_quiet(
        {"enabled": True, "start": "09:00", "end": "17:00", "tz": "UTC"}
    )
    from datetime import datetime, timezone

    noon = datetime(2026, 10, 2, 12, tzinfo=timezone.utc).timestamp()
    night = datetime(2026, 10, 2, 20, tzinfo=timezone.utc).timestamp()
    assert in_quiet_hours(day, noon) and not in_quiet_hours(day, night)
    assert not in_quiet_hours(normalize_quiet({}), noon)


def test_quiet_hours_validation_and_unreadable_windows_do_not_silence_alerts():
    for bad in (
        {"enabled": True, "start": "25:00"},
        {"enabled": True, "start": "22:00", "end": "22:00"},
        {"tz": "Mars/Base"},
        {"enabled": "yes"},
        {"extra": 1},
        "nope",
    ):
        with pytest.raises(RegistryError):
            normalize_quiet(bad)
    assert (
        in_quiet_hours(
            {"enabled": True, "start": "bad", "end": "bad", "tz": "UTC"}, NOW
        )
        is False
    )


# ------------------------------------------------------------------ outbox


@pytest.fixture
def outbox(tmp_path):
    box = Outbox(tmp_path / "state" / "outbox.sqlite")
    yield box
    box.close()


def test_outbox_allows_one_owner_at_a_time(tmp_path):
    first = Outbox(tmp_path / "o.sqlite")
    with pytest.raises(RegistryError, match="another push worker"):
        Outbox(tmp_path / "o.sqlite")
    first.close()
    Outbox(tmp_path / "o.sqlite").close()


def test_activation_time_is_recorded_once(outbox):
    outbox.start_source("s", 100.0)
    outbox.start_source("s", 999.0)
    assert outbox.started("s") == 100.0 and outbox.started("nope") is None


def test_commit_records_seen_event_and_per_device_deliveries_atomically(
    outbox, registry
):
    on = _register(registry, TOKEN_A)
    off = _register(registry, TOKEN_B, classes={"fill_entry": False})
    created = outbox.commit(
        "s", seen=["k1"], events=[_event()], devices=[on, off], now=NOW
    )
    assert created == 1  # the device with the class off gets nothing
    assert (
        outbox.is_seen("s", "k1")
        and not outbox.is_seen("s", "k2")
        and not outbox.is_seen("other", "k1")
    )
    rows = outbox.due(NOW)
    assert [(r.event.id, r.device_id, r.attempts) for r in rows] == [
        ("e1", on.device_id, 0)
    ]
    assert rows[0].recipient_user_id == on.user_id
    assert rows[0].recipient_server_id == on.recipient_server_id


def test_legacy_outbox_migrates_with_queued_recipient_unbound(tmp_path):
    path = tmp_path / "legacy" / "outbox.sqlite"
    path.parent.mkdir()
    with sqlite3.connect(path) as db:
        db.execute("""CREATE TABLE deliveries (
            event_id TEXT NOT NULL, device_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL, last_error TEXT,
            apns_id TEXT, sent_at REAL, created REAL NOT NULL, updated REAL NOT NULL,
            PRIMARY KEY(event_id, device_id))""")
        db.execute("""CREATE TABLE events (
            id TEXT PRIMARY KEY, cls TEXT NOT NULL, severity TEXT NOT NULL, payload TEXT NOT NULL,
            occurred REAL NOT NULL, created REAL NOT NULL)""")
        event = _event()
        db.execute(
            "INSERT INTO events VALUES (?,?,?,?,?,?)",
            (
                event.id,
                event.cls,
                event.severity,
                json.dumps(event.to_dict()),
                event.occurred_at,
                NOW,
            ),
        )
        db.execute(
            "INSERT INTO deliveries(event_id,device_id,next_attempt,created,updated) "
            "VALUES (?,?,?,?,?)",
            (event.id, "old-device", NOW, NOW, NOW),
        )
    outbox = Outbox(path)
    try:
        assert outbox.due(NOW)[0].recipient_user_id is None
        assert outbox.due(NOW)[0].recipient_server_id is None
        columns = {
            row["name"] for row in outbox.db.execute("PRAGMA table_info(deliveries)")
        }
        assert {"recipient_user_id", "recipient_server_id"} <= columns
    finally:
        outbox.close()


def test_registry_installation_id_is_stable_per_database_and_distinct_between_databases(
    tmp_path,
):
    first = Registry(tmp_path / "first.sqlite")
    reopened = Registry(tmp_path / "first.sqlite")
    second = Registry(tmp_path / "second.sqlite")
    assert first.recipient_server_id == reopened.recipient_server_id
    assert first.recipient_server_id != second.recipient_server_id
    assert len(first.recipient_server_id) == 32


def test_replaying_a_commit_creates_no_second_delivery(outbox, registry):
    device = _register(registry)
    assert outbox.commit("s", events=[_event()], devices=[device], now=NOW) == 1
    assert outbox.commit("s", events=[_event()], devices=[device], now=NOW + 5) == 0
    assert len(outbox.due(NOW + 5)) == 1


def test_a_device_registered_after_an_event_does_not_receive_it(outbox, registry):
    outbox.commit("s", events=[_event()], devices=[], now=NOW)
    late = _register(registry, now=NOW + 10)
    outbox.commit("s", events=[_event("e2")], devices=[late], now=NOW + 10)
    assert [r.event.id for r in outbox.due(NOW + 10)] == ["e2"]


def test_always_on_test_class_ignores_a_device_that_switched_everything_off(
    outbox, registry
):
    device = _register(registry, classes={name: False for name in ev.ALERT_CLASSES})
    created = outbox.commit(
        "t", events=[_event("t1", cls="test")], devices=[device], now=NOW
    )
    assert created == 1


def test_inactive_devices_get_no_deliveries(outbox, registry):
    device = _register(registry)
    registry.deactivate(device.device_id, "Unregistered")
    assert (
        outbox.commit(
            "s",
            events=[_event()],
            devices=[registry.get_device(device.device_id)],
            now=NOW,
        )
        == 0
    )


def test_marking_sent_retry_and_failed_tracks_attempts_and_due_time(outbox, registry):
    device = _register(registry)
    outbox.commit("s", events=[_event()], devices=[device], now=NOW)
    outbox.mark("e1", device.device_id, "pending", NOW, error="503", retry_at=NOW + 30)
    assert outbox.due(NOW + 29) == [] and outbox.due(NOW + 30)[0].attempts == 1
    outbox.mark("e1", device.device_id, "sent", NOW + 31, apns_id="abc")
    assert outbox.due(NOW + 100) == [] and outbox.counts() == {"sent": 1}
    assert outbox.deliveries_for("e1")[0]["attempts"] == 2


def test_backoff_doubles_and_caps():
    assert [backoff_seconds(n) for n in (1, 2, 3, 4, 5, 6, 7, 8)] == [
        15,
        30,
        60,
        120,
        240,
        480,
        900,
        900,
    ]


def test_prune_removes_finished_deliveries_but_never_dedup_rows_or_pending_work(
    outbox, registry
):
    device = _register(registry)
    outbox.commit(
        "s",
        seen=["k1"],
        events=[_event("old"), _event("pending")],
        devices=[device],
        now=NOW,
    )
    outbox.mark("old", device.device_id, "sent", NOW)
    removed = outbox.prune(NOW + 30 * 86400, 14 * 86400)
    assert removed == 1
    assert outbox.is_seen("s", "k1")
    assert [r.event.id for r in outbox.due(NOW + 30 * 86400)] == ["pending"]
    assert outbox.db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1


def test_conditions_and_kv_persist_and_clear(outbox):
    cond = ev.Condition("k", 10.0, True, 20.0)
    outbox.commit("s", conditions={"k": cond}, now=NOW)
    assert outbox.conditions() == {"k": cond}
    outbox.commit("s", conditions={"k": None}, now=NOW)
    assert outbox.conditions() == {}
    outbox.set_kv("summary_last_date", "2026-10-02")
    assert (
        outbox.get_kv("summary_last_date") == "2026-10-02"
        and outbox.get_kv("x") is None
    )


def test_priming_is_per_source_and_kind(outbox):
    assert not outbox.is_primed("s", "executors")
    outbox.commit("s", primed="executors", now=NOW)
    assert outbox.is_primed("s", "executors") and not outbox.is_primed("t", "executors")


def test_failed_commit_rolls_back_everything(outbox, registry):
    device = _register(registry)
    outbox.db.execute(
        "DROP TABLE deliveries"
    )  # the event insert succeeds, the delivery insert cannot
    with pytest.raises(sqlite3.OperationalError):
        outbox.commit("s", seen=["k1"], events=[_event()], devices=[device], now=NOW)
    assert not outbox.is_seen("s", "k1")
    assert outbox.db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0
