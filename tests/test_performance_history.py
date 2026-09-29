import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from condor.performance_history import PerformanceHistory, project


def packet(t=1000, boot="a"):
    return {
        "bot_name": "main",
        "source": "native_mqtt",
        "performance_current": True,
        "identity_verified": True,
        "status": "running",
        "received_at": t,
        "stale_after_seconds": 30,
        "expected_controller_ids": ["eth"],
        "heartbeat": {"received_at": t, "source_timestamp": t * 1000000},
        "lifecycle": {
            "valid": True,
            "observation": {
                "received_at": t,
                "payload": {"generated_at": t, "boot_id": boot, "instance_id": "main"},
            },
        },
        "performance": {
            "eth": {
                "custom_info": {"pair": "ETH-USDC"},
                "performance": {
                    "realized_pnl_quote": "0.1",
                    "unrealized_pnl_quote": "0.2",
                    "global_pnl_quote": "0.3",
                },
            }
        },
    }


def test_decimal_totals_and_stale():
    assert project(packet(), 1001)["total_pnl_quote"] == "0.3"
    with pytest.raises(ValueError):
        project(packet(), 1030)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda p: p.update(performance_current=False),
        lambda p: p.update(expected_controller_ids=["missing"]),
        lambda p: p["performance"]["eth"]["performance"].update(pnl_available=False),
        lambda p: p["performance"]["eth"]["performance"].update(global_pnl_quote="NaN"),
        lambda p: p["performance"]["eth"]["performance"].update(global_pnl_quote="7"),
        lambda p: p["lifecycle"]["observation"]["payload"].pop("boot_id"),
    ],
)
def test_invalid_sources_rejected(mutation):
    p = packet()
    mutation(p)
    with pytest.raises(ValueError):
        project(p, 1001)


def test_durable_sampling_dedup_and_segments(tmp_path):
    store = PerformanceHistory(tmp_path / "history.db")
    for t in [1000, 1000, 1005, 1060]:
        store.record("server", [packet(t)], t)
    # 1D returns every stored sample; longer ranges are bucketed.
    rows = PerformanceHistory(store.path).read("server", "main", "1D", 1060)["points"]
    assert len(rows) == 2
    assert rows[0]["segment"] == rows[1]["segment"]
    store.record("server", [packet(1065, "new")], 1065)
    store.record("server", [], 1070)
    store.record("server", [packet(1075, "new")], 1075)
    store.record("server", [packet(1300, "new")], 1300)
    rows = store.read("server", "main", "ALL", 1300)["points"]
    assert len({p["segment"] for p in rows}) == 4
    assert store.read("other", "main", "ALL", 1300)["points"] == []


NOW = 1_800_000_000.0


def seed(store, rows):
    """Stored native samples as (timestamp, identity, segment, total)."""
    with store._connect() as conn:
        conn.executemany(
            "INSERT INTO points VALUES ('server','main',?,?,?,'USDC',?,'0',?)",
            [(t, identity, segment, str(total), str(total)) for t, identity, segment, total in rows],
        )


def minute_rows(start, end, identity="boot-a", segment="a"):
    return [(float(t), identity, segment, index) for index, t in enumerate(range(int(start), int(end), 60))]


