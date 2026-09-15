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
    rows = PerformanceHistory(store.path).read("server", "main", "ALL", 1060)["points"]
    assert len(rows) == 2
    assert rows[0]["segment"] == rows[1]["segment"]
    store.record("server", [packet(1065, "new")], 1065)
    store.record("server", [], 1070)
    store.record("server", [packet(1075, "new")], 1075)
    store.record("server", [packet(1300, "new")], 1300)
    rows = store.read("server", "main", "ALL", 1300)["points"]
    assert len({p["segment"] for p in rows}) == 4
    assert store.read("other", "main", "ALL", 1300)["points"] == []


def test_read_does_not_create_storage(tmp_path):
    store = PerformanceHistory(tmp_path / "missing.db")
    assert store.read("server", "main", "ALL")["coverage_start"] is None
    assert not store.path.exists()


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
