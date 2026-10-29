import pytest
from fastapi import HTTPException

from condor.v5.dashboard import read_compatibility_path
from condor.v5.paper import PaperObservation

BOT = "meridian_v5_paper"
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
        ("capabilities", []),
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
        "reason": None,
        "bot_id": BOT,
        "execution_mode": "paper",
        "simulated": True,
        "snapshot_id": "boot-a:7",
        "boot_id": "boot-a",
        "sequence": 7,
        "generated_at_ms": int(NOW * 1000),
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
