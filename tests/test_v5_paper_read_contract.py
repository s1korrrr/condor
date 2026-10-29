import pytest
from fastapi import HTTPException

from condor.v5.dashboard import read_compatibility_path
from condor.v5.paper import PaperObservation

BOT = "meridian_v5_paper"
NOW = 1_800_000_000.0


def observe(_path):
    return PaperObservation("FRESH", "PAPER_STATUS_FRESH", BOT, NOW, {"generated_at": NOW})


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
    result = read_compatibility_path(next(iter(ROUTES)), observe(tmp_path))
    assert result["state"] == "degraded"
    assert result["data"] is None


@pytest.mark.parametrize("changes", [
    {"bot_id": "another_paper"}, {"execution_mode": "live"},
    {"simulated": False}, {"snapshot_id": None}, {"data": {"amount": float("nan")}},
    {"generated_at_ms": True}, {"state": "success"},
])
def test_corruption_is_an_error_not_a_normal_degraded_state(tmp_path, changes):
    with pytest.raises(HTTPException) as caught:
        read_compatibility_path(next(iter(ROUTES)), observe(tmp_path), paper_read=envelope(**changes))
    assert caught.value.status_code == 502


@pytest.mark.parametrize("path", [
    "/api/v1/servers/mac/fleet/holdings", "https://example.test/api/v1/servers/rsibot-v5/fleet/fills",
    f"/api/v1/servers/rsibot-v5/bots/wrong_paper/native/status",
    "/api/v1/servers/rsibot-v5/fleet/fills?limit=10001",
    "/api/v1/servers/rsibot-v5/fleet/fills?host=mac",
    "/api/v1/servers/rsibot-v5/fleet/fills?limit=1&limit=2",
    f"/api/v1/servers/rsibot-v5/bots/{BOT}/start",
])
def test_scope_and_bounded_queries_stay_closed(tmp_path, path):
    with pytest.raises(HTTPException):
        read_compatibility_path(path, observe(tmp_path), paper_read=envelope())


def test_old_and_incomplete_observations_are_not_current(tmp_path):
    paper = observe(tmp_path)
    path = next(iter(ROUTES))
    assert read_compatibility_path(path, paper, paper_read=envelope(generated_at_ms=int((NOW - 60) * 1000)))["state"] == "stale"
    result = read_compatibility_path(path, paper, paper_read=envelope(state="degraded", reason="BNB book stale", data=None))
    assert result["state"] == "degraded" and result["reason"] == "BNB book stale"
