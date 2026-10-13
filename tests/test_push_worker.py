"""The push worker end to end: fake native APIs in, fake Apple out, real SQLite between."""

import asyncio
import json
from datetime import datetime, timezone

import pytest

from condor import fleet_telegram as ft
from condor.fleet_trade_alerts import source_key
from condor.push import apns
from condor.push.config import PushConfigError, parse_push_config
from condor.push.delivery import Deliverer
from condor.push.heartbeat import ExternalPing, evaluate_heartbeat, healthcheck
from condor.push.store import Outbox, Registry
from condor.push.worker import PushWorker, with_limit
from tests.push_support import (
    BUNDLE,
    KEY_ID,
    TEAM,
    TOKEN_A,
    TOKEN_W,
    WATCH_BUNDLE,
    Clock,
    FakeApple,
    executor_row,
    fill_row,
    write_test_key,
)

BOTS = {
    "ok_rsi": ("V1", "db-v1"),
    "rsi_modular_v2": ("V2", "db-v2"),
    "meridian_v3": ("V3", "db-v3"),
}


def run(coro):
    return asyncio.run(coro)


def _source(name):
    return ft.BotSource(
        name,
        name,
        "http://api.invalid",
        "u",
        "p",
        name,
        {
            "status": f"/trading-visuals/runtime-status?bot={name}",
            "orders": f"/trading-visuals/orders?bot={name}",
            "fills": f"/trading-visuals/fills?bot={name}",
            "executors": f"/trading-visuals/executors?bot={name}",
        },
    )


