import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from condor.v5.dashboard import read_compatibility_path
from condor.v5.paper import PaperObservation

BOT = "meridian_v5_paper"

API_ENVELOPES = json.loads(
    (Path(__file__).parent / "fixtures/paper-api-7b12d1c2/envelopes.json").read_text()
)

FINAL3 = Path(__file__).parent / "fixtures/paper-api-final3"


@pytest.mark.parametrize("section", ["wallet", "positions", "fills", "executors", "risk", "decisions", "history", "operations", "status"])
def test_final3_authenticated_native_api_records_are_available(tmp_path, section):
    from test_v5_paper_binding import client_for

    payload = json.loads((FINAL3 / (section + ".json")).read_text())

    class Source:
        async def observation(self, path):
            return payload

    route = next(path for path, name in ROUTES.items() if name == section)
    with client_for(tmp_path, Source(), clock_s=payload["read_at_ms"] / 1000) as client:
        response = client.get("/api/v5/dashboard/read", params={"path": route})
    assert response.status_code == 200, response.text
    assert response.json()["state"] == "available"
    assert response.json()["data"] == payload["data"]


def test_final3_native_orders_and_accounting_are_validated_without_inventing_api_routes():
    from condor.v5.paper import _validate_section_data, _validate_read_tree

    native = json.loads((FINAL3 / "native-observation.json").read_text())
    for section in ("orders", "accounting"):
        data = native[section]["data"]
        _validate_read_tree(data)
        _validate_section_data(section, data)


@pytest.mark.parametrize("section,change", [
    ("executors", {"pnl_scope": 1}), ("executors", {"pnl_scope": "bad scope"}),
    ("fills", {"fee": {"fee_type": "invented", "flat_fees": [], "percent": "0", "percent_token": None}}),
    ("fills", {"fee": {"fee_type": "AddedToCost", "flat_fees": [], "percent": 0, "percent_token": None}}),
    ("fills", {"quantity": "not money"}), ("fills", {"quantity": False}), ("executors", {"fees_paid": {"USDC": 1}}),
])
def test_native_financial_metadata_does_not_weaken_amount_or_enum_validation(section, change):
    from condor.v5.paper import validate_paper_read

    payload = json.loads((FINAL3 / (section + ".json")).read_text())
    payload["data"][0].update(change)
    with pytest.raises(HTTPException) as error:
        validate_paper_read(payload, section=section, bot=BOT, now_ms=payload["read_at_ms"])
    assert error.value.detail["section"] == section
    assert error.value.detail["code"] == "paper_read_schema_invalid"


def test_real_response_provenance_hashes_are_reproducible():
    from hashlib import sha256

    receipt = json.loads((FINAL3 / "provenance.json").read_text())
    for filename, item in receipt["records"].items():
        assert sha256((FINAL3 / filename).read_bytes()).hexdigest() == item.get("vendored_sha256", item.get("sha256"))


@pytest.mark.parametrize("section", ["status", "wallet", "positions", "fills", "executors", "risk", "decisions", "history", "operations", "accounting"])
def test_real_native_api_replay_preserves_owner_states_and_records(section):
    from condor.v5.paper import validate_paper_read

    packet = json.loads((FINAL3 / "native-replay" / (section + ".json")).read_text())
    read = validate_paper_read(packet, section=section, bot=BOT, now_ms=packet["read_at_ms"])
    assert read["state"] == packet["state"]
    assert read["data"] == packet["data"]


def test_history_limit_is_capped_to_pinned_api73_query_constraint(tmp_path):
    import re
    from condor.v5.dashboard import paper_read_route
    from urllib.parse import parse_qs

    declaration = (FINAL3 / "api73-paper-route.py.txt").read_text()
    maximum = int(re.search(r"limit: int = Query\(default=100, ge=1, le=(\d+)\)", declaration)[1])
    result = paper_read_route("/api/v1/servers/rsibot-v5/controller-performance/history", "limit=1000&interval=5m", BOT)
    assert parse_qs(result[1])["limit"] == [str(maximum)]


@pytest.mark.parametrize("query", ["cursor=" + "a" * 513, "start_ms=1", "start_ms=1&end_ms=2678400002"])
def test_owner_query_bounds_reject_invalid_cursor_and_ranges(query):
    from condor.v5.dashboard import paper_read_route

    with pytest.raises(HTTPException):
        paper_read_route("/api/v1/servers/rsibot-v5/controller-performance/history", query, BOT)


