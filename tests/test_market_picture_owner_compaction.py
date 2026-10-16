"""Frames exactly as the owner serves them: compact, with null and default values omitted."""

import json
from pathlib import Path

import pytest

from condor.web.market_picture_contract import validate_frame, validate_response

OWNER_COMPACT = Path(__file__).with_name("fixtures") / "owner-compact"
FRAMES = sorted(OWNER_COMPACT.glob("*.owner-compact.json"))


def test_owner_compact_fixture_set_is_present():
    assert len(FRAMES) == 8


@pytest.mark.parametrize("path", FRAMES, ids=lambda path: path.name)
def test_owner_compacted_frames_validate_at_the_gateway(path):
    raw = path.read_bytes()
    frame = json.loads(raw)
    validate_frame(frame, allow_fixture=True)
    validate_response("latest", json.dumps(frame).encode()) if not frame.get(
        "fixture_marker"
    ) else None


def test_unavailable_anomaly_counts_are_absent_on_the_wire_and_accepted():
    frame = json.loads(
        (
            OWNER_COMPACT
            / "market-picture.m1-components.fixture.unavailable-anomaly.owner-compact.json"
        ).read_text()
    )
    metric = frame["candle_anomalies"]["metrics"]["extreme_realized_volatility_1h_95p"]
    assert (
        metric["valid_count"] == 0
        and "high_count" not in metric
        and "share_fraction" not in metric
    )
    validate_frame(frame, allow_fixture=True)
