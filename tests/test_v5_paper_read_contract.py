import pytest
from fastapi import HTTPException

from condor.v5.dashboard import read_compatibility_path
from condor.v5.paper import PaperObservation

BOT = "meridian_v5_paper"
NOW = 1_800_000_000.0


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
        "data": {"amount": "51.089087718", "unit": "USDC"},
    }
    value.update(changes)
    return value


@pytest.mark.parametrize("path,section", ROUTES.items())
def test_browser_inventory_routes_bind_only_the_paper_owner(tmp_path, path, section):
    paper = observe(tmp_path)
    result = read_compatibility_path(path, paper, paper_read=envelope(section))
    assert result["state"] == "available"
    assert result["snapshot_id"] == "boot-a:7"
    assert result["data"]["amount"] == "51.089087718"


def test_missing_section_is_degraded_not_a_fabricated_empty_wallet(tmp_path):
    result = read_compatibility_path(
        next(iter(ROUTES)), observe(tmp_path), resolve_paper_reads=True
    )
    assert result["state"] == "degraded"
    assert result["data"] is None


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
    value = envelope(
        "wallet",
        data={
            "assets": [
                {
                    "asset": "BNB",
                    "total": "0.6",
                    "fee_currency": "USDC",
                    "mark_at_ms": int(NOW * 1000),
                    "remaining_basis_quote": "60.06",
                }
            ]
        },
    )
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