@pytest.mark.parametrize("name", list(API_ENVELOPES))
def test_real_api_73_envelopes_cross_authenticated_condor_boundary(tmp_path, name):
    from test_v5_paper_binding import client_for

    payload = API_ENVELOPES[name]

    class Source:
        async def observation(self, path):
            return payload

    if payload["section"] == "candles":
        from condor.v5.paper import validate_paper_read

        result = validate_paper_read(
            payload, section="candles", bot=BOT, now_ms=payload["read_at_ms"]
        )
        assert result["capabilities"] == []
        assert result["state"] == "collecting"
        return
    route = next(path for path, section in ROUTES.items() if section == payload["section"])
    with client_for(tmp_path, Source(), clock_s=payload["read_at_ms"] / 1000) as client:
        response = client.get("/api/v5/dashboard/read", params={"path": route})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["capabilities"] == payload["capabilities"]
    assert result["state"] == payload["state"]
    assert result["read_at_ms"] == payload["read_at_ms"]


@pytest.mark.parametrize("capabilities", [[], ["read"], ["read", "history"], [""]])
def test_string_capability_lists_are_valid(capabilities):
    from condor.v5.paper import validate_paper_read

    result = validate_paper_read(
        envelope("executors", capabilities=capabilities), section="executors",
        bot=BOT, now_ms=int(NOW * 1000),
    )
    assert result["capabilities"] == capabilities


def test_api_nullable_metadata_and_collecting_completeness_are_preserved():
    from condor.v5.paper import validate_paper_read

    for state in ["available", "collecting", "degraded", "stale", "not_applicable"]:
        payload = envelope("executors", state=state, reason=None,
                           observed_at_ms=None, source_at_ms=None,
                           read_at_ms=int(NOW * 1000), stale_reason=None)
        assert validate_paper_read(
            payload, section="executors", bot=BOT, now_ms=int(NOW * 1000)
        )["reason"] is None
    payload = dict(API_ENVELOPES["collecting"], section="status", state="degraded",
                   data={"owner_chain_anchor": {"seq": 1}})
    assert validate_paper_read(
        payload, section="status", bot=BOT, now_ms=payload["read_at_ms"]
    )["observed_at_ms"] is None


def c1_native_risk():
    return json.loads(
        (
            Path(__file__).parent / "fixtures/paper-c1-1e131c74/native-entry-holds.json"
        ).read_text()
    )["risk"]["data"]


@pytest.mark.parametrize(
    "reason",
    [
        "stop_persistence_failed", "clock_persistence_failed", "clock_invalid",
        "stop_intent_log_damaged", "ingress_unreadable", "clock_anomaly",
        "paper_controls_unavailable",
    ],
)
def test_c1_all_owner_hold_classes_are_readable(reason):
    from copy import deepcopy
    from condor.v5.paper import validate_paper_read

    data = deepcopy(C1_TARGET_HOLD_FIXTURES["clock-failure-hold"]["risk"])
    data.update(
        control_hold=reason, reason=reason, explanation="Owner safety hold",
        holds=[{"reason": reason, "explanation": "Owner safety hold"}],
    )
    fixtures = {
        "stop_intent_log_damaged": "stop-intent-log-damaged",
        "ingress_unreadable": "ingress-unreadable-hold",
        "clock_anomaly": "clock-anomaly-hold",
        "paper_controls_unavailable": "paper-controls-unavailable",
    }
    if reason in fixtures:
        path = Path(__file__).parent / "fixtures/paper-c1-1e131c74" / (fixtures[reason] + ".json")
        data = json.loads(path.read_text())["risk"]["data"]
    read = envelope("risk", state="degraded", reason=reason, data=data)
    assert validate_paper_read(
        read, section="risk", bot=BOT, now_ms=int(NOW * 1000)
    )["data"] == data


def test_unknown_owner_hold_class_still_fails_closed():
    from condor.v5.paper import validate_paper_read

    with pytest.raises(HTTPException) as error:
        validate_paper_read(
            envelope("risk", data={"control_hold": "future_hold",
                "holds": [{"reason": "future_hold", "explanation": "Held"}]}),
            section="risk", bot=BOT, now_ms=int(NOW * 1000),
        )
    assert error.value.status_code == 502
    assert error.value.detail["section"] == "risk"


def test_risk_hold_schema_tracks_the_pinned_c1_owner_enum():
    from condor.v5.paper import C1_DATA_SCHEMA

    path = Path(__file__).parent / "fixtures/paper-c1-1e131c74/schema.json"
    owner = json.loads(path.read_text())
    producer = owner["properties"]["risk"]["allOf"][1]["properties"]["data"]["anyOf"][1]
    consumer = C1_DATA_SCHEMA["properties"]["risk"]["anyOf"][1]
    assert consumer["if"] == producer["if"]
    assert consumer["then"] == producer["then"]
    assert C1_DATA_SCHEMA["properties"]["risk"]["allOf"] == producer["allOf"]


def test_c1_keyed_risk_map_is_readable(tmp_path):
    from test_v5_paper_binding import client_for

    class Source:
        async def observation(self, path):
            return envelope("risk", data=c1_native_risk())

    with client_for(tmp_path, Source()) as client:
        response = client.get(
            "/api/v5/dashboard/read",
            params={"path": f"/api/v1/servers/rsibot-v5/bots/{BOT}/risk"},
        )
    assert response.status_code == 200
    assert response.json()["data"]["controllers"]["sol"]["native"]["complete"] is False


