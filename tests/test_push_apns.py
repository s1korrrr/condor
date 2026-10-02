"""APNs sender and outbox delivery against a fake Apple. Nothing here touches the network."""

import asyncio
import base64
import json

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from condor.push import apns
from condor.push import events as ev
from condor.push.config import parse_push_config
from condor.push.delivery import AUTH_PAUSE_SECONDS, Deliverer
from condor.push.store import MAX_ATTEMPTS, Outbox, Registry, normalize_quiet
from tests.push_support import (
    BUNDLE,
    KEY_ID,
    TEAM,
    TOKEN_A,
    TOKEN_B,
    TOKEN_W,
    WATCH_BUNDLE,
    Clock,
    FakeApple,
    write_test_key,
)


def run(coro):
    return asyncio.run(coro)


def _event(
    event_id="e1",
    severity="notice",
    cls="fill_entry",
    body="Entry filled 0.5 BNB @ 600",
    collapse="fill:abc",
):
    return ev.AlertEvent(
        id=event_id,
        cls=cls,
        severity=severity,
        title="V2 · BUY BNB-USDT",
        body=body,
        deep_link="rsibot://bot/rsi_modular_v2/fills",
        collapse_key=collapse,
        thread_id="bot:rsi_modular_v2",
        occurred_at=1_790_000_000.0,
        bot="rsi_modular_v2",
        bot_tag="V2",
        kind="entry",
    )


@pytest.fixture
def key_path(tmp_path):
    path = tmp_path / "AuthKey_TEST.p8"
    return path, write_test_key(path)


# ------------------------------------------------------------------ provider token


def test_provider_token_is_a_valid_es256_jwt_with_raw_signature(key_path):
    path, key = key_path
    token = apns.make_provider_token(
        apns.load_signing_key(path), KEY_ID, TEAM, 1_790_000_000
    )
    head, claims, signature = token.split(".")
    unb64 = lambda t: base64.urlsafe_b64decode(t + "=" * (-len(t) % 4))  # noqa: E731
    assert json.loads(unb64(head)) == {"alg": "ES256", "kid": KEY_ID}
    assert json.loads(unb64(claims)) == {"iss": TEAM, "iat": 1_790_000_000}
    raw = unb64(signature)
    assert len(raw) == 64
    key.public_key().verify(
        encode_dss_signature(
            int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")
        ),
        f"{head}.{claims}".encode(),
        ec.ECDSA(hashes.SHA256()),
    )
    assert "=" not in token


def test_token_is_cached_for_45_minutes_and_reminted_after(key_path):
    path, _ = key_path
    clock = Clock()
    reads = []
    tokens = apns.ProviderTokens(
        path,
        KEY_ID,
        TEAM,
        clock=clock,
        loader=lambda p: reads.append(p) or apns.load_signing_key(p),
    )
    first = tokens.token()
    clock.advance(44 * 60)
    assert tokens.token() == first and len(reads) == 1
    clock.advance(2 * 60)
    second = tokens.token()
    assert second != first and len(reads) == 2
    assert (
        apns.TOKEN_TTL_SECONDS <= 50 * 60
    )  # Apple: refresh within 60 minutes; spec asks <= 50


def test_forced_refresh_respects_apples_twenty_minute_minimum(key_path):
    path, _ = key_path
    clock = Clock()
    tokens = apns.ProviderTokens(path, KEY_ID, TEAM, clock=clock)
    tokens.token()
    clock.advance(5 * 60)
    assert (
        tokens.refresh_after_rejection() is None
    )  # minting again now would be throttled
    clock.advance(16 * 60)
    assert tokens.refresh_after_rejection() is not None


