import pytest

from condor.fetchers.bots import build_bots_page
from condor.web.models import BotsPageResponse


def test_native_source_deadlines_preserve_performance_and_lifecycle_provenance():
    raw = {
        "source": "native_mqtt",
        "status": "running",
        "performance_current": True,
        "received_at": 1000.0,
        "stale_after_seconds": 30.0,
        "performance": {
            "ctrl": {
                "performance": dict(
                    realized_pnl_quote=0,
                    unrealized_pnl_quote=0,
                    global_pnl_pct=0,
                    volume_traded=0,
                )
            }
        },
        "heartbeat": {"received_at": 1005.0, "source_timestamp": 1004000000.0},
        "lifecycle": {
            "valid": True,
            "observation": {"received_at": 1006.0, "payload": {"generated_at": 1003.0}},
        },
    }
    page = BotsPageResponse(**build_bots_page({"data": {"ok_rsi": raw}})).model_dump()
    bot = page["bots"][0]
    assert bot["performance_received_at"] == 1000.0
    assert bot["performance_stale_after_seconds"] == 30.0
    assert bot["status_received_at"] == 1003.0
    assert bot["status_stale_after_seconds"] == 30.0
    assert page["total_pnl"] == 0


def test_native_missing_source_deadline_stays_missing():
    page = BotsPageResponse(
        **build_bots_page(
            {
                "data": {
                    "ok_rsi": {
                        "source": "native_mqtt",
                        "status": "unknown",
                        "performance_current": False,
                    }
                }
            }
        )
    ).model_dump()
    assert page["bots"][0]["performance_received_at"] is None
    assert page["bots"][0]["status_received_at"] is None


@pytest.mark.parametrize(
    "status", ["identity_unverified", "identity_mismatch", "stale", "retained"]
)
def test_noncurrent_native_data_never_becomes_current_metrics(status):
    page = build_bots_page(
        {
            "data": {
                "ok_rsi": {
                    "source": "native_mqtt",
                    "status": status,
                    "performance_current": False,
                    "performance": {
                        "wrong-controller": {"performance": {"realized_pnl_quote": 123}}
                    },
                }
            }
        }
    )
    assert page["controllers"] == []
    assert page["metrics_available"] is False
    assert page["total_pnl"] is None
    assert page["total_volume"] is None
    serialized = BotsPageResponse(**page).model_dump()
    assert serialized["metrics_available"] is False
    assert serialized["total_pnl"] is None


@pytest.mark.parametrize(
    "missing",
    [
        None,
        "realized_pnl_quote",
        "unrealized_pnl_quote",
        "global_pnl_pct",
        "volume_traded",
    ],
)
@pytest.mark.parametrize(
    "invalid", [None, float("nan"), float("inf"), True, "not-a-number"]
)
def test_current_native_missing_economics_never_falls_back_to_db_or_zero(
    missing, invalid
):
    perf = dict(
        realized_pnl_quote=0, unrealized_pnl_quote=0, global_pnl_pct=0, volume_traded=0
    )
    if missing is None:
        perf = {}
    else:
        perf[missing] = invalid
    page = build_bots_page(
        {
            "data": {
                "ok_rsi": {
                    "source": "native_mqtt",
                    "status": "running",
                    "performance_current": True,
                    "performance": {"ctrl": {"performance": perf}},
                }
            }
        },
        latest_perf={
            "ctrl": {
                "performance": dict(
                    realized_pnl_quote=100,
                    unrealized_pnl_quote=200,
                    global_pnl_pct=1,
                    volume_traded=1000,
                )
            }
        },
    )
    assert len(page["controllers"]) == 1
    row = page["controllers"][0]
    assert row[missing or "realized_pnl_quote"] is None
    assert page["metrics_available"] is False
    assert page["total_pnl"] is None
    assert page["total_volume"] is None
    assert BotsPageResponse(**page).total_pnl is None


def test_current_native_genuine_zero_remains_valid_without_db_enrichment():
    perf = dict(
        realized_pnl_quote=0, unrealized_pnl_quote=0, global_pnl_pct=0, volume_traded=0
    )
    page = build_bots_page(
        {
            "data": {
                "ok_rsi": {
                    "source": "native_mqtt",
                    "status": "running",
                    "performance_current": True,
                    "performance": {"ctrl": {"performance": perf}},
                }
            }
        },
        latest_perf={
            "ctrl": {
                "performance": {"realized_pnl_quote": 100},
                "custom_info": {"stale": True},
            }
        },
    )
    assert page["total_pnl"] == 0
    assert page["total_volume"] == 0


def test_current_native_empty_performance_is_unavailable():
    page = build_bots_page(
        {
            "data": {
                "ok_rsi": {
                    "source": "native_mqtt",
                    "status": "running",
                    "performance_current": True,
                    "performance": {},
                }
            }
        }
    )
    assert page["metrics_available"] is False
    assert page["total_pnl"] is None


@pytest.mark.parametrize("performance", [["invalid"], {"ctrl": "invalid"}])
def test_malformed_current_native_performance_is_unavailable(performance):
    page = build_bots_page(
        {
            "data": {
                "ok_rsi": {
                    "source": "native_mqtt",
                    "status": "running",
                    "performance_current": True,
                    "performance": performance,
                }
            }
        }
    )
    assert page["metrics_available"] is False
    assert page["total_pnl"] is None