@pytest.mark.parametrize(
    "controllers,expected", [([], 200), ({"bnb": {"operator": {}, "native": {}}}, 502)]
)
def test_decisions_keep_their_list_contract(tmp_path, controllers, expected):
    from test_v5_paper_binding import client_for

    class Source:
        async def observation(self, path):
            return envelope("decisions", data={"controllers": controllers})

    with client_for(tmp_path, Source()) as client:
        response = client.get(
            "/api/v5/dashboard/read",
            params={"path": f"/api/v1/servers/rsibot-v5/bots/{BOT}/decisions"},
        )
    assert response.status_code == expected
    if expected == 502:
        assert response.json()["detail"]["section"] == "decisions"


@pytest.mark.parametrize(
    "controllers",
    [
        [],
        {"": {"operator": {}, "native": {}}},
        {"bnb": None},
        {"bnb": {"operator": [], "native": {}}},
        {"bnb": {"operator": {}}},
    ],
)
def test_risk_controller_map_rejects_malformed_shapes(tmp_path, controllers):
    from test_v5_paper_binding import client_for

    class Source:
        async def observation(self, path):
            return envelope("risk", data={"controllers": controllers})

    with client_for(tmp_path, Source()) as client:
        response = client.get(
            "/api/v5/dashboard/read",
            params={"path": f"/api/v1/servers/rsibot-v5/bots/{BOT}/risk"},
        )
    assert response.status_code == 502
    assert response.json()["detail"]["section"] == "risk"
    assert response.json()["detail"]["reason"] == "schema_invalid"


C1_TARGET_HOLD_FIXTURES = json.loads(r"""{
  "partial-buy-cancel-tp-partial-close": {
    "positions": [
      {
        "position_id": "executor-1",
        "executor_id": "executor-1",
        "controller_id": "v5_BNB_USDC",
        "trading_pair": "BNB-USDC",
        "quantity": "0.6",
        "remaining_basis_quote": "60.06",
        "fee_currency": "USDC",
        "state": "active",
        "protected_exit": true,
        "target_price": "102",
        "target_basis": "native_placed_fixed_target_limit",
        "target_reason": null,
        "protected_exit_order": {
          "order_id": "tp-1",
          "state": "partially_filled",
          "price": "102",
          "remaining_amount": "0.6",
          "placed_at_ms": 1793275130000
        },
        "remaining_target_amount": "0.6"
      }
    ],
    "executors": [
      {
        "executor_id": "executor-1",
        "controller_id": "v5_BNB_USDC",
        "state": "partial_close",
        "remaining_close_quantity": "0.6",
        "quantity": "0.6",
        "remaining_basis_quote": "60.06",
        "cum_fees_quote": "0.1408",
        "realized_pnl_quote": "0.7192",
        "unrealized_pnl_quote": "0.54",
        "unit": "USDC",
        "custom_info": {
          "entry_lifecycle": {
            "state": "terminal",
            "requested_quantity": "2",
            "filled_quantity": "1",
            "canceled_remainder_quantity": "1"
          }
        },
        "target_price": "102",
        "target_basis": "native_placed_fixed_target_limit",
        "target_reason": null,
        "protected_exit_order": {
          "order_id": "tp-1",
          "state": "partially_filled",
          "price": "102",
          "remaining_amount": "0.6",
          "placed_at_ms": 1793275130000
        },
        "remaining_target_amount": "0.6",
        "protected_exit": true
      }
    ]
  },
  "clock-failure-hold": {
    "risk": {
      "schema": "rsibot.v5-paper.risk.v1",
      "control_hold": "clock_persistence_failed",
      "reason": "clock_persistence_failed",
      "explanation": "New acquisitions are held until explicit owner maintenance acknowledgement; protective exits remain enabled.",
      "protected_exits": "preserved",
      "clock_recovery": {
        "required": true,
        "high_water_ms": 1793275200000,
        "hold": {
          "reason": "clock_persistence_failed",
          "failure_id": "fixture-failure",
          "detail": "injected clock durability failure"
        }
      },
      "holds": [
        {
          "reason": "clock_persistence_failed",
          "explanation": "New acquisitions are held until explicit owner maintenance acknowledgement; protective exits remain enabled."
        }
      ]
    }
  },
  "clock-invalid-hold": {
    "risk": {
      "schema": "rsibot.v5-paper.risk.v1",
      "control_hold": "clock_persistence_failed",
      "reason": "clock_invalid",
      "explanation": "Invalid clock: stops still apply; clears and native advancement are held. Timestamp is the last valid native checkpoint.",
      "protected_exits": "preserved",
      "clock_recovery": {
        "required": true,
        "high_water_ms": 1793275200000,
        "hold": {
          "reason": "clock_persistence_failed",
          "failure_id": "fixture-failure",
          "detail": "clock_invalid: invalid poll sample"
        }
      },
      "holds": [
        {
          "reason": "clock_persistence_failed",
          "explanation": "New acquisitions are held until explicit owner maintenance acknowledgement; protective exits remain enabled."
        },
        {
          "reason": "clock_invalid",
          "explanation": "Invalid clock: stops still apply; clears and native advancement are held. Timestamp is the last valid native checkpoint."
        }
      ]
    }
  },
  "stop-persistence-failure-hold": {
    "risk": {
      "schema": "rsibot.v5-paper.risk.v1",
      "control_hold": "stop_persistence_failed",
      "reason": "stop_persistence_failed",
      "explanation": "Stop durability is unproven. Entries stay held until reviewed owner emergency reset; exits remain enabled.",
      "protected_exits": "preserved",
      "clock_recovery": {
        "required": false,
        "high_water_ms": 1793275200000,
        "hold": null
      },
      "holds": [
        {
          "reason": "stop_persistence_failed",
          "explanation": "Stop durability is unproven. Entries stay held until reviewed owner emergency reset; exits remain enabled."
        }
      ],
      "emergency_recovery": {
        "required": true,
        "hold": {
          "reason": "stop_persistence_failed",
          "failure_id": "fixture-stop-durability",
          "detail": "injected stop commit failure"
        },
        "acknowledgements": []
      }
    }
  }
}""")


