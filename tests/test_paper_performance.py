"""Paper bots: simulated PnL recorded from reporting, kept apart from every live number."""

from datetime import datetime, timezone

import pytest

from condor.fetchers.bots import build_bots_page
from condor.paper_performance import paper_samples, project_paper
from condor.performance_history import PerformanceHistory
from condor.web import fleet_pnl

NOW = 1_800_000_000.0
BOT = "meridian_v4_paper"


def iso(seconds):
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()


def runtime(
    bot=BOT,
    *,
    at=NOW - 5,
    realized="12.5",
    unrealized="-2.5",
    fees="1",
    net=None,
    **extra,
):
    summary = {
        "pnl_available": True,
        "realized_pnl_quote": realized,
        "unrealized_pnl_quote": unrealized,
        "fees_quote": fees,
        "net_pnl_quote": net,
        "balance_value_quote": 10000.0,
    }
    return {
        "runtime_status": {
            "bot_name": bot,
            "updated_at": iso(at),
            "source_runtime_status_id": "paper-src",
            "simulated": True,
            "controllers": [
                {
                    "controller_id": "modular_spot_meridian_v4_paper_btc",
                    "pair": "BTC-USDT",
                },
                {
                    "controller_id": "modular_spot_meridian_v4_paper_eth",
                    "pair": "ETH-USDT",
                },
            ],
            "summary": summary,
            **extra,
        }
    }


def test_a_paper_runtime_status_projects_to_a_simulated_point():
    point = project_paper(runtime(), BOT, NOW)
    assert point["quote"] == "USDT"
    assert (
        point["realized_pnl_quote"],
        point["unrealized_pnl_quote"],
        point["total_pnl_quote"],
    ) == ("12.5", "-2.5", "10.0")
    assert point["timestamp"] == NOW - 5


@pytest.mark.parametrize(
    "body,bot",
    [
        (runtime(), "rsi_modular_v2"),  # a live bot never records through this path
        (runtime(bot="other_paper"), BOT),
        (runtime(at=NOW - 600), BOT),  # expired
        (runtime(at=NOW + 60), BOT),  # from the future
        (runtime(realized=None), BOT),
        (runtime(realized="NaN"), BOT),
        (runtime(net="99"), BOT),  # inconsistent net
        (runtime(simulated=False), BOT),
        (runtime(controllers=[]), BOT),
        (runtime(controllers=[{"pair": "BTC-USDT"}, {"pair": "ETH-USDC"}]), BOT),
        ({"runtime_status": []}, BOT),
        (None, BOT),
    ],
)
def test_unusable_paper_reports_are_rejected(body, bot):
    with pytest.raises(ValueError):
        project_paper(body, bot, NOW)


def test_unavailable_pnl_is_rejected():
    body = runtime()
    body["runtime_status"]["summary"]["pnl_available"] = False
    with pytest.raises(ValueError):
        project_paper(body, BOT, NOW)


def test_paper_samples_skip_live_bots_and_mark_failures():
    samples = paper_samples(
        {
            BOT: runtime(),
            "rsi_modular_v2": runtime("rsi_modular_v2"),
            "meridian_v4_d2h_paper": None,
        },
        NOW,
    )
    assert set(samples) == {BOT, "meridian_v4_d2h_paper"}
    assert (
        samples[BOT]["total_pnl_quote"] == "10.0"
        and samples["meridian_v4_d2h_paper"] is None
    )


def test_paper_points_are_stored_apart_and_read_back_as_simulated(tmp_path):
    store = PerformanceHistory(tmp_path / "native-performance.sqlite3")
    for offset, realized in ((600, "1"), (300, "2"), (5, "4")):
        store.record_paper(
            "v2",
            {
                BOT: project_paper(
                    runtime(
                        at=NOW - offset, realized=realized, unrealized="0", fees="0"
                    ),
                    BOT,
                    NOW - offset + 5,
                )
            },
            NOW,
        )
    store.record_paper(
        "v2",
        {
            "rsi_modular_v2": {
                "timestamp": NOW,
                "identity": "x",
                "quote": "USDT",
                "realized_pnl_quote": "1",
                "unrealized_pnl_quote": "0",
                "total_pnl_quote": "1",
            }
        },
        NOW,
    )
    read = store.read("v2", BOT, "1D", NOW)
    assert read["source"] == "reporting_paper_runtime" and read["simulated"] is True
    assert [p["total_pnl_quote"] for p in read["points"]] == ["1", "2", "4"]
    live = store.read("v2", "rsi_modular_v2", "1D", NOW)
    assert (
        live["source"] == "native_mqtt_observer"
        and "simulated" not in live
        and live["points"] == []
    )
    # The fleet parser accepts the simulated source for a paper id only.
    history = fleet_pnl.parse_bot_history(read, BOT, "1D", NOW * 1000 + 5000)
    assert [s.total for s in history.samples] == [1, 2, 4]
    assert (
        fleet_pnl.parse_bot_history(
            {**read, "bot_name": "rsi_modular_v2"}, "rsi_modular_v2", "1D", NOW * 1000
        ).reason
        == fleet_pnl.HISTORY_INVALID
    )
    assert (
        fleet_pnl.parse_bot_history(
            {**read, "simulated": False}, BOT, "1D", NOW * 1000 + 5000
        ).reason
        == fleet_pnl.HISTORY_INVALID
    )