@pytest.mark.parametrize("period,bucket", [("1W", 300), ("1M", 1800), ("ALL", 3600)])
def test_long_ranges_cover_the_whole_window_with_the_last_sample_per_bucket(tmp_path, period, bucket):
    from condor.performance_history import RANGES

    store = PerformanceHistory(tmp_path / "history.db")
    start = NOW - min(RANGES[period], 40 * 86400) - 600
    raw = minute_rows(start, NOW + 1)
    seed(store, raw)
    result = store.read("server", "main", period, NOW)
    points = result["points"]
    assert result["truncated"] is False
    assert result["bucket_seconds"] == bucket
    assert result["coverage_start"] == raw[0][0]
    # The window edges are real observations: the newest sample and one inside the first bucket.
    assert points[-1]["timestamp"] == raw[-1][0]
    window_start = NOW - RANGES[period]
    assert window_start <= points[0]["timestamp"] <= max(window_start, raw[0][0]) + bucket
    # Each returned point is a stored sample: the segment's first one in the window or the last one of
    # its bucket. Nothing is invented.
    stored = {t: total for t, _, _, total in raw}
    in_window = [t for t, *_ in raw if t >= window_start]
    last_in_bucket = {int(t // bucket): t for t in in_window}
    assert [p["timestamp"] for p in points] == sorted({in_window[0], *last_in_bucket.values()})
    assert all(p["total_pnl_quote"] == str(stored[p["timestamp"]]) for p in points)
    assert all(b["timestamp"] - a["timestamp"] <= bucket + 90 for a, b in zip(points, points[1:]))


def test_one_day_reads_stay_unbucketed(tmp_path):
    store = PerformanceHistory(tmp_path / "history.db")
    raw = minute_rows(NOW - 86400 - 600, NOW + 1)
    seed(store, raw)
    result = store.read("server", "main", "1D", NOW)
    assert result["bucket_seconds"] is None
    assert [p["timestamp"] for p in result["points"]] == [t for t, *_ in raw if t >= NOW - 86400]


def test_buckets_never_join_across_segments_owners_or_gaps(tmp_path):
    store = PerformanceHistory(tmp_path / "history.db")
    # Owner a ends inside a bucket, owner b starts in the same bucket; b then stops and
    # a later segment of b resumes after a 20 minute gap.
    first = minute_rows(NOW - 86400, NOW - 7320, "boot-a", "a")
    second = minute_rows(NOW - 7340, NOW - 3600, "boot-b", "b")
    third = minute_rows(NOW - 2400, NOW + 1, "boot-b", "c")
    seed(store, first + second + third)
    points = store.read("server", "main", "1W", NOW)["points"]
    segments = [p["segment"] for p in points]
    assert segments == sorted(segments), "segments stay contiguous and ordered"
    for segment, rows in (("a", first), ("b", second), ("c", third)):
        kept = [p for p in points if p["segment"] == segment]
        assert kept[-1]["timestamp"] == rows[-1][0], f"segment {segment} keeps its last observation"
        assert kept[0]["timestamp"] == rows[0][0], f"segment {segment} keeps its first observation"
        assert {p["identity"] for p in kept} == {rows[0][1]}
    shared = int(first[-1][0] // 300)
    assert int(second[0][0] // 300) == shared
    assert {p["segment"] for p in points if int(p["timestamp"] // 300) == shared} == {"a", "b"}
    boundary = segments.index("b")
    assert points[boundary - 1]["segment"] == "a" and points[boundary - 1]["timestamp"] == first[-1][0]
    resumed = segments.index("c")
    assert points[resumed]["timestamp"] - points[resumed - 1]["timestamp"] > 1200


@pytest.mark.parametrize("period", ["1W", "1M"])
def test_an_owner_starting_just_inside_the_window_shows_its_real_start(tmp_path, period):
    from condor.performance_history import RANGES

    store = PerformanceHistory(tmp_path / "history.db")
    since = NOW - RANGES[period]
    # Owner a stops before the window; owner b starts 250s into it. Without b's first sample the
    # window would begin at the end of b's first bucket and hide the restart.
    seed(store, minute_rows(since - 3600, since - 100, "boot-a", "a") + minute_rows(since + 250, NOW + 1, "boot-b", "b"))
    points = store.read("server", "main", period, NOW)["points"]
    assert points[0]["timestamp"] == since + 250
    assert {p["segment"] for p in points} == {"b"}


def test_bucketed_reads_still_report_truncation(tmp_path):
    store = PerformanceHistory(tmp_path / "history.db")
    # Every sample in its own segment: a restart per minute cannot be compressed.
    seed(store, [(t, "boot", f"s{index}", index) for t, _, _, index in minute_rows(NOW - 12000 * 60, NOW + 1)])
    result = store.read("server", "main", "1M", NOW)
    assert result["truncated"] is True
    assert len(result["points"]) == 10000
    assert result["points"][-1]["timestamp"] <= NOW


def test_read_does_not_create_storage(tmp_path):
    store = PerformanceHistory(tmp_path / "missing.db")
    assert store.read("server", "main", "ALL")["coverage_start"] is None
    assert store.read("server", "main", "1M")["bucket_seconds"] == 1800
    assert not store.path.exists()


def test_concurrent_first_use_and_wallet_reads_do_not_lose_samples(tmp_path):
    store = PerformanceHistory(tmp_path / "concurrent-history.db")
    workers = 24
    samples_per_worker = 4
    start = Barrier(workers)
    base = int(time.time())

    def record(worker):
        name = f"bot-{worker}"
        start.wait()
        for index in range(samples_per_worker):
            stamp = base + worker * 40000 + index * 3600
            bot = packet(stamp)
            bot["bot_name"] = name
            store.record("server", [bot], now=stamp)
            store.record_wallet(
                "server",
                {name: {"timestamp": stamp, "currency": "USDC", "value_quote": str(index + 1),
                        "source_id": name, "balances": [{"asset": "USDC", "total": str(index + 1), "value": str(index + 1)}]}},
                now=stamp,
            )
            assert store.read_wallet("server", name, "ALL", now=stamp + 1)["latest"] is not None
        return name

    with ThreadPoolExecutor(max_workers=workers) as pool:
        names = list(pool.map(record, range(workers)))

    assert len(names) == workers
    for name in names:
        history = store.read_wallet("server", name, "ALL", now=base + workers * 40000 + 1)
        assert len(history["points"]) == samples_per_worker
        assert history["latest"]["value_quote"] == str(samples_per_worker)


@pytest.mark.asyncio
async def test_background_fetch_records_and_failure_marks_gap(monkeypatch):
    from unittest.mock import AsyncMock, Mock
    from condor import performance_history
    from condor.server_data_service import ServerDataService, ServerDataType, CacheKey

    observer = Mock()
    monkeypatch.setattr(performance_history, "history", observer)
    sds = ServerDataService()
    monkeypatch.setattr(sds, "_get_client", AsyncMock(return_value=object()))
    fetch = AsyncMock(return_value=[packet()])
    sds.register_fetch(ServerDataType.BOTS_STATUS, fetch)
    key = CacheKey.make("server", ServerDataType.BOTS_STATUS)
    await sds._do_fetch_and_cache(key)
    observer.record.assert_called_with("server", [packet()])
    fetch.side_effect = RuntimeError("offline")
    await sds._do_fetch_and_cache(key)
    observer.record.assert_called_with("server", [])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "shared,added_consumer", [(False, False), (True, False), (False, True)]
)
async def test_headless_lifespan_observes_only_bots_and_preserves_shared_owner(
    monkeypatch, shared, added_consumer
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock
    from condor import server_data_service as module
    from condor import performance_history
    from condor.web.app import create_app
    import config_manager

    sds = module.ServerDataService()
    monkeypatch.setattr(module, "get_server_data_service", lambda: sds)
    monkeypatch.setattr(
        config_manager,
        "get_config_manager",
        lambda: SimpleNamespace(list_servers=lambda: {"native": {}}),
    )
    monkeypatch.setattr(sds, "_get_client", AsyncMock(return_value=object()))
    observer = Mock()
    monkeypatch.setattr(performance_history, "history", observer)
    fetch = AsyncMock(return_value=[packet()])
    sds.register_fetch(module.ServerDataType.BOTS_STATUS, fetch)
    if shared:
        sds.start()
    app = create_app()
    try:
        async with app.router.lifespan_context(app):
            assert sds._running
            assert {key.data_type for key in sds._subscriptions} == {
                module.ServerDataType.BOTS_STATUS
            }
            observer.record.assert_called_with("native", [packet()])
            # No browser request: another background tick still fetches.
            next(iter(sds._cache.values())).fetched_at = 0
            await sds._poll_tick()
            assert fetch.await_count >= 2
            if added_consumer:
                await sds.subscribe(
                    "native", module.ServerDataType.BOTS_STATUS, "other"
                )
        assert sds._running is (shared or added_consumer)
        assert bool(sds._subscriptions) is added_consumer
    finally:
        sds.stop()


def test_route_authorization_and_range(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from condor.web.auth import get_current_user
    from condor.web.models import WebUser
    from condor.web.routes import performance_history as route

    cm = SimpleNamespace(has_server_access=lambda *_: True)
    monkeypatch.setattr(route, "get_config_manager", lambda: cm)
    monkeypatch.setattr(route, "history", PerformanceHistory(tmp_path / "read.db"))
    app = FastAPI()
    app.include_router(route.router)
    app.dependency_overrides[get_current_user] = lambda: WebUser(
        id=1, username="owner", role="admin"
    )
    client = TestClient(app)
    url = "/servers/local/bots/main/performance-history"
    assert client.get(url).status_code == 200
    assert client.get(url).headers["cache-control"] == "no-store"
    assert client.get(url + "?range=BAD").status_code == 422
    cm.has_server_access = lambda *_: False
    assert client.get(url).status_code == 403
    assert not route.history.path.exists()