@pytest.mark.parametrize("section", ["positions", "executors"])
def test_c1_native_exit_projection_validates_and_rejects_bad_fields(section):
    from copy import deepcopy
    from condor.v5.paper import validate_paper_read

    rows = C1_TARGET_HOLD_FIXTURES["partial-buy-cancel-tp-partial-close"][section]
    read = envelope(section, data=rows)
    assert (
        validate_paper_read(read, section=section, bot=BOT, now_ms=int(NOW * 1000))[
            "data"
        ]
        == rows
    )
    for field, bad in [
        ("target_basis", ""),
        ("remaining_target_amount", {}),
        ("protected_exit_order", {"state": "open"}),
    ]:
        malformed = deepcopy(read)
        malformed["data"][0][field] = bad
        with pytest.raises(HTTPException) as error:
            validate_paper_read(
                malformed, section=section, bot=BOT, now_ms=int(NOW * 1000)
            )
        assert error.value.status_code == 502
        assert error.value.detail == {
            "code": "paper_read_schema_invalid",
            "reason": "schema_invalid",
            "section": section,
        }


@pytest.mark.parametrize(
    "name",
    ["clock-failure-hold", "clock-invalid-hold", "stop-persistence-failure-hold"],
)
def test_c1_risk_hold_requires_each_explanation(name):
    from copy import deepcopy
    from condor.v5.paper import validate_paper_read

    read = envelope("risk", data=C1_TARGET_HOLD_FIXTURES[name]["risk"])
    assert (
        validate_paper_read(read, section="risk", bot=BOT, now_ms=int(NOW * 1000))[
            "data"
        ]
        == read["data"]
    )
    malformed = deepcopy(read)
    malformed["data"]["holds"][0]["explanation"] = ""
    with pytest.raises(HTTPException) as error:
        validate_paper_read(malformed, section="risk", bot=BOT, now_ms=int(NOW * 1000))
    assert error.value.detail["section"] == "risk"


@pytest.mark.parametrize(
    "state", ["available", "collecting", "degraded", "stale", "not_applicable"]
)
@pytest.mark.parametrize("control", ["missing", None, "clock_persistence_failed"])
@pytest.mark.parametrize("explanation", [None, "", "   ", 7])
def test_risk_holds_validate_each_entry_independent_of_control_and_state(
    state, control, explanation
):
    from copy import deepcopy
    from condor.v5.paper import validate_paper_read

    data = deepcopy(C1_TARGET_HOLD_FIXTURES["clock-failure-hold"]["risk"])
    if control == "missing":
        data.pop("control_hold")
    else:
        data["control_hold"] = control
    data["holds"][0]["explanation"] = explanation
    with pytest.raises(HTTPException) as error:
        validate_paper_read(
            envelope("risk", state=state, reason="Owner read", data=data),
            section="risk",
            bot=BOT,
            now_ms=int(NOW * 1000),
        )
    assert error.value.status_code == 502
    assert error.value.detail["reason"] == "schema_invalid"
    assert error.value.detail["section"] == "risk"
    assert error.value.detail["holds"] == [{"reason": "clock_persistence_failed"}]