class FakeReader:
    """Plays the native APIs. Edit ``self.data[bot]`` between cycles; set an Exception to fail a read."""

    def __init__(self, clock):
        self.clock = clock
        self.data = {
            name: {
                "fills": [],
                "executors": [],
                "runtime": None,
                "status": {"status": "running"},
                "operations": None,
                "catalogue": None,
            }
            for name in BOTS
        }
        self.calls = []

    def runtime(self, name, **daily):
        return {
            "execution_mode": "live",
            "runtime_status": {
                "updated_at": self.clock(),
                "summary": {
                    "positions_held_count": 2,
                    "active_executor_count": 1,
                    "balance_value_quote": 1000,
                    "balance_value_status": "AVAILABLE",
                    "balance_value_currency": "USDT",
                },
                "daily_entry_risk": {
                    "utc_day": int(self.clock() // 86400),
                    "limit_quote": "50",
                    "baseline_quote": "0",
                    "last_pnl_quote": "5",
                    **daily,
                },
            },
        }

    async def get(self, source, path):
        self.calls.append((source.native_bot_name, path))
        name = source.native_bot_name
        slot = self.data[name]
        if path.startswith("/trading-visuals/runtime-status"):
            kind = "runtime"
        elif path.startswith("/trading-visuals/fills"):
            kind = "fills"
        elif path.startswith("/trading-visuals/executors"):
            kind = "executors"
        elif path.startswith("/bot-orchestration/"):
            kind = "status"
        elif path.startswith("/trading-visuals/operations"):
            kind = "operations"
        else:
            raise AssertionError(f"the push worker must not read {path}")
        value = slot[kind]
        if isinstance(value, Exception):
            raise value
        if kind == "runtime":
            value = value if value is not None else self.runtime(name)
            return {"api_projection": {"bot_name": name}, **value}
        if kind in {"fills", "executors"}:
            return {"api_projection": {"bot_name": name}, "rows": value}
        if value is None:
            raise ft.NativeReadError("HTTP 404")
        return value

    async def catalogue(self):
        value = self.data["rsi_modular_v2"]["catalogue"]
        if value is None:
            raise ft.NativeReadError("HTTP 404")
        if isinstance(value, Exception):
            raise value
        return value


class FakePing:
    def __init__(self):
        self.calls = []

    async def get(self, url, timeout):
        self.calls.append(url)
        return 200


class Rig:
    def __init__(
        self, tmp_path, *, summary=None, discovery=None, extra=None, bots=tuple(BOTS)
    ):
        self.clock = Clock()
        self.tmp = tmp_path
        key_path = tmp_path / "AuthKey_TEST.p8"
        key = write_test_key(key_path)
        self.apple = FakeApple(key.public_key(), self.clock)
        self.apple.add_device(TOKEN_A, BUNDLE)
        self.apple.add_device(TOKEN_W, WATCH_BUNDLE)
        raw = {
            "enabled": True,
            "fleet_config": "/x/worker.json",
            "state_dir": str(tmp_path / "state"),
            "key_path": str(key_path),
            "key_id": KEY_ID,
            "team_id": TEAM,
            "bundle_id": BUNDLE,
            "environment": "both",
            "heartbeat_url": "https://hc.example/ping/00000000-secret-check-id",
            "poll_seconds": 5,
            "thresholds": {
                "confirm_seconds": 60,
                "unreadable_seconds": 120,
                "stale_seconds": 300,
                "recover_seconds": 60,
            },
            **({"summary": summary} if summary else {}),
            **(extra or {}),
        }
        self.config = parse_push_config(raw)
        self.fleet = ft.WorkerConfig(
            frozenset({1}), tuple(_source(n) for n in bots), discovery=discovery
        )
        self.reader = FakeReader(self.clock)
        self.ping_transport = FakePing()
        self.key_path = key_path
        self.start()

    def start(self):
        self.registry = Registry(self.config.registry_path)
        self.outbox = Outbox(self.config.outbox_path)
        client = apns.ApnsClient(
            apns.ProviderTokens(self.key_path, KEY_ID, TEAM, clock=self.clock),
            self.apple,
            clock=self.clock,
        )
        self.deliverer = Deliverer(
            self.outbox, self.registry, client, self.config, clock=self.clock
        )
        self.ping = ExternalPing(
            self.config.heartbeat_url, self.ping_transport, clock=self.clock
        )
        self.worker = PushWorker(
            self.config,
            self.fleet,
            registry=self.registry,
            outbox=self.outbox,
            deliverer=self.deliverer,
            reader=self.reader,
            ping=self.ping,
            clock=self.clock,
        )

    def restart(self):
        self.outbox.close()
        self.start()

    def devices(self):
        self.registry.upsert_device(
            user_id=1,
            token=TOKEN_A,
            platform="iphone",
            bundle_id=BUNDLE,
            environment="sandbox",
            app_version="1",
            now=self.clock(),
        )
        self.registry.upsert_device(
            user_id=1,
            token=TOKEN_W,
            platform="watch",
            bundle_id=WATCH_BUNDLE,
            environment="sandbox",
            app_version="1",
            now=self.clock(),
        )

    def cycle(self, advance=5):
        self.clock.advance(advance)
        run(self.worker.cycle())

    def pushes(self):
        return [
            (p["aps"]["alert"]["title"], p["rsibot"]["class"], p["rsibot"]["id"])
            for p in self.apple.payloads
        ]

    def fill(self, bot, fill_id, order_id=None, **kw):
        row = fill_row(
            fill_id,
            order_id or "o" + fill_id,
            bot=bot,
            source_db=BOTS[bot][1],
            timestamp=self.clock() - 1,
            **kw,
        )
        self.reader.data[bot]["fills"].append(row)
        return row

    def close(self):
        self.outbox.close()


@pytest.fixture
def rig(tmp_path):
    r = Rig(tmp_path)
    r.devices()
    yield r
    r.close()


# ------------------------------------------------------------------ fills


def test_history_before_activation_is_silent_and_a_new_fill_pushes_to_every_device(rig):
    for bot in BOTS:  # old history, from before the worker existed
        rig.reader.data[bot]["fills"].append(
            fill_row(
                "old",
                "o-old",
                bot=bot,
                source_db=BOTS[bot][1],
                timestamp=rig.clock() - 86400,
            )
        )
    rig.cycle()
    assert rig.apple.requests == []
    rig.fill("meridian_v3", "n1", pair="BNB-USDT")
    rig.cycle()
    assert [t for t, *_ in rig.pushes()] == [
        "V3 · BUY BNB-USDT"
    ] * 2  # iPhone and Watch tokens
    assert {r["headers"]["apns-topic"] for r in rig.apple.requests} == {
        BUNDLE,
        WATCH_BUNDLE,
    }
    rig.cycle()
    assert len(rig.apple.requests) == 2  # the same fill is never pushed twice


def test_v1_v2_v3_fills_carry_their_own_labels_and_entries_differ_from_exits(rig):
    rig.cycle()
    rig.fill("ok_rsi", "a", side="buy")
    rig.fill("rsi_modular_v2", "b", side="sell")
    rig.fill("meridian_v3", "c", side="buy")
    rig.cycle()
    titles = sorted({(t, c) for t, c, _ in rig.pushes()})
    assert titles == [
        ("V1 · BUY BNB-USDT", "fill_entry"),
        ("V2 · SELL BNB-USDT", "fill_exit"),
        ("V3 · BUY BNB-USDT", "fill_entry"),
    ]
    links = {p["rsibot"]["link"] for p in rig.apple.payloads}
    assert links == {f"rsibot://bot/{b}/fills" for b in BOTS}
    assert {p["aps"]["thread-id"] for p in rig.apple.payloads} == {
        f"bot:{b}" for b in BOTS
    }


def test_a_fill_without_exact_economics_holds_only_that_source_and_never_announces_numbers_it_cannot_verify(
    rig,
):
    rig.cycle()
    bad = rig.fill("ok_rsi", "bad")
    bad.update(exact_amount=None, exact_price=None)
    rig.fill("rsi_modular_v2", "good")
    rig.cycle()
    assert [t for t, *_ in rig.pushes()] == ["V2 · BUY BNB-USDT"] * 2
    assert rig.worker.source_status["V1"]["fills"].startswith("held:")
    heartbeat = rig.worker.heartbeat_payload(rig.clock())
    assert heartbeat["sources"]["V1"]["fills"].startswith("held:")
    bad.update(
        exact_amount="0.5", exact_price="600"
    )  # fixed at the source: now it flows
    rig.cycle()
    assert [t for t, *_ in rig.pushes()].count("V1 · BUY BNB-USDT") == 2


def test_restart_does_not_repeat_or_flood(rig):
    rig.cycle()
    rig.fill("rsi_modular_v2", "n1")
    rig.cycle()
    sent = len(rig.apple.requests)
    rig.restart()
    rig.cycle(60)
    assert len(rig.apple.requests) == sent
    rig.fill("rsi_modular_v2", "n2")
    rig.cycle()
    assert len(rig.apple.requests) == sent + 2


def test_unreadable_fills_do_not_advance_the_checkpoint_and_catch_up_later(rig):
    rig.cycle()
    rig.reader.data["meridian_v3"]["fills"] = ft.NativeReadError("HTTP 503")
    rig.cycle()
    assert rig.worker.source_status["V3"]["fills"].startswith("unreadable")
    rig.reader.data["meridian_v3"]["fills"] = [
        fill_row(
            "late",
            "o-late",
            bot="meridian_v3",
            source_db="db-v3",
            timestamp=rig.clock() - 2,
        )
    ]
    rig.cycle()
    assert [t for t, *_ in rig.pushes()] == ["V3 · BUY BNB-USDT"] * 2


def test_reads_are_get_only_to_fixed_routes_with_bounded_limits(rig):
    rig.cycle()
    paths = {p for _, p in rig.reader.calls}
    assert any(p.endswith("limit=1000") for p in paths if "fills" in p)
    assert any(p.endswith("limit=500") for p in paths if "executors" in p)
    assert all(
        p.startswith(("/trading-visuals/", "/bot-orchestration/"))
        and "/start" not in p
        and "/stop" not in p
        and "mobile-controls" not in p
        for p in paths
    )
    assert (
        with_limit("/trading-visuals/fills?bot=x&limit=5", 1000)
        == "/trading-visuals/fills?bot=x&limit=1000"
    )


# ------------------------------------------------------------------ bags, risk, health, incidents


def test_new_held_bag_and_trailing_armed_are_pushed_after_the_first_snapshot(rig):
    armed = executor_row("t1", status="active", close_type=None, trailing_state="armed")
    rig.reader.data["rsi_modular_v2"]["executors"] = [armed]
    rig.cycle()  # first snapshot: an already-armed trailing stop is not news
    assert rig.apple.requests == []
    rig.reader.data["rsi_modular_v2"]["executors"] = [
        armed,
        executor_row("h1", close_type="10", closed_at=rig.clock() + 1),
        executor_row("t2", status="active", close_type=None, trailing_state="armed"),
    ]
    rig.cycle()
    titles = sorted(t for t, c, _ in rig.pushes() if c == "bag")
    assert (
        titles == ["V2 · Held bag BNB-USDT"] * 2 + ["V2 · Trailing armed BNB-USDT"] * 2
    )


def test_daily_loss_pause_pushes_a_time_sensitive_alert_once(rig):
    day = int(rig.clock() // 86400)  # the engine's integer UTC day number
    rig.cycle()
    assert rig.apple.requests == []  # a healthy rail is silent

    def paused():
        return rig.reader.runtime(
            "rsi_modular_v2",
            paused=True,
            utc_day=day,
            last_pnl_quote="-60",
            baseline_quote="0",
        )

    for _ in range(2):
        rig.reader.data["rsi_modular_v2"][
            "runtime"
        ] = paused()  # fresh status each cycle
        rig.cycle()
    risk = [p for p in rig.apple.payloads if p["rsibot"]["class"] == "risk"]
    assert len(risk) == 2  # one alert, two devices, not repeated on later cycles
    assert (
        risk[0]["aps"]["interruption-level"] == "time-sensitive"
        and "paused" in risk[0]["aps"]["alert"]["body"]
    )
    assert "Used 60.00 of 50.00 quote" in risk[0]["aps"]["alert"]["body"]


def test_owner_offline_alerts_after_confirmation_and_the_recovery_replaces_it(rig):
    rig.cycle()
    rig.reader.data["meridian_v3"]["status"] = {
        "data": {"status": "disconnected", "bot_name": "meridian_v3"}
    }
    rig.cycle(30)  # first bad reading
    rig.cycle(30)
    assert rig.apple.requests == []  # 30s of a 60s confirmation window
    rig.cycle(40)
    offline = [p for p in rig.apple.payloads if p["rsibot"]["class"] == "health"]
    assert (
        len(offline) == 2
        and offline[0]["aps"]["alert"]["title"] == "V3 · Owner offline"
    )
    assert offline[0]["aps"]["interruption-level"] == "time-sensitive"
    rig.reader.data["meridian_v3"]["status"] = {"status": "running"}
    rig.cycle(30)
    rig.cycle(70)
    last = rig.apple.payloads[-1]
    assert (
        last["aps"]["alert"]["title"] == "V3 · Recovered: Owner offline"
        and last["aps"]["interruption-level"] == "passive"
    )
    collapse = {r["headers"]["apns-collapse-id"] for r in rig.apple.requests}
    assert len(collapse) == 1  # the recovery replaces the offline alert on the device


def test_stack_incident_from_the_operations_read_pushes_once_across_sources_and_restarts(
    rig,
):
    store = {
        "state": "available",
        "incidents": [
            {
                "id": "inc-1",
                "service": "execution-rsi",
                "severity": "critical",
                "state": "open",
                "code": "service_unhealthy",
                "title": "execution-rsi unhealthy",
                "detail": "restarting",
                "first_seen_at": datetime.fromtimestamp(
                    rig.clock() + 1, timezone.utc
                ).isoformat(),
                "last_seen_at": datetime.fromtimestamp(
                    rig.clock() + 1, timezone.utc
                ).isoformat(),
                "resolved_at": None,
                "count": 1,
                "notification_status": "sent",
                "acknowledged": False,
            }
        ],
    }
    for bot in BOTS:  # every source reports the same shared host store
        rig.reader.data[bot]["operations"] = {"incident_store": store}
    rig.cycle()
    incident = [p for p in rig.apple.payloads if p["rsibot"]["class"] == "incident"]
    assert (
        len(incident) == 2
        and incident[0]["aps"]["alert"]["title"]
        == "execution-rsi · execution-rsi unhealthy"
    )
    assert (
        incident[0]["rsibot"]["link"] == "rsibot://operations"
        and incident[0]["aps"]["thread-id"] == "stack"
    )
    rig.restart()
    rig.cycle(30)
    assert (
        len([p for p in rig.apple.payloads if p["rsibot"]["class"] == "incident"]) == 2
    )


# ------------------------------------------------------------------ test alert, summary, market


def test_test_request_is_delivered_to_the_callers_devices_and_reports_results(rig):
    request = rig.registry.add_test_request(1, [], now=rig.clock())
    rig.cycle()
    assert [(t, c) for t, c, _ in rig.pushes()] == [("RSIBOT test alert", "test")] * 2
    result = rig.registry.get_request(1, request)
    assert result["state"] == "done"
    assert sorted(d["state"] for d in result["result"]["deliveries"]) == [
        "sent",
        "sent",
    ]


def test_test_request_with_no_active_device_finishes_with_an_explanation(tmp_path):
    r = Rig(tmp_path)
    try:
        request = r.registry.add_test_request(1, [], now=r.clock())
        r.cycle()
        assert r.registry.get_request(1, request)["result"] == {
            "error": "no active device to send to"
        }
    finally:
        r.close()


def test_daily_summary_is_opt_in_per_device_and_sent_once_per_day(tmp_path):
    r = Rig(tmp_path, summary={"enabled": True, "hour_utc": 20, "minute": 0})
    try:
        r.registry.upsert_device(
            user_id=1,
            token=TOKEN_A,
            platform="iphone",
            bundle_id=BUNDLE,
            environment="sandbox",
            app_version="1",
            classes={"summary": True},
            now=r.clock(),
        )
        r.registry.upsert_device(
            user_id=1,
            token=TOKEN_W,
            platform="watch",
            bundle_id=WATCH_BUNDLE,
            environment="sandbox",
            app_version="1",
            now=r.clock(),
        )
        midnight = (
            datetime.fromtimestamp(r.clock(), timezone.utc)
            .replace(hour=0, minute=0, second=0, microsecond=0)
            .timestamp()
        )
        r.clock.now = midnight + 20 * 3600 - 30
        r.cycle(5)
        assert r.apple.requests == []
        r.cycle(60)
        summaries = [p for p in r.apple.payloads if p["rsibot"]["class"] == "summary"]
        assert len(summaries) == 1  # only the device that opted in
        body = summaries[0]["aps"]["alert"]["body"]
        assert (
            "V1: +5.00 quote today · 2 held · 1 active · wallet 1,000.00 USDT" in body
            and "Fleet today: +15.00 quote" in body
        )
        assert summaries[0]["aps"]["interruption-level"] == "passive"
        r.cycle(600)
        assert (
            len([p for p in r.apple.payloads if p["rsibot"]["class"] == "summary"]) == 1
        )
    finally:
        r.close()


def test_market_verdict_flip_is_an_optional_injected_source(tmp_path):
    r = Rig(tmp_path)
    try:
        r.registry.upsert_device(
            user_id=1,
            token=TOKEN_A,
            platform="iphone",
            bundle_id=BUNDLE,
            environment="sandbox",
            app_version="1",
            classes={"market": True},
            now=r.clock(),
        )
        scores = iter([0.4, 0.4, -0.4, -0.4])

        async def score():
            return next(scores)

        r.worker._market_score = score
        for _ in range(4):
            r.cycle()
        titles = [t for t, *_ in r.pushes()]
        assert titles == ["Market verdict: Risk-off"]
    finally:
        r.close()


# ------------------------------------------------------------------ discovery


def _catalogue(*names):
    return {
        "schema_version": "native-catalogue/1",
        "bots": [
            {
                "id": n,
                "display_name": n.replace("_", " ").title(),
                "capabilities": {"status": True, "reporting": True},
                "endpoints": {
                    "bootstrap": f"/trading-visuals/bootstrap?bot={n}",
                    "status": f"/bot-orchestration/{n}/status",
                    "runtime_status": f"/trading-visuals/runtime-status?bot={n}",
                    "orders": f"/trading-visuals/orders?bot={n}",
                    "fills": f"/trading-visuals/fills?bot={n}",
                    "executors": f"/trading-visuals/executors?bot={n}",
                },
            }
            for n in names
        ],
    }


def test_a_bot_discovered_later_starts_at_discovery_and_its_history_never_floods(
    tmp_path,
):
    discovery = ft.CatalogueConfig(
        "http://api.invalid", "u", "p", "/bot-orchestration/catalogue", {}, 30
    )
    r = Rig(tmp_path, discovery=discovery, bots=("ok_rsi", "rsi_modular_v2"))
    try:
        r.devices()
        r.reader.data["rsi_modular_v2"]["catalogue"] = _catalogue(
            "rsi_modular_v2", "meridian_v3"
        )
        r.reader.data["meridian_v3"]["fills"] = [
            fill_row(
                "hist",
                "o-hist",
                bot="meridian_v3",
                source_db="db-v3",
                timestamp=r.clock() - 3600,
            )
        ]
        r.cycle()
        assert r.apple.requests == []
        assert {s.native_bot_name for s in r.worker.fleet_sources.sources} == {
            "ok_rsi",
            "rsi_modular_v2",
            "meridian_v3",
        }
        r.clock.advance(5)
        r.fill("meridian_v3", "new")
        r.cycle()
        assert [t for t, *_ in r.pushes()] == ["V3 · BUY BNB-USDT"] * 2
        # An outage keeps the last good catalogue instead of dropping the bot.
        r.reader.data["rsi_modular_v2"]["catalogue"] = ft.NativeReadError("HTTP 503")
        r.cycle(60)
        assert "meridian_v3" in {
            s.native_bot_name for s in r.worker.fleet_sources.sources
        }
        assert r.worker.fleet_sources.error == "http_status HTTP 503"
    finally:
        r.close()


# ------------------------------------------------------------------ heartbeat and dead-man's switch


def test_heartbeat_is_written_for_the_app_the_container_and_the_external_service(rig):
    rig.cycle()
    run(rig.worker.beat())
    meta = rig.registry.get_meta("worker_heartbeat")
    assert meta["status"] == "running" and meta["degraded_reasons"] == []
    assert evaluate_heartbeat(meta, rig.clock() + 30)["state"] == "fresh"
    assert evaluate_heartbeat(meta, rig.clock() + 3600)["state"] == "stale"
    assert healthcheck(rig.config.heartbeat_path, now=rig.clock() + 10)
    assert not healthcheck(rig.config.heartbeat_path, now=rig.clock() + 600)
    assert rig.ping_transport.calls == [
        "https://hc.example/ping/00000000-secret-check-id"
    ]


def test_unreadable_sources_degrade_the_heartbeat_and_the_external_ping_signals_failure(
    rig,
):
    for bot in BOTS:
        rig.reader.data[bot]["runtime"] = ft.NativeReadError("HTTP 500")
    rig.cycle()
    run(rig.worker.beat())
    meta = rig.registry.get_meta("worker_heartbeat")
    assert (
        meta["status"] == "degraded"
        and "sources_unreadable" in meta["degraded_reasons"]
    )
    assert rig.ping_transport.calls[-1].endswith("/fail")
    assert (
        evaluate_heartbeat(meta, rig.clock())["state"] == "fresh"
    )  # alive, but the app can show why it is degraded


def test_apns_credential_failure_degrades_the_heartbeat(rig):
    rig.key_path.unlink()
    rig.cycle()
    rig.fill("rsi_modular_v2", "n1")
    rig.cycle()
    assert "apns" in rig.worker.degraded_reasons(rig.clock())
    assert rig.worker.heartbeat_payload(rig.clock())["apns"]["auth_ok"] is False
    assert rig.outbox.counts()["pending"] == 2  # held for retry, not dropped


def test_a_stuck_delivery_backlog_degrades_the_heartbeat(rig):
    rig.cycle()
    rig.fill("rsi_modular_v2", "n1")
    rig.apple.script = [(503, {"reason": "ServiceUnavailable"}, {})] * 40
    rig.cycle()
    assert "delivery_backlog" not in rig.worker.degraded_reasons(rig.clock())
    rig.clock.advance(901)
    assert "delivery_backlog" in rig.worker.degraded_reasons(rig.clock())


def test_no_ping_is_attempted_without_a_configured_url(tmp_path):
    r = Rig(tmp_path, extra={"heartbeat_url": None})
    try:
        r.cycle()
        run(r.worker.beat())
        assert r.ping_transport.calls == [] and not r.ping.configured
    finally:
        r.close()


def test_a_failing_ping_never_raises_and_never_logs_the_url(tmp_path, caplog):
    class Down:
        async def get(self, url, timeout):
            raise OSError(f"cannot reach {url}")

    ping = ExternalPing("https://hc.example/ping/very-secret-check", Down())
    assert run(ping.ping(True)) is False
    assert ping.last_error == "ping failed: OSError" and "secret" not in ping.last_error
    assert ping.host == "hc.example"


def test_ping_requires_https_without_credentials():
    base = {
        "enabled": True,
        "fleet_config": "/x",
        "key_path": "/k",
        "key_id": KEY_ID,
        "team_id": TEAM,
        "bundle_id": BUNDLE,
        "environment": "sandbox",
    }
    for bad in (
        "http://hc.example/x",
        "https://user:pw@hc.example/x",
        "ftp://x",
        "",
        "https:///x",
    ):
        with pytest.raises(PushConfigError):
            parse_push_config({**base, "heartbeat_url": bad})
    assert (
        parse_push_config(
            {**base, "heartbeat_url": "https://hc-ping.com/abc"}
        ).heartbeat_url
        == "https://hc-ping.com/abc"
    )


def test_loop_survives_a_failed_cycle_and_reports_it(rig):
    async def boom():
        raise RuntimeError("database exploded")

    async def go():
        rig.worker.cycle = boom
        task = asyncio.create_task(rig.worker._cycle_loop())
        await asyncio.sleep(0.05)
        rig.worker.stop()
        await asyncio.wait_for(task, 2)

    run(go())
    assert (
        rig.worker.last_cycle_error == "RuntimeError"
        and "cycle_error" in rig.worker.degraded_reasons(rig.clock())
    )


def test_logs_never_contain_device_tokens_key_material_or_the_ping_url(rig, caplog):
    import logging

    from condor.push.worker import configure_logging

    caplog.set_level(logging.DEBUG)
    rig.cycle()
    bad = rig.fill("ok_rsi", "bad")
    bad.update(exact_amount=None)
    rig.fill("rsi_modular_v2", "ok")
    rig.reader.data["meridian_v3"]["fills"] = ft.NativeReadError("HTTP 503")
    rig.cycle()
    rig.key_path.unlink()
    rig.fill("rsi_modular_v2", "ok2")
    rig.cycle()
    run(rig.worker.beat())
    text = caplog.text + json.dumps(rig.worker.heartbeat_payload(rig.clock()))
    for secret in (TOKEN_A, TOKEN_W, "secret-check-id", "BEGIN", "AuthKey"):
        assert secret not in text, secret
    configure_logging()
    for noisy in ("httpx", "httpcore", "h2", "hpack"):
        assert (
            logging.getLogger(noisy).level == logging.WARNING
        )  # httpx would log the token-bearing APNs URL


def test_worker_sources_are_the_telegram_fleet_sources_without_a_second_registry(rig):
    assert [s.native_bot_name for s in rig.worker.fleet_sources.sources] == sorted(BOTS)
    infos = {rig.worker._info(s).tag for s in rig.worker.fleet_sources.sources}
    assert infos == {"V1", "V2", "V3"} and all(
        rig.outbox.started(source_key(s)) is not None
        for s in rig.worker.fleet_sources.sources
    )


def test_delivery_report_counts_per_day_and_state_without_taking_the_workers_lock(rig):
    import subprocess
    import sys

    from condor.push.store import delivery_report

    rig.cycle()
    rig.fill("rsi_modular_v2", "n1")
    rig.apple.script = [(503, {"reason": "ServiceUnavailable"}, {})]
    rig.cycle()
    report = delivery_report(rig.config.outbox_path, now=rig.clock())
    assert report["states"] == {"pending": 1, "sent": 1}
    (day,) = report["by_utc_day"]
    assert (
        report["by_utc_day"][day]["fill_entry"] == {"pending": 1, "sent": 1}
        and report["last_sent_at"] == rig.clock()
    )
    out = subprocess.run(
        [sys.executable, "-m", "condor.push", "--report"],
        capture_output=True,
        text=True,
        env={
            **__import__("os").environ,
            "CONDOR_PUSH_STATE_DIR": str(rig.config.state_dir),
        },
    )
    assert out.returncode == 0 and json.loads(out.stdout)["states"] == {
        "pending": 1,
        "sent": 1,
    }
    health = subprocess.run(
        [sys.executable, "-m", "condor.push", "--healthcheck"],
        capture_output=True,
        env={
            **__import__("os").environ,
            "CONDOR_PUSH_STATE_DIR": str(rig.config.state_dir),
        },
    )
    assert health.returncode == 1  # no heartbeat has been written yet
    run(rig.worker.beat())
    health = subprocess.run(
        [sys.executable, "-m", "condor.push", "--healthcheck"],
        capture_output=True,
        env={
            **__import__("os").environ,
            "CONDOR_PUSH_STATE_DIR": str(rig.config.state_dir),
        },
    )
    assert (
        health.returncode == 1
    )  # the fake clock is far from wall time, so the file reads as stale
