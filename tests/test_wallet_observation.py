import pytest

from condor.performance_history import PerformanceHistory
from condor.wallet_observation import configured_sources, observe, project_wallet


def runtime(bot="rsi_modular_v2", *, value="20691.94", currency="USDT", scope="account_wallet", observed="2026-09-24T11:55:51+00:00"):
    return {
        "runtime_status": {
            "bot_name": bot,
            "updated_at": observed,
            "source_runtime_status_id": "4314413ab84fc58a",
            "balances": [{"asset": "USDC", "total_balance": 1997.82, "value_quote": value}],
            "summary": {"balance_value_quote": value, "balance_value_scope": scope, "balance_value_currency": currency},
        }
    }


def test_project_wallet_requires_declared_scope_and_currency():
    sample = project_wallet(runtime(), "rsi_modular_v2")
    assert sample["currency"] == "USDT" and sample["value_quote"] == "20691.94"
    assert sample["timestamp"] == 1790250951.0
    assert sample["balances"][0]["asset"] == "USDC"
    assert sample["balances"][0]["available"] is None
    for bad in [
        runtime(bot="other"),
        runtime(currency=None),
        runtime(currency="usdt"),
        runtime(scope="strategy"),
        runtime(value="NaN"),
        runtime(value="-1"),
        runtime(value="0"),
        runtime(value="0.0"),
        runtime(observed="2026-09-24T11:55:51"),
        {"runtime_status": []},
        None,
    ]:
        with pytest.raises(ValueError):
            project_wallet(bad, "rsi_modular_v2")


def test_configured_sources_accepts_only_loopback_http(monkeypatch):
    monkeypatch.setenv("CONDOR_TRADING_VISUALS_SOURCES", '{"rsi_modular_v2": {"server": "v2", "url": "http://127.0.0.1:5111/api/v1"}, "evil": {"server": "v2", "url": "https://example.com/api/v1"}, "bad": 3}')
    assert list(configured_sources()) == ["rsi_modular_v2"]
    monkeypatch.setenv("CONDOR_TRADING_VISUALS_SOURCES", "not json")
    assert configured_sources() == {}


def test_record_wallet_samples_per_minute_and_gaps(tmp_path):
    store = PerformanceHistory(tmp_path / "history.db")
    sample = lambda t, value="1": {"timestamp": t, "currency": "USDT", "value_quote": value, "source_id": "s", "balances": [{"asset": "USDC", "total": value, "available": value, "value": value}]}
    store.record_wallet("v2", {"bot": sample(1000)}, 1000)
    store.record_wallet("v2", {"bot": sample(1030)}, 1030)
    store.record_wallet("v2", {"bot": sample(1060, "2")}, 1060)
    rows = store.read_wallet("v2", "bot", "1D", 1060)["points"]
    assert [row["timestamp"] for row in rows] == [1000, 1060]
    assert rows[1]["value_quote"] == "2" and rows[1]["currency"] == "USDT"
    store.record_wallet("v2", {"bot": None}, 1070)
    store.record_wallet("v2", {"bot": sample(1130, "3")}, 1130)
    rows = store.read_wallet("v2", "bot", "1D", 1130)["points"]
    assert [row["timestamp"] for row in rows] == [1000, 1060, 1130], "a failed read restarts sampling at the next valid sample"
    store.record_wallet("v2", {"bot": sample(9999)}, 1140)
    assert len(store.read_wallet("v2", "bot", "1D", 1140)["points"]) == 3, "future-dated samples are rejected"
    assert store.read_wallet("other", "bot", "1D", 1140)["points"] == []
    assert store.read_wallet("v2", "bot", "1D", 1140)["coverage_start"] == 1000
    hourly = store.read_wallet("v2", "bot", "ALL", 1140)
    assert [row["timestamp"] for row in hourly["points"]] == [1130], "ALL keeps the last sample of each hour bucket"
    assert hourly["bucket_seconds"] == 3600
    assert hourly["latest"]["value_quote"] == "3" and hourly["latest"]["balances"][0]["asset"] == "USDC", "the newest sample carries its balances"
    assert store.read_wallet("v2", "bot", "1D", 1140)["latest"]["timestamp"] == 1130
    assert PerformanceHistory(tmp_path / "missing.db").read_wallet("v2", "bot", "1D")["points"] == []
    assert PerformanceHistory(tmp_path / "missing.db").read_wallet("v2", "bot", "1D")["latest"] is None
    assert store.read("v2", "bot", "ALL", 1140)["points"] == [], "PnL points stay separate from wallet samples"