@pytest.mark.parametrize(
    "control,holds",
    [
        (None, [{"reason": "clock_invalid", "explanation": "Clock held"}]),
        ("clock_invalid", []),
        (
            "clock_invalid",
            [{"reason": "clock_persistence_failed", "explanation": "Clock held"}],
        ),
        (None, [{"reason": "future_safety_hold", "explanation": "Owner held"}]),
    ],
)
def test_risk_hold_inconsistency_is_typed_but_retains_structured_hold_signals(
    control, holds
):
    from condor.v5.paper import validate_paper_read

    with pytest.raises(HTTPException) as error:
        validate_paper_read(
            envelope("risk", data={"control_hold": control, "holds": holds}),
            section="risk",
            bot=BOT,
            now_ms=int(NOW * 1000),
        )
    assert error.value.status_code == 502
    assert error.value.detail["section"] == "risk"
    assert error.value.detail["holds"]


@pytest.mark.parametrize(
    "reason,control",
    [
        ("clock_persistence_failed", None),
        ("clock_invalid", "missing"),
        ("stop_persistence_failed", None),
        ("future_safety_hold", None),
    ],
)
def test_authenticated_invalid_risk_preserves_hold_presence_without_trusting_explanation(
    tmp_path, reason, control
):
    from test_v5_paper_binding import client_for

    class Source:
        async def observation(self, path):
            data = {"holds": [{"reason": reason, "explanation": ""}]}
            if control != "missing":
                data["control_hold"] = control
            return envelope("risk", data=data)

    with client_for(tmp_path, Source()) as client:
        response = client.get(
            "/api/v5/dashboard/read",
            params={"path": f"/api/v1/servers/rsibot-v5/bots/{BOT}/risk"},
        )
    assert response.status_code == 502
    assert response.json()["detail"] == {
        "code": "paper_read_schema_invalid",
        "reason": "schema_invalid",
        "section": "risk",
        "holds": [{"reason": reason}],
    }


NOW = 1_800_000_000.0


def test_frozen_c1_data_validator_agrees_with_jsonschema_oracle():
    from copy import deepcopy
    from condor.v5.paper import C1_DATA_SCHEMA, _matches_c1_schema

    jsonschema = pytest.importorskip("jsonschema")
    for section, schema in C1_DATA_SCHEMA["properties"].items():
        validator = jsonschema.Draft202012Validator(
            {"$defs": C1_DATA_SCHEMA["$defs"], **schema}
        )
        valid = envelope(section)["data"]
        corpus = [valid, None, [], [None], True, 1, "bad", {}]
        if isinstance(valid, dict):
            for key in valid:
                missing = deepcopy(valid)
                missing.pop(key)
                corpus.append(missing)
                for bad in [None, True, 2, [], {}, "bad"]:
                    changed = deepcopy(valid)
                    changed[key] = bad
                    corpus.append(changed)
        for value in corpus:
            assert _matches_c1_schema(value, schema) == validator.is_valid(value), (
                section,
                value,
            )


@pytest.mark.parametrize(
    "section,data",
    [
        ("executors", [None]),
        ("positions", {"bad": "shape"}),
        ("wallet", []),
        ("fills", ["bad"]),
        ("decisions", []),
        ("risk", []),
        ("history", []),
        ("operations", []),
        ("status", []),
        ("executors", [{}]),
        (
            "executors",
            [
                {
                    "executor_id": "e1",
                    "controller_id": "c1",
                    "state": "active",
                    "target_price": {},
                }
            ],
        ),
        (
            "executors",
            [
                {
                    "executor_id": "e1",
                    "controller_id": "c1",
                    "state": "active",
                    "quantity": 7,
                }
            ],
        ),
        ("wallet", {"quote_asset": "USDC", "assets": [None]}),
        ("decisions", {"controllers": [None]}),
        ("positions", [{"position_id": 7}]),
    ],
)
def test_authenticated_malformed_section_is_a_typed_schema_error(
    tmp_path, section, data
):
    from test_v5_paper_binding import client_for

    class Source:
        async def observation(self, path):
            return envelope(section, data=data)

    path = next(path for path, name in ROUTES.items() if name == section)
    with client_for(tmp_path, Source()) as client:
        response = client.get("/api/v5/dashboard/read", params={"path": path})
    assert response.status_code == 502
    assert response.json()["detail"]["section"] == section
    assert response.json()["detail"]["reason"] == "schema_invalid"


