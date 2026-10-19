"""The two fill wire projections preserve attested execution time separately."""

import pytest
import json
from pathlib import Path

from condor.web import fleet_fills, fleet_summary


RECORDED = 1792281601000
EXECUTED = RECORDED - 2000


def row(**overrides):
    return {"fill_id": "trade-1", "bot_name": "ok_rsi", "connector_name": "okx",
            "source_db_id": "db", "pair": "ETH-USDC", "side": "buy",
            "timestamp": "2026-10-18T00:00:01Z", "amount_base": 1, "price_quote": 100,
            "gross_volume_quote": 100, "fee_quote": .1,
            "execution_timestamp_ms": EXECUTED, "execution_timestamp_source": "okx.fillTime",
            **overrides}


def projections(fill, bot="ok_rsi"):
    summary = fleet_summary.project_fills({"rows": [fill]}, bot, RECORDED)[0]
    paged, error = fleet_fills.normalize_fill(fill, bot, RECORDED)
    assert error is None
    return summary, paged


def test_paper_bot_cannot_attest_an_exchange_execution_even_without_owner_simulation_flags():
    for fill in projections(row(bot_name="ok_rsi_paper"), "ok_rsi_paper"):
        assert fill["execution_timestamp_ms"] is None
        assert fill["execution_timestamp_source"] is None
        assert fill["time_ms"] == RECORDED
        assert fill["amount"] == "1"


def test_both_fill_projections_keep_recorded_and_execution_clocks_distinct():
    for fill in projections(row()):
        assert fill["time_ms"] == RECORDED
        assert fill["execution_timestamp_ms"] == EXECUTED
        assert fill["execution_timestamp_source"] == "okx.fillTime"
        assert fill["amount"] == "1"
        assert fill["volume"] == "100"


@pytest.mark.parametrize("value,source", [
    (True, "okx.fillTime"), (0, "okx.fillTime"), (-1, "okx.fillTime"),
    ("1792281599000", "okx.fillTime"), (1.5, "okx.fillTime"),
    (EXECUTED, None), (EXECUTED, "okx.uTime"),
    (RECORDED + 5001, "okx.fillTime"), (253402300800000, "okx.fillTime"),
])
def test_bad_execution_clock_never_drops_a_valid_recorded_financial_receipt(value, source):
    for fill in projections(row(execution_timestamp_ms=value, execution_timestamp_source=source)):
        assert fill["execution_timestamp_ms"] is None
        assert fill["execution_timestamp_source"] is None
        assert fill["time_ms"] == RECORDED
        assert fill["amount"] == "1"


def test_clock_admission_checks_owner_recorded_clock_and_response_clock():
    for fill in projections(row(timestamp=None)):
        assert fill["execution_timestamp_ms"] is None
    for fill in projections(row(timestamp="2026-10-18T00:00:00Z",
                                execution_timestamp_ms=RECORDED + 5000)):
        assert fill["execution_timestamp_ms"] is None


def test_legacy_reader_keeps_missing_execution_clock_unknown():
    legacy = row()
    legacy.pop("execution_timestamp_ms")
    legacy.pop("execution_timestamp_source")
    for fill in projections(legacy):
        assert fill["execution_timestamp_ms"] is None
        assert fill["execution_timestamp_source"] is None


def test_paged_fill_identity_and_order_key_still_use_native_recorded_time():
    fill = projections(row())[1]
    other = projections(row(execution_timestamp_ms=EXECUTED - 86400000))[1]
    assert fill["id"] == other["id"]
    assert fleet_fills.order_key(fill) == fleet_fills.order_key(other)


def test_compact_summary_preserves_the_full_summary_clock_attestation():
    full = json.loads((Path(__file__).parent / "fixtures/fleet_summary/summary_full.example.json").read_text())
    full["fills"] = [projections(row())[0]]
    compact = fleet_summary.glance(full)
    assert compact["fills"][0]["time_ms"] == RECORDED
    assert compact["fills"][0]["execution_timestamp_ms"] == EXECUTED
    assert compact["fills"][0]["execution_timestamp_source"] == "okx.fillTime"