@pytest.mark.asyncio
async def test_observe_reads_only_sources_on_the_server(monkeypatch):
    import condor.wallet_observation as module

    calls = []

    async def fake_read(client, source, bot):
        calls.append((source["url"], bot))
        if bot == "broken":
            raise ValueError("boom")
        return runtime(bot)

    monkeypatch.setattr(module, "_read", fake_read)
    sources = {
        "rsi_modular_v2": {"server": "v2", "url": "http://127.0.0.1:5111/api/v1"},
        "broken": {"server": "v2", "url": "http://127.0.0.1:5112/api/v1"},
        "elsewhere": {"server": "v1", "url": "http://127.0.0.1:5011/api/v1"},
    }
    samples = await observe("v2", sources)
    assert set(samples) == {"rsi_modular_v2", "broken"}
    assert samples["rsi_modular_v2"]["currency"] == "USDT"
    assert samples["broken"] is None
    assert ("http://127.0.0.1:5011/api/v1", "elsewhere") not in calls
    assert await observe("none", sources) == {}


def test_wallet_route_is_server_scoped(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from condor.web.auth import get_current_user
    from condor.web.models import WebUser
    from condor.web.routes import performance_history as route

    cm = SimpleNamespace(has_server_access=lambda *_: True)
    monkeypatch.setattr(route, "get_config_manager", lambda: cm)
    import time

    store = PerformanceHistory(tmp_path / "read.db")
    recent = time.time() - 100
    store.record_wallet("local", {"main": {"timestamp": recent, "currency": "USDT", "value_quote": "5", "source_id": "s"}}, recent)
    monkeypatch.setattr(route, "history", store)
    app = FastAPI()
    app.include_router(route.router)
    app.dependency_overrides[get_current_user] = lambda: WebUser(id=1, username="owner", role="admin")
    client = TestClient(app)
    url = "/servers/local/bots/main/wallet-history?range=ALL"
    body = client.get(url)
    assert body.status_code == 200 and body.headers["cache-control"] == "no-store"
    assert body.json()["source"] == "reporting_wallet_observer"
    assert body.json()["points"][0]["value_quote"] == "5"
    assert client.get(url.replace("ALL", "BAD")).status_code == 422
    cm.has_server_access = lambda *_: False
    assert client.get(url).status_code == 403


def test_read_wallet_skips_stored_zero_valuations(tmp_path):
    """An engine that restarts before its connector loads balances publishes 0.0 for every asset.
    Older rows recorded before the admission guard stay in the store but never plot as equity."""
    store = PerformanceHistory(tmp_path / "history.db")
    sample = lambda t, value: {"timestamp": t, "currency": "USDT", "value_quote": value, "source_id": "s", "balances": [{"asset": "USDC", "total": value, "available": value, "value": value}]}
    store.record_wallet("v2", {"bot": sample(1000, "21000.5")}, 1000)
    store.record_wallet("v2", {"bot": sample(1060, "0.0")}, 1060)
    store.record_wallet("v2", {"bot": sample(1120, "21001.5")}, 1120)
    result = store.read_wallet("v2", "bot", "1D", 1120)
    assert [row["value_quote"] for row in result["points"]] == ["21000.5", "21001.5"]
    assert result["latest"]["value_quote"] == "21001.5"
    store.record_wallet("v2", {"bot": sample(1180, "0.0")}, 1180)
    assert store.read_wallet("v2", "bot", "1D", 1180)["latest"]["value_quote"] == "21001.5", "a zero row never becomes the last-known wallet"


def test_wallet_observer_rejects_incomplete_balances_and_marks_legacy_history(tmp_path):
    payload = runtime(value='100')
    payload['runtime_status']['balances'] = [
        {'asset': 'USDT', 'total_balance': '100', 'value_quote': '100'},
        {'asset': 'BTC', 'total_balance': '1', 'value_quote': None},
    ]
    with pytest.raises(ValueError, match='complete'):
        project_wallet(payload, 'rsi_modular_v2')
    store = PerformanceHistory(tmp_path / 'legacy.db')
    store.record_wallet('v2', {'bot': {
        'timestamp': 1000, 'currency': 'USDT', 'value_quote': '100',
        'balances': [{'asset': 'BTC', 'total': '1', 'available': '1', 'value': 'None'}],
    }}, 1000)
    assert store.read_wallet('v2', 'bot', '1D', 1000)['points'][0]['valuation_complete'] is False


@pytest.mark.parametrize('mark', ['0', '99'])
def test_wallet_observer_rejects_zero_marks_and_inconsistent_summary(mark):
    payload = runtime(value='100')
    payload['runtime_status']['balances'] = [{'asset': 'BTC', 'total_balance': '1', 'value_quote': mark}]
    with pytest.raises(ValueError, match='complete'):
        project_wallet(payload, 'rsi_modular_v2')