@pytest.mark.parametrize(
    "state", ["available", "collecting", "degraded", "stale", "not_applicable"]
)
@pytest.mark.parametrize(
    "field,bad",
    [
        ("reason", {}),
        ("state", []),
        ("generated_at_ms", True),
        ("generated_at_ms", "1793275200000"),
        ("source_at_ms", {}),
        ("observed_at_ms", -1),
        ("snapshot_id", []),
        ("completeness", {}),
        ("completeness", "unknown"),
        ("next_cursor", []),
        ("capabilities", {}),
        ("capabilities", 1),
        ("capabilities", [1]),
        ("read_at_ms", True),
        ("read_at_ms", -1),
        ("stale_reason", {}),
        ("source", []),
        ("bot_id", {}),
        ("simulated", "true"),
    ],
)
def test_authenticated_malformed_envelope_is_a_typed_section_error(
    tmp_path, state, field, bad
):
    from test_v5_paper_binding import client_for

    class Source:
        async def observation(self, path):
            return envelope(
                "executors", **{"state": state, "reason": "Owner state", field: bad}
            )

    with client_for(tmp_path, Source()) as client:
        response = client.get(
            "/api/v5/dashboard/read",
            params={"path": f"/api/v1/servers/rsibot-v5/bots/{BOT}/executors"},
        )
    assert response.status_code == 502
    assert response.json()["detail"] == {
        "code": "paper_read_schema_invalid",
        "reason": "schema_invalid",
        "section": "executors",
    }


@pytest.mark.parametrize("section", ["positions", "executors", "fills", "orders"])
@pytest.mark.parametrize(
    "state", ["available", "collecting", "degraded", "stale", "not_applicable"]
)
@pytest.mark.parametrize("completeness", ["missing", None, "invalid", {}])
def test_list_sections_require_completeness_in_every_state(
    section, state, completeness
):
    from condor.v5.paper import validate_paper_read

    value = envelope(section, state=state, reason="Owner state", data=[])
    if completeness == "missing":
        value.pop("completeness", None)
    else:
        value["completeness"] = completeness
    with pytest.raises(HTTPException) as caught:
        validate_paper_read(value, section=section, bot=BOT, now_ms=int(NOW * 1000))
    assert caught.value.status_code == 502
    assert caught.value.detail == {
        "code": "paper_read_schema_invalid",
        "reason": "schema_invalid",
        "section": section,
    }


def test_authenticated_empty_executors_without_completeness_are_not_available(tmp_path):
    from test_v5_paper_binding import client_for

    class Source:
        async def observation(self, path):
            value = envelope("executors", data=[])
            value.pop("completeness", None)
            return value

    with client_for(tmp_path, Source()) as client:
        response = client.get(
            "/api/v5/dashboard/read",
            params={"path": f"/api/v1/servers/rsibot-v5/bots/{BOT}/executors"},
        )
    assert response.status_code == 502
    assert response.json()["detail"]["section"] == "executors"
    assert response.json()["detail"]["reason"] == "schema_invalid"


def observe(_path):
    return PaperObservation(
        "FRESH", "PAPER_STATUS_FRESH", BOT, NOW, {"generated_at": NOW}
    )


ROUTES = {
    f"/api/v1/servers/rsibot-v5/bots/{BOT}/native/status": "status",
    f"/api/v1/servers/rsibot-v5/bots/{BOT}/quant-summary": "status",
    "/api/v1/servers/rsibot-v5/controller-performance/history?interval=5m&limit=1000": "history",
    "/api/v1/servers/rsibot-v5/fleet/holdings": "positions",
    "/api/v1/servers/rsibot-v5/fleet/fills?limit=100": "fills",
    "/api/v1/servers/rsibot-v5/fleet/summary": "wallet",
    "/api/v1/servers/rsibot-v5/fleet/accounting": "accounting",
    f"/api/v1/servers/rsibot-v5/bots/{BOT}/executors": "executors",
    f"/api/v1/servers/rsibot-v5/bots/{BOT}/risk": "risk",
    f"/api/v1/servers/rsibot-v5/bots/{BOT}/decisions": "decisions",
    "/api/v1/operations/workspace": "operations",
    f"/api/v1/trading-visuals/quant-summary?bot={BOT}": "status",
}


def envelope(section="status", **changes):
    value = {
        "schema": "rsibot.v5-paper.read.v1",
        "section": section,
        "state": "available",
        "completeness": "complete",
        "reason": None,
        "bot_id": BOT,
        "execution_mode": "paper",
        "simulated": True,
        "snapshot_id": "boot-a:7",
        "boot_id": "boot-a",
        "sequence": 7,
        "generated_at_ms": int(NOW * 1000),
        "read_at_ms": int(NOW * 1000),
        "observed_at_ms": int(NOW * 1000),
        "source_at_ms": int(NOW * 1000),
        "capabilities": [],
        "source": {},
        "data": {
            "amount": "51.089087718",
            "unit": "USDC",
            **(
                {
                    "program": {
                        "entry_count": 1,
                        "exit_count": 1,
                        "fees_paid_quote": "0.1408",
                        "realized_pnl_quote": "0.7192",
                        "unrealized_pnl_quote": "0.54",
                        "volume_traded_quote": "140.8",
                    }
                }
                if section == "accounting"
                else {}
            ),
        },
    }
    if section == "wallet":
        value["data"].update(
            quote_asset="USDC",
            assets=[],
            initial_funding_quote="1000",
            external_cash_flows_quote="0",
            equity_quote="1000",
            valuation_policy="midpoint_fresh_book_only",
        )
    elif section in {"positions", "fills", "executors"}:
        value["data"] = []
    elif section == "accounting":
        value["data"].update(
            controllers={}, source="native_exact_lifetime_receipts_not_fill_pages"
        )
        value["data"]["program"].update(
            accounting_since_ms=int(NOW * 1000),
            accounting_since_reason=None,
            fees_paid={"USDC": "0.1408"},
            fee_quote_valuation_basis="native_quote",
            count_basis="distinct_filled_orders",
            unavailable_reasons={},
        )
    value.update(changes)
    return value


