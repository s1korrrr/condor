"""Companion integrity and privacy at the independent gateway boundary."""

import copy
import hashlib
import json
from decimal import Decimal
from pathlib import Path

import pytest
from jsonschema import ValidationError

from condor.web.market_picture_contract import (
    canonical,
    validate_frame,
    validate_response,
)


def digest(value, *omit):
    return hashlib.sha256(
        canonical({key: item for key, item in value.items() if key not in omit})
    ).hexdigest()


def seal(frame):
    frame["snapshot_id"] = digest(frame, "snapshot_id", "payload_digest")
    frame["payload_digest"] = digest(frame, "payload_digest")


def companion_fixture():
    frame = json.loads(
        Path(__file__)
        .with_name("fixtures")
        .joinpath("market-picture.m1-components.fixture.json")
        .read_text()
    )
    scope = {
        key: frame[key]
        for key in (
            "stream_id",
            "epoch",
            "sequence",
            "revision",
            "source_kind",
            "cutoff_ms",
            "available_at_ms",
            "expires_at_ms",
        )
    }
    scope.update(
        universe_id=frame["universe"]["universe_id"],
        universe_revision=frame["universe"]["revision"],
        membership_hash=frame["universe"]["membership_hash"],
        member_instrument_ids=frame["universe"]["member_instrument_ids"],
        selected_numeraire=frame["universe"]["selected_numeraire"],
    )
    companion = {
        "schema_version": "market-picture.microstructure-companion.v1",
        "scope": scope,
        "capabilities": frame.pop("source_capabilities"),
        "microstructure": frame.pop("microstructure"),
    }
    companion["component_id"] = digest(companion)
    rows = [
        *companion["microstructure"]["flows"],
        *companion["microstructure"]["liquidity"],
    ]
    frame["microstructure_ref"] = dict(
        status="available",
        component_id=companion["component_id"],
        cutoff_ms=frame["cutoff_ms"],
        available_at_ms=frame["available_at_ms"],
        expires_at_ms=min(
            [frame["expires_at_ms"], *(row["expires_at_ms"] for row in rows)]
        ),
        reason_codes=[],
    )
    seal(frame)
    response = dict(
        schema_version="market-picture.v1",
        snapshot_id=frame["snapshot_id"],
        stream_id=frame["stream_id"],
        frame_payload_digest=frame["payload_digest"],
        read_at_ms=frame["published_at_ms"] + 100,
        companion=companion,
    )
    return frame, response


def test_companion_frame_and_complete_response_preserve_their_separate_digests():
    frame, response = companion_fixture()
    assert (
        validate_frame(frame, allow_fixture=True)["microstructure_ref"]["component_id"]
        == response["companion"]["component_id"]
    )
    parsed = validate_response("microstructure", canonical(response))
    assert parsed == response
    assert "microstructure" not in frame
    # Reading an immutable snapshot later does not refresh its observations.
    historical = copy.deepcopy(response)
    historical["read_at_ms"] += 30 * 86_400_000
    assert (
        validate_response("microstructure", canonical(historical))["companion"]
        == response["companion"]
    )


@pytest.mark.parametrize(
    "case", ["digest", "stream", "private", "future", "partial_cost", "unknown_field"]
)
def test_gateway_rejects_invalid_companion_even_when_its_outer_digest_is_resealed(case):
    _, response = companion_fixture()
    companion = response["companion"]
    if case == "digest":
        companion["component_id"] = "f" * 64
    elif case == "stream":
        response["stream_id"] = "another-owner"
    elif case == "private":
        companion["capabilities"][0]["access"] = "separately_authorized_private"
    elif case == "future":
        companion["microstructure"]["flows"][0]["available_at_ms"] = (
            companion["scope"]["available_at_ms"] + 1
        )
    elif case == "partial_cost":
        row = next(
            row
            for row in companion["microstructure"]["liquidity"]
            if Decimal(row["uncovered_size"]) > 0
        )
        row["cost_bps"] = "1"
    else:
        companion["capabilities"][0]["account_secret"] = "synthetic-disallowed-field"
    if case != "digest":
        companion["microstructure"]["component_id"] = digest(
            companion["microstructure"], "component_id"
        )
        companion["component_id"] = digest(companion, "component_id")
    with pytest.raises((ValueError, ValidationError)):
        validate_response("microstructure", canonical(response))


def test_companion_response_has_an_independent_unchanged_size_bound():
    _, response = companion_fixture()
    response["unexpected"] = "x" * (2 * 1024 * 1024)
    with pytest.raises(ValueError, match="payload size"):
        validate_response("microstructure", canonical(response))


def test_inline_and_companion_frames_cannot_claim_the_same_payload_twice():
    frame, response = companion_fixture()
    frame["microstructure"] = response["companion"]["microstructure"]
    seal(frame)
    with pytest.raises(ValueError, match="coexist"):
        validate_frame(frame, allow_fixture=True)
    del frame["microstructure"]
    frame["microstructure_ref"]["status"] = "unavailable"
    frame["microstructure_ref"]["reason_codes"] = ["SOURCE_UNAVAILABLE"]
    seal(frame)
    with pytest.raises(ValueError, match="unavailable"):
        validate_frame(frame, allow_fixture=True)


def test_native_adapter_store_and_route_fixtures_pass_the_independent_gateway():
    directory = Path(__file__).with_name("fixtures")
    frame = validate_response(
        "latest",
        (
            directory / "market-picture.microstructure-companion.frame.fixture.json"
        ).read_bytes(),
    )
    response = validate_response(
        "microstructure",
        (
            directory / "market-picture.microstructure-companion.response.fixture.json"
        ).read_bytes(),
    )
    assert response["snapshot_id"] == frame["snapshot_id"]
    assert response["frame_payload_digest"] == frame["payload_digest"]
    assert (
        response["companion"]["component_id"]
        == frame["microstructure_ref"]["component_id"]
    )