def test_key_file_must_be_private_regular_and_a_p256_key(tmp_path):
    path = tmp_path / "k.p8"
    write_test_key(path)
    path.chmod(0o644)
    with pytest.raises(apns.ApnsKeyError, match="0600"):
        apns.load_signing_key(path)
    path.chmod(0o600)
    link = tmp_path / "link.p8"
    link.symlink_to(path)
    with pytest.raises(apns.ApnsKeyError):
        apns.load_signing_key(link)
    with pytest.raises(apns.ApnsKeyError):
        apns.load_signing_key(tmp_path / "missing.p8")
    bad = tmp_path / "bad.p8"
    bad.write_text(
        "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n"
    )
    bad.chmod(0o600)
    with pytest.raises(apns.ApnsKeyError) as error:
        apns.load_signing_key(bad)
    assert "not a key" not in str(error.value)
    rsa = tmp_path / "rsa.p8"
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa as rsa_mod

    rsa.write_bytes(
        rsa_mod.generate_private_key(65537, 2048).private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    rsa.chmod(0o600)
    with pytest.raises(apns.ApnsKeyError, match="P-256"):
        apns.load_signing_key(rsa)


def test_key_errors_never_contain_the_key_path_contents(tmp_path):
    path = tmp_path / "secret.p8"
    path.write_text("TOP-SECRET-MATERIAL")
    path.chmod(0o600)
    with pytest.raises(apns.ApnsKeyError) as error:
        apns.load_signing_key(path)
    assert "TOP-SECRET" not in str(error.value) and "TOP-SECRET" not in repr(
        error.value
    )


# ------------------------------------------------------------------ request building


def test_request_has_apples_headers_and_a_deep_linked_payload():
    clock = Clock()
    request = apns.build_request(
        _event(),
        token=TOKEN_A,
        topic=BUNDLE,
        environment="sandbox",
        device_id="d1",
        now=clock(),
        expires_at=clock() + 3600,
        silent=False,
    )
    assert request.path == f"/3/device/{TOKEN_A}" and request.environment == "sandbox"
    h = request.headers
    assert (
        h["apns-topic"] == BUNDLE
        and h["apns-push-type"] == "alert"
        and h["apns-priority"] == "10"
    )
    assert h["apns-collapse-id"] == "fill:abc" and h["apns-expiration"] == str(
        int(clock() + 3600)
    )
    assert (
        h["apns-id"]
        == apns.build_request(  # stable per event and device across retries
            _event(),
            token=TOKEN_A,
            topic=BUNDLE,
            environment="sandbox",
            device_id="d1",
            now=clock(),
            expires_at=clock() + 3600,
            silent=False,
        ).headers["apns-id"]
    )
    payload = json.loads(request.body)
    assert payload["aps"] == {
        "alert": {"title": "V2 · BUY BNB-USDT", "body": "Entry filled 0.5 BNB @ 600"},
        "thread-id": "bot:rsi_modular_v2",
        "category": "RSIBOT_FILL",
        "interruption-level": "active",
        "sound": "default",
    }
    assert payload["rsibot"] == {
        "v": 1,
        "id": "e1",
        "class": "fill_entry",
        "kind": "entry",
        "link": "rsibot://bot/rsi_modular_v2/fills",
        "ts": 1_790_000_000,
        "bot": "rsi_modular_v2",
    }


def test_severity_maps_to_interruption_level_priority_and_sound():
    def build(severity, silent=False):
        r = apns.build_request(
            _event(severity=severity),
            token=TOKEN_A,
            topic=BUNDLE,
            environment="sandbox",
            device_id="d",
            now=0,
            expires_at=900,
            silent=silent,
        )
        return r.headers["apns-priority"], json.loads(r.body)["aps"]

    assert (
        build("info")[0] == "5"
        and "sound" not in build("info")[1]
        and build("info")[1]["interruption-level"] == "passive"
    )
    assert build("notice")[1]["interruption-level"] == "active"
    for severity in ("warning", "critical"):
        priority, aps = build(severity)
        assert (priority, aps["interruption-level"], aps["sound"]) == (
            "10",
            "time-sensitive",
            "default",
        )
    priority, aps = build("critical", silent=True)  # quiet hours: arrives without sound
    assert (priority, aps["interruption-level"]) == (
        "5",
        "passive",
    ) and "sound" not in aps


def test_expiration_never_lands_in_the_past():
    r = apns.build_request(
        _event(),
        token=TOKEN_A,
        topic=BUNDLE,
        environment="sandbox",
        device_id="d",
        now=1000,
        expires_at=10,
        silent=False,
    )
    assert int(r.headers["apns-expiration"]) >= 1060


def test_payload_is_shortened_to_fit_apples_4kb_before_anything_is_dropped():
    request = apns.build_request(
        _event(body="x " * 5000),
        token=TOKEN_A,
        topic=BUNDLE,
        environment="sandbox",
        device_id="d",
        now=0,
        expires_at=3600,
        silent=False,
    )
    assert len(request.body) <= 4096
    assert (
        json.loads(request.body)["rsibot"]["link"]
        == "rsibot://bot/rsi_modular_v2/fills"
    )  # deep link intact


def test_collapse_ids_over_64_bytes_cannot_even_be_built():
    with pytest.raises(ValueError):
        _event(collapse="c" * 65)


# ------------------------------------------------------------------ client


def _client(key_path, clock=None, **kw):
    path, key = key_path
    clock = clock or Clock()
    apple = FakeApple(key.public_key(), clock)
    apple.add_device(TOKEN_A)
    client = apns.ApnsClient(
        apns.ProviderTokens(path, KEY_ID, TEAM, clock=clock), apple, clock=clock, **kw
    )
    return client, apple, clock


def _req(token=TOKEN_A, topic=BUNDLE, event=None, silent=False, environment="sandbox"):
    return apns.build_request(
        event or _event(),
        token=token,
        topic=topic,
        environment=environment,
        device_id="d",
        now=0,
        expires_at=3600,
        silent=silent,
    )


def test_a_valid_send_is_accepted_by_the_fake_apple_with_a_verified_token(key_path):
    client, apple, clock = _client(key_path)
    outcome = run(client.send(_req()))
    assert outcome.ok and outcome.status == 200 and outcome.apns_id
    assert apple.requests[0]["headers"]["authorization"].startswith("bearer ")
    assert (
        client.auth_ok is True
        and client.last_success_at == clock()
        and client.consecutive_failures == 0
    )


def test_classification_follows_apples_documented_statuses():
    assert apns.classify(200, None) == "sent"
    assert (
        apns.classify(410, "Unregistered") == "dead"
        and apns.classify(400, "BadDeviceToken") == "dead"
    )
    for reason in (
        "DeviceTokenNotForTopic",
        "BadTopic",
        "TopicDisallowed",
        "PayloadEmpty",
        "BadCollapseId",
    ):
        assert apns.classify(400, reason) == "rejected"
    assert apns.classify(403, "InvalidProviderToken") == "auth"
    assert (
        apns.classify(405, "MethodNotAllowed") == "rejected"
        and apns.classify(413, "PayloadTooLarge") == "rejected"
    )
    assert apns.classify(429, "TooManyRequests") == "retry"
    assert (
        apns.classify(500, "InternalServerError") == "retry"
        and apns.classify(503, "ServiceUnavailable") == "retry"
    )


@pytest.mark.parametrize(
    "token,kind,reason",
    [("d4" * 32, "dead", "BadDeviceToken")],
)
def test_unknown_tokens_are_dead(key_path, token, kind, reason):
    client, _, _ = _client(key_path)
    outcome = run(client.send(_req(token=token)))
    assert (outcome.kind, outcome.reason) == (kind, reason)


def test_unregistered_410_carries_the_timestamp_apple_saw_the_token_die(key_path):
    client, apple, _ = _client(key_path)
    apple.unregistered[TOKEN_A] = 1_790_000_123_000
    outcome = run(client.send(_req()))
    assert (outcome.kind, outcome.status, outcome.apns_timestamp) == (
        "dead",
        410,
        1_790_000_123.0,
    )


def test_wrong_topic_is_a_rejection_not_a_dead_token(key_path):
    client, apple, _ = _client(key_path)
    apple.add_device(TOKEN_W, WATCH_BUNDLE)
    outcome = run(client.send(_req(token=TOKEN_W, topic=BUNDLE)))
    assert (outcome.kind, outcome.reason) == ("rejected", "DeviceTokenNotForTopic")


def test_expired_provider_token_is_refreshed_once_and_the_send_succeeds(key_path):
    client, apple, clock = _client(key_path)
    client.tokens.token()
    clock.advance(
        25 * 60
    )  # cached token is older than the 20-minute minimum, so a new one may be minted
    apple.script = [
        (403, {"reason": "ExpiredProviderToken"}, {})
    ]  # e.g. Apple disagrees about the clock
    outcome = run(client.send(_req()))
    assert outcome.ok and len(apple.requests) == 2
    assert (
        apple.requests[0]["headers"]["authorization"]
        != apple.requests[1]["headers"]["authorization"]
    )


def test_expired_token_that_cannot_be_refreshed_yet_is_an_auth_failure(key_path):
    client, apple, _ = _client(key_path)
    apple.script = [(403, {"reason": "ExpiredProviderToken"}, {})]
    outcome = run(client.send(_req()))
    assert (
        outcome.kind == "auth" and len(apple.requests) == 1 and client.auth_ok is False
    )


def test_invalid_key_material_fails_as_auth_without_calling_apple(tmp_path):
    clock = Clock()
    path = tmp_path / "missing.p8"
    key = write_test_key(tmp_path / "other.p8")
    apple = FakeApple(key.public_key(), clock)
    client = apns.ApnsClient(
        apns.ProviderTokens(path, KEY_ID, TEAM, clock=clock), apple, clock=clock
    )
    outcome = run(client.send(_req()))
    assert (
        outcome.kind == "auth"
        and outcome.reason.startswith("KeyUnavailable")
        and apple.requests == []
    )


def test_a_token_signed_by_a_different_key_is_rejected_by_apple(tmp_path):
    clock = Clock()
    path = tmp_path / "k.p8"
    write_test_key(path)
    other = write_test_key(tmp_path / "other.p8")
    apple = FakeApple(other.public_key(), clock)
    apple.add_device(TOKEN_A)
    client = apns.ApnsClient(
        apns.ProviderTokens(path, KEY_ID, TEAM, clock=clock), apple, clock=clock
    )
    outcome = run(client.send(_req()))
    assert (outcome.kind, outcome.reason) == ("auth", "InvalidProviderToken")


def test_throttling_server_errors_and_transport_failures_are_retryable(key_path):
    client, apple, _ = _client(key_path)
    apple.script = [
        (429, {"reason": "TooManyRequests"}, {"retry-after": "120"}),
        (503, {"reason": "ServiceUnavailable"}, {}),
        asyncio.TimeoutError(),
        ConnectionResetError(),
    ]
    first, second, third, fourth = (run(client.send(_req())) for _ in range(4))
    assert (first.kind, first.retry_after) == ("retry", 120.0)
    assert second.kind == "retry"
    assert (third.kind, third.reason) == ("retry", "Transport:TimeoutError")
    assert fourth.reason == "Transport:ConnectionResetError"
    assert client.consecutive_failures == 4 and client.last_error


def test_missing_http2_library_degrades_instead_of_crashing(key_path):
    class NoH2:
        async def post(self, **kw):
            raise apns.ApnsDependencyError("h2 missing")

        async def close(self):
            pass

    path, _ = key_path
    client = apns.ApnsClient(apns.ProviderTokens(path, KEY_ID, TEAM), NoH2())
    outcome = run(client.send(_req()))
    assert (outcome.kind, outcome.reason) == ("retry", "MissingHttp2Dependency")


def test_the_real_transport_names_the_exact_package_to_add_when_h2_is_absent(
    monkeypatch,
):
    import builtins

    real = builtins.__import__

    def blocked(name, *a, **k):
        if name == "h2":
            raise ImportError(name)
        return real(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", blocked)
    with pytest.raises(apns.ApnsDependencyError, match=r"h2==4\.4\.1"):
        apns.HttpxApnsTransport()._client("sandbox")


# ------------------------------------------------------------------ delivery


def _config(tmp_path, **raw):
    base = {
        "enabled": True,
        "fleet_config": "/run/fleet/telegram/worker.json",
        "state_dir": str(tmp_path),
        "key_path": "/run/secrets/apns/AuthKey_ABC123DEFG.p8",
        "key_id": KEY_ID,
        "team_id": TEAM,
        "bundle_id": BUNDLE,
        "environment": "both",
    }
    return parse_push_config({**base, **raw})


class Rig:
    def __init__(self, tmp_path, key_path, **config):
        self.clock = Clock()
        path, key = key_path
        self.apple = FakeApple(key.public_key(), self.clock)
        self.registry = Registry(tmp_path / "registry.sqlite")
        self.outbox = Outbox(tmp_path / "outbox.sqlite")
        self.client = apns.ApnsClient(
            apns.ProviderTokens(path, KEY_ID, TEAM, clock=self.clock),
            self.apple,
            clock=self.clock,
        )
        self.config = _config(tmp_path, **config)
        self.deliverer = Deliverer(
            self.outbox, self.registry, self.client, self.config, clock=self.clock
        )

    def device(self, token=TOKEN_A, **kw):
        self.apple.add_device(token, kw.get("bundle_id", BUNDLE))
        return self.registry.upsert_device(
            user_id=1,
            token=token,
            platform=kw.pop("platform", "iphone"),
            bundle_id=kw.pop("bundle_id", BUNDLE),
            environment=kw.pop("environment", "sandbox"),
            app_version="1",
            now=self.clock(),
            **kw,
        )

    def enqueue(self, event=None, devices=None):
        devices = devices if devices is not None else self.registry.active_devices()
        return self.outbox.commit(
            "s", events=[event or _event()], devices=devices, now=self.clock()
        )

    def deliver(self):
        return run(self.deliverer.deliver_due())

    def close(self):
        self.outbox.close()


@pytest.fixture
def rig(tmp_path, key_path):
    r = Rig(tmp_path, key_path)
    yield r
    r.close()


def test_delivery_sends_to_each_device_with_its_own_topic_and_environment(rig):
    rig.device(TOKEN_A)
    rig.device(
        TOKEN_W, platform="watch", bundle_id=WATCH_BUNDLE, environment="production"
    )
    rig.enqueue()
    assert dict(rig.deliver()) == {"sent": 2}
    seen = {(r["environment"], r["headers"]["apns-topic"]) for r in rig.apple.requests}
    assert seen == {("sandbox", BUNDLE), ("production", WATCH_BUNDLE)}
    assert rig.outbox.counts() == {"sent": 2}
    assert rig.deliver() == {}  # nothing left to do


def test_dead_tokens_are_deactivated_and_never_retried(rig):
    device = rig.device()
    rig.apple.valid_tokens.pop(TOKEN_A)
    rig.enqueue()
    assert dict(rig.deliver()) == {"dead": 1}
    assert rig.registry.get_device(device.device_id).active is False
    assert (
        rig.registry.get_device(device.device_id).deactivated_reason == "BadDeviceToken"
    )
    rig.enqueue(_event("e2"))  # a deactivated device gets no further deliveries
    assert rig.deliver() == {}


def test_410_for_a_token_reregistered_after_apple_saw_it_die_is_retried_not_deactivated(
    rig,
):
    device = rig.device()
    rig.apple.unregistered[TOKEN_A] = (
        rig.clock() - 3600
    ) * 1000  # died an hour ago; registered since
    rig.enqueue()
    assert dict(rig.deliver()) == {"retry": 1}
    assert rig.registry.get_device(device.device_id).active is True


def test_transient_failures_back_off_then_succeed(rig):
    rig.device()
    rig.apple.script = [(503, {"reason": "ServiceUnavailable"}, {})]
    rig.enqueue()
    assert dict(rig.deliver()) == {"retry": 1}
    assert rig.deliver() == {}  # not due yet
    rig.clock.advance(14)
    assert rig.deliver() == {}
    rig.clock.advance(2)
    assert dict(rig.deliver()) == {"sent": 1}
    assert rig.outbox.deliveries_for("e1")[0]["attempts"] == 2


def test_retry_after_from_apple_extends_the_backoff(rig):
    rig.device()
    rig.apple.script = [(429, {"reason": "TooManyRequests"}, {"retry-after": "300"})]
    rig.enqueue()
    rig.deliver()
    rig.clock.advance(200)
    assert rig.deliver() == {}
    rig.clock.advance(101)
    assert dict(rig.deliver()) == {"sent": 1}


def test_a_delivery_gives_up_after_the_attempt_budget(rig):
    rig.device()
    rig.apple.script = [(500, {"reason": "InternalServerError"}, {})] * MAX_ATTEMPTS
    rig.enqueue()
    for _ in range(MAX_ATTEMPTS):
        rig.deliver()
        rig.clock.advance(1000)
    assert rig.outbox.deliveries_for("e1")[0][
        "state"
    ] == "failed" and rig.outbox.counts() == {"failed": 1}


def test_stale_events_expire_instead_of_arriving_hours_late(rig):
    rig.device()
    rig.enqueue()
    rig.clock.advance(rig.config.max_age_seconds + 1)
    assert dict(rig.deliver()) == {"expired": 1} and rig.apple.requests == []


def test_an_event_that_happened_long_ago_expires_even_if_it_was_only_just_queued(rig):
    rig.device()
    old = ev.AlertEvent(
        id="old1",
        cls="fill_entry",
        severity="notice",
        title="V2 · BUY BNB-USDT",
        body="Entry filled",
        deep_link="rsibot://bot/rsi_modular_v2/fills",
        collapse_key="fill:old",
        thread_id="bot:rsi_modular_v2",
        occurred_at=rig.clock() - rig.config.max_age_seconds - 60,
        bot="rsi_modular_v2",
        bot_tag="V2",
        kind="entry",
    )
    rig.enqueue(old)  # e.g. the worker was down for a day and just caught up
    assert dict(rig.deliver()) == {"expired": 1} and rig.apple.requests == []


def test_settings_changed_after_queueing_are_honoured_at_send_time(rig):
    device = rig.device()
    rig.enqueue()
    rig.registry.upsert_device(
        user_id=1,
        token=TOKEN_A,
        platform="iphone",
        bundle_id=BUNDLE,
        environment="sandbox",
        app_version="1",
        classes={"fill_entry": False},
        now=rig.clock(),
    )
    assert dict(rig.deliver()) == {"suppressed": 1} and rig.apple.requests == []
    assert rig.registry.get_device(device.device_id).active


def test_unregistered_devices_are_cancelled(rig):
    device = rig.device()
    rig.enqueue()
    rig.registry.delete_device(1, device.device_id)
    assert dict(rig.deliver()) == {"cancelled": 1}


def test_quiet_hours_deliver_silently_and_critical_bypasses_by_default(rig):
    quiet = normalize_quiet(
        {"enabled": True, "start": "00:00", "end": "23:59", "tz": "UTC"}
    )
    rig.device(quiet=quiet)
    rig.enqueue(_event("n1", severity="notice"))
    rig.enqueue(_event("c1", severity="critical", collapse="c:1"))
    rig.deliver()
    by_id = {p["rsibot"]["id"]: p["aps"] for p in rig.apple.payloads}
    assert by_id["n1"]["interruption-level"] == "passive" and "sound" not in by_id["n1"]
    assert (
        by_id["c1"]["interruption-level"] == "time-sensitive"
        and by_id["c1"]["sound"] == "default"
    )


def test_critical_can_be_made_to_respect_quiet_hours(rig):
    quiet = normalize_quiet(
        {
            "enabled": True,
            "start": "00:00",
            "end": "23:59",
            "tz": "UTC",
            "bypass_critical": False,
        }
    )
    rig.device(quiet=quiet)
    rig.enqueue(_event("c1", severity="critical", collapse="c:1"))
    rig.deliver()
    assert rig.apple.payloads[0]["aps"]["interruption-level"] == "passive"


def test_rejected_credentials_pause_sending_instead_of_hammering_apple(rig):
    rig.device()
    rig.device(TOKEN_B)
    rig.apple.script = [(403, {"reason": "InvalidProviderToken"}, {})]
    rig.enqueue()
    stats = rig.deliver()
    assert stats["auth"] >= 1 and len(rig.apple.requests) <= 2
    sent_before = len(rig.apple.requests)
    rig.clock.advance(AUTH_PAUSE_SECONDS - 1)
    rig.deliver()
    assert len(rig.apple.requests) == sent_before  # still paused
    rig.clock.advance(2)
    assert (
        dict(rig.deliver())["sent"] == 2
    )  # recovered: both go out, nothing was lost or counted against the budget
    assert all(row["attempts"] <= 1 for row in rig.outbox.deliveries_for("e1"))


def test_environment_and_bundle_must_be_enabled_for_this_server(tmp_path, key_path):
    r = Rig(tmp_path, key_path, environment="production")
    try:
        r.device(environment="sandbox")
        r.enqueue()
        assert dict(r.deliver()) == {"failed": 1} and r.apple.requests == []
    finally:
        r.close()


def test_a_crash_resend_carries_the_same_collapse_id_so_devices_replace_not_stack(rig):
    rig.device()
    rig.enqueue()
    rig.deliver()
    # Simulate a crash after Apple accepted but before the outbox recorded it.
    rig.outbox.db.execute("UPDATE deliveries SET state='pending'")
    rig.deliver()
    first, second = (r["headers"] for r in rig.apple.requests)
    assert (
        first["apns-collapse-id"] == second["apns-collapse-id"]
        and first["apns-id"] == second["apns-id"]
    )