@pytest.mark.parametrize("path,section", ROUTES.items())
def test_browser_inventory_routes_bind_only_the_paper_owner(tmp_path, path, section):
    paper = observe(tmp_path)
    result = read_compatibility_path(path, paper, paper_read=envelope(section))
    assert result["state"] == "available"
    assert result["snapshot_id"] == "boot-a:7"
    assert result["data"] == envelope(section)["data"]


def test_missing_section_is_degraded_not_a_fabricated_empty_wallet(tmp_path):
    result = read_compatibility_path(
        next(iter(ROUTES)), observe(tmp_path), resolve_paper_reads=True
    )
    assert result["state"] == "degraded"
    assert result["data"] is None


@pytest.mark.parametrize(
    "status,expected", [(404, 200), (501, 200), (503, 503), (401, 401)]
)
def test_optional_accounting_is_collecting_only_when_not_published(
    tmp_path, status, expected
):
    from test_v5_paper_binding import client_for
    from condor.v5.upstream import UpstreamError

    class Source:
        async def observation(self, path):
            assert path == "/v1/paper/accounting"
            raise UpstreamError("upstream_unavailable", http_status=status)

    with client_for(tmp_path, Source()) as client:
        response = client.get(
            "/api/v5/dashboard/read",
            params={"path": "/api/v1/servers/rsibot-v5/fleet/accounting"},
        )
        assert response.status_code == expected
        if expected == 200:
            assert response.json()["state"] == "collecting"
            assert response.json()["data"] is None
            assert response.json()["snapshot_id"] is None


@pytest.mark.parametrize(
    "field,value",
    [
        ("entry_count", True),
        ("exit_count", -1),
        ("volume_traded_quote", 140),
        ("accounting_since_ms", int(NOW * 1000) + 6000),
    ],
)
def test_accounting_rejects_untyped_totals_and_future_clocks(tmp_path, field, value):
    packet = envelope("accounting")
    packet["data"]["program"][field] = value
    with pytest.raises(HTTPException) as caught:
        read_compatibility_path(
            "/api/v1/servers/rsibot-v5/fleet/accounting",
            observe(tmp_path),
            paper_read=packet,
        )
    assert caught.value.status_code == 502


def test_accounting_keeps_native_receipt_provenance_and_decimal_totals(tmp_path):
    packet = envelope("accounting")
    total = packet["data"]["program"]
    total.update(
        fees_paid={"USDC": "0.1408"},
        fee_quote_valuation_basis="exact_native_fill_event_quote_equivalent; base_fees_costed_in_net_inventory_once",
        count_basis="distinct_native_filled_buy_and_sell_orders_not_actions",
        unavailable_reasons={},
    )
    result = read_compatibility_path(
        "/api/v1/servers/rsibot-v5/fleet/accounting",
        observe(tmp_path),
        paper_read=packet,
    )
    assert result["data"]["program"] == total


@pytest.mark.parametrize(
    "changes",
    [
        {"bot_id": "another_paper"},
        {"execution_mode": "live"},
        {"simulated": False},
        {"snapshot_id": None},
        {"data": {"amount": float("nan")}},
        {"generated_at_ms": True},
        {"state": "success"},
    ],
)
def test_corruption_is_an_error_not_a_normal_degraded_state(tmp_path, changes):
    with pytest.raises(HTTPException) as caught:
        read_compatibility_path(
            next(iter(ROUTES)), observe(tmp_path), paper_read=envelope(**changes)
        )
    assert caught.value.status_code == 502


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/servers/mac/fleet/holdings",
        "https://example.test/api/v1/servers/rsibot-v5/fleet/fills",
        f"/api/v1/servers/rsibot-v5/bots/wrong_paper/native/status",
        "/api/v1/servers/rsibot-v5/fleet/fills?limit=10001",
        "/api/v1/servers/rsibot-v5/fleet/fills?host=mac",
        "/api/v1/servers/rsibot-v5/fleet/fills?limit=1&limit=2",
        f"/api/v1/servers/rsibot-v5/bots/{BOT}/start",
    ],
)
def test_scope_and_bounded_queries_stay_closed(tmp_path, path):
    with pytest.raises(HTTPException):
        read_compatibility_path(path, observe(tmp_path), paper_read=envelope())