def test_a_failed_paper_read_starts_a_new_segment(tmp_path):
    store = PerformanceHistory(tmp_path / "native-performance.sqlite3")
    point = lambda at: project_paper(runtime(at=at), BOT, at + 5)  # noqa: E731
    store.record_paper("v2", {BOT: point(NOW - 300)}, NOW)
    store.record_paper("v2", {BOT: None}, NOW)
    store.record_paper("v2", {BOT: point(NOW - 240)}, NOW)
    segments = {p["segment"] for p in store.read("v2", BOT, "1D", NOW)["points"]}
    assert len(segments) == 2


def test_live_recording_never_takes_a_paper_bot(tmp_path):
    store = PerformanceHistory(tmp_path / "native-performance.sqlite3")
    from tests.test_performance_history import packet

    paper_packet = {**packet(t=NOW), "bot_name": BOT}
    store.record("v2", [paper_packet], NOW)
    assert store.read("v2", BOT, "1D", NOW)["points"] == []


def test_paper_wallet_reads_are_marked_simulated(tmp_path):
    store = PerformanceHistory(tmp_path / "native-performance.sqlite3")
    assert store.read_wallet("v2", BOT, "1D", NOW)["simulated"] is True
    assert "simulated" not in store.read_wallet("v2", "rsi_modular_v2", "1D", NOW)


def test_bots_page_totals_and_completeness_count_live_bots_only():
    def native(pnl, *, current=True):
        return {
            "status": "running",
            "source": "native_mqtt",
            "performance_current": current,
            "performance": {
                "c": {
                    "status": "running",
                    "performance": {
                        "realized_pnl_quote": pnl,
                        "unrealized_pnl_quote": 0,
                        "global_pnl_pct": 0,
                        "volume_traded": 100,
                    },
                }
            },
        }

    live_only = build_bots_page(
        {"status": "success", "data": {"rsi_modular_v2": native(3.0)}}
    )
    with_paper = build_bots_page(
        {
            "status": "success",
            "data": {
                "rsi_modular_v2": native(3.0),
                BOT: native(1000.0),
                "meridian_v4_d2h_paper": {
                    "status": "running",
                    "source": "native_mqtt",
                    "performance": {},
                },
            },
        }
    )
    assert (
        (with_paper["total_pnl"], with_paper["total_volume"])
        == (live_only["total_pnl"], live_only["total_volume"])
        == (3.0, 100.0)
    )
    assert (
        with_paper.get("metrics_available", True) is True
    ), "a paper bot never makes fleet metrics unavailable"
    assert any(
        row["bot_name"] == BOT and row["global_pnl_quote"] == 1000.0
        for row in with_paper["controllers"]
    ), "the paper bot keeps its own row"


@pytest.mark.asyncio
async def test_the_status_tick_records_wallets_and_paper_pnl_from_one_runtime_read(
    monkeypatch,
):
    from unittest.mock import AsyncMock, Mock

    from condor import performance_history, wallet_observation
    from condor.server_data_service import CacheKey, ServerDataService, ServerDataType

    observer = Mock()
    monkeypatch.setattr(performance_history, "history", observer)
    reads = AsyncMock(return_value={BOT: runtime(at=NOW - 5), "rsi_modular_v2": None})
    monkeypatch.setattr(wallet_observation, "observe_runtime", reads)
    monkeypatch.setattr("condor.server_data_service.time.time", lambda: NOW)
    sds = ServerDataService()
    monkeypatch.setattr(sds, "_get_client", AsyncMock(return_value=object()))
    sds.register_fetch(ServerDataType.BOTS_STATUS, AsyncMock(return_value=[]))
    await sds._do_fetch_and_cache(CacheKey.make("v2", ServerDataType.BOTS_STATUS))
    reads.assert_awaited_once_with("v2")
    (server, samples), _ = observer.record_paper.call_args
    assert (
        server == "v2"
        and set(samples) == {BOT}
        and samples[BOT]["total_pnl_quote"] == "10.0"
    )
    (_, wallets), _ = observer.record_wallet.call_args
    assert set(wallets) == {BOT, "rsi_modular_v2"}