def test_old_and_incomplete_observations_are_not_current(tmp_path):
    paper = observe(tmp_path)
    path = next(iter(ROUTES))
    assert (
        read_compatibility_path(
            path, paper, paper_read=envelope(generated_at_ms=int((NOW - 60) * 1000))
        )["state"]
        == "stale"
    )
    result = read_compatibility_path(
        path,
        paper,
        paper_read=envelope(state="degraded", reason="BNB book stale", data=None),
    )
    assert result["state"] == "degraded" and result["reason"] == "BNB book stale"


@pytest.mark.parametrize(
    "pair", ["BNB-USDC", "BTC-USDC", "ETH-USDC", "SOL-USDC", "XRP-USDC"]
)
def test_canonical_charts_have_a_typed_collecting_boundary_not_a_fake_series(
    tmp_path, pair
):
    result = read_compatibility_path(
        f"/api/v1/trading-visuals/chart-series?bot={BOT}&pair={pair}&interval=1m&limit=500",
        observe(tmp_path),
    )
    assert result["state"] == "collecting" and result["data"] is None
    assert result["source"]["owner"] == "candle-store"


def test_authenticated_app_uses_the_fixed_c3_route(tmp_path):
    from test_v5_paper_binding import client_for

    class Source:
        calls = []

        async def observation(self, path):
            self.calls.append(path)
            return envelope("positions")

    source = Source()
    with client_for(tmp_path, source) as client:
        response = client.get(
            "/api/v5/dashboard/read",
            params={
                "path": "/api/v1/servers/rsibot-v5/fleet/holdings?snapshot_id=boot-a:7"
            },
        )
        assert response.status_code == 200
        assert response.json()["snapshot_id"] == "boot-a:7"
        assert source.calls == ["/v1/paper/positions?snapshot_id=boot-a%3A7"]
        client.cookies.clear()
        assert (
            client.get(
                "/api/v5/dashboard/read", params={"path": next(iter(ROUTES))}
            ).status_code
            == 401
        )
        assert len(source.calls) == 1


def test_real_upstream_errors_remain_errors_not_empty_success(tmp_path):
    from test_v5_paper_binding import client_for
    from condor.v5.upstream import UpstreamError

    class FailedSource:
        async def observation(self, _path):
            raise UpstreamError("upstream_invalid_response", http_status=502)

    with client_for(tmp_path, FailedSource()) as client:
        response = client.get(
            "/api/v5/dashboard/read", params={"path": next(iter(ROUTES))}
        )
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "upstream_invalid_response"


def test_c1_fee_currency_and_mark_timestamp_are_metadata_not_money(tmp_path):
    data = envelope("wallet")["data"]
    data.update(
        {
            "assets": [
                {
                    "asset": "BNB",
                    "total": "0.6",
                    "available": "0",
                    "reserved": "0.6",
                    "mark_quote": "101",
                    "marked_value_quote": "60.6",
                    "fee_currency": "USDC",
                    "mark_at_ms": int(NOW * 1000),
                    "remaining_basis_quote": "60.06",
                }
            ]
        }
    )
    value = envelope("wallet", data=data)
    path = "/api/v1/servers/rsibot-v5/fleet/summary"
    result = read_compatibility_path(path, observe(tmp_path), paper_read=value)
    assert result["data"]["assets"][0]["remaining_basis_quote"] == "60.06"


def test_mixed_snapshot_cannot_be_used_for_related_totals(tmp_path):
    with pytest.raises(HTTPException) as caught:
        read_compatibility_path(
            "/api/v1/servers/rsibot-v5/fleet/summary?snapshot_id=boot-a:8",
            observe(tmp_path),
            paper_read=envelope("wallet"),
        )
    assert caught.value.status_code == 502
    assert caught.value.detail["code"] == "paper_read_snapshot_mismatch"


def test_partial_valuation_is_separate_from_current_process_heartbeat(tmp_path):
    paper = observe(tmp_path)
    result = read_compatibility_path(
        "/api/v1/servers/rsibot-v5/fleet/summary",
        paper,
        paper_read=envelope("wallet", completeness="partial"),
    )
    assert result["state"] == "degraded"
    assert paper.state == "FRESH"
    assert result["data"]["amount"] == "51.089087718"


def test_unconnected_export_is_explicit_and_extra_metadata_is_not_projected(tmp_path):
    result = read_compatibility_path(
        next(iter(ROUTES)),
        observe(tmp_path),
        paper_read=envelope(
            state="degraded",
            reason="Paper observation export not connected",
            data=None,
            bot_id=None,
            snapshot_id=None,
            generated_at_ms=None,
            extra_metadata="not part of the contract",
            source={"owner": "hummingbot", "private_metadata": "not projected"},
        ),
    )
    assert result["state"] == "degraded" and result["data"] is None
    assert "extra_metadata" not in result
    assert result["source"] == {"owner": "hummingbot"}
