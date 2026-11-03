"""Cross-venue, heatmap and store-facts reads: owner golden payloads pass, any drift is unavailable.

Golden payloads in ``fixtures/candle_store_views`` are real owner output: hummingbot
``services/candle-store/candle_store_dashboard`` at 9ccf80087 (``_v5_cross``, ``_v5_heatmap``,
``Dashboard.store_v5``) over its deterministic test fixture store, evaluated at 2026-10-24T06:00:30Z.
"""

import copy
import json
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_v5_dashboard_bridge import ORIGIN, TOKEN, NoNetworkUpstream, make_settings

from condor.v5.app import create_app
from condor.v5.candles import OwnerUnavailable, validate_payload, validate_query

FIXTURES = Path(__file__).parent / "fixtures" / "candle_store_views"
CROSS_SPOT = {"asset": "BTC", "segment": "spot", "range": "24h", "res": "auto"}
CROSS_PERP = {"asset": "BTC", "segment": "perpetual", "range": "1h", "res": "auto"}
HEAT_SPOT = {"segment": "spot"}


def golden(name):
    return json.loads((FIXTURES / f"{name}.json").read_text())


def test_queries_are_exact_and_default_safely():
    assert validate_query("cross", [("asset", "BTC"), ("segment", "spot")]) == {
        "asset": "BTC",
        "segment": "spot",
        "range": "24h",
        "res": "auto",
    }
    assert validate_query("heatmap", [("segment", "perpetual")]) == {
        "segment": "perpetual"
    }
    assert validate_query("store", []) == {}
    for view, items in (
        ("cross", [("asset", "BTC")]),
        ("cross", [("asset", "../x"), ("segment", "spot")]),
        ("cross", [("asset", "BTC"), ("segment", "spot"), ("res", "1m")]),
        ("cross", [("asset", "BTC"), ("segment", "spot"), ("range", "30d")]),
        ("cross", [("asset", "BTC"), ("asset", "ETH"), ("segment", "spot")]),
        ("heatmap", []),
        ("heatmap", [("segment", "margin")]),
        ("heatmap", [("segment", "spot"), ("hours", "999")]),
        ("store", [("full", "1")]),
    ):
        with pytest.raises(ValueError):
            validate_query(view, items)
    with pytest.raises(KeyError):
        validate_query("lanes", [])


def test_golden_owner_payloads_project_exactly():
    cross = validate_payload("cross", golden("cross_spot_24h"), CROSS_SPOT)
    assert {s["lane"] for s in cross["series"]} == {"binance__spot", "okx__spot"}
    assert cross["res"] == "5m" and cross["minutes"] == 1440
    assert [row["quote"] for row in cross["table"]] == [
        s["pair"].split("-")[1] for s in cross["series"]
    ]
    perp = validate_payload("cross", golden("cross_perpetual_1h"), CROSS_PERP)
    assert all(s["lane"].endswith("__perpetual") for s in perp["series"])
    heat = validate_payload("heatmap", golden("heatmap_spot"), HEAT_SPOT)
    assert len(heat["hours"]) == 168 and {r["segment"] for r in heat["rows"]} == {
        "spot"
    }
    store = validate_payload("store", golden("store"), {})
    assert store["read_method"].startswith("file listing")
    assert sum(lane["bytes_total"] for lane in store["lanes"]) <= store["bytes_total"]
    assert "pid" not in json.dumps(store) and "/tmp" not in json.dumps(store)


def _mutated(name, edit):
    payload = copy.deepcopy(golden(name))
    edit(payload)
    return payload


@pytest.mark.parametrize(
    "edit",
    [
        lambda p: p.update(asset="ETH"),
        lambda p: p.update(segment="perpetual"),
        lambda p: p.update(range="7d"),
        lambda p: p.update(res="1m"),
        lambda p: p.update(end=p["end"] - 60),
        lambda p: p.update(minutes=1439),
        lambda p: p["series"].append(copy.deepcopy(p["series"][0])),
        lambda p: p["series"][0].update(lane="binance__perpetual"),
        lambda p: p["series"][0].update(venue="okx"),
        lambda p: p["series"][0]["close"].append([p["end"] + 300, 1.0]),
        lambda p: p["series"][0]["close"].__setitem__(
            0, [p["series"][0]["close"][0][0], 0]
        ),
        lambda p: p["series"][0]["close"].reverse(),
        lambda p: p["series"][0]["deviation_bps"].__setitem__(
            0, [p["series"][0]["deviation_bps"][0][0] + 1, 0.1]
        ),
        lambda p: p["table"][0].update(pair="ETH-USDT"),
        lambda p: p["table"][0].update(n=p["table"][0]["minutes_with_close"] + 1),
        lambda p: p["table"][0].update(mean_abs_bps=-1.0),
        lambda p: p["table"][0].update(quote="USD"),
        lambda p: p["table"][0].update(max_at=p["end"] + 60),
        lambda p: p["table"].pop(),
    ],
)
def test_cross_drift_is_unavailable(edit):
    with pytest.raises(OwnerUnavailable):
        validate_payload("cross", _mutated("cross_spot_24h", edit), CROSS_SPOT)


@pytest.mark.parametrize(
    "edit",
    [
        lambda p: p.update(segment="perpetual"),
        lambda p: p.update(fields=["final", "missing"]),
        lambda p: p["hours"].pop(),
        lambda p: p.update(last_closed=p["last_closed"] - 60),
        lambda p: p["rows"][0].update(segment="perpetual"),
        lambda p: p["rows"][0].update(lane="okx__perpetual", venue="okx"),
        lambda p: p["rows"].append(copy.deepcopy(p["rows"][0])),
        lambda p: p["rows"][0]["cells"].pop(),
        lambda p: p["rows"][0]["cells"].__setitem__(-1, [60, 1, 0, 0, 0]),
        lambda p: p["rows"][0]["cells"].__setitem__(-1, [1, 2, 3]),
        lambda p: p["rows"][0]["cells"].__setitem__(-1, [-1, 0, 0, 0, 0]),
        lambda p: p["rows"][0].update(asset="BTC/USD"),
    ],
)
def test_heatmap_drift_is_unavailable(edit):
    with pytest.raises(OwnerUnavailable):
        validate_payload("heatmap", _mutated("heatmap_spot", edit), HEAT_SPOT)


@pytest.mark.parametrize(
    "edit",
    [
        lambda p: p["status"].update(
            fatal_error="OSError at /home/rsi/store/lanes/x.sqlite"
        ),
        lambda p: p["status"].update(
            error="cannot read '/var/lib/candles/status.json'"
        ),
        lambda p: p["config"].update(error="unreadable: /home/rsi/lanes.json"),
        lambda p: p["status"]["process"].update(pid=1),
        lambda p: p["status"]["process"].update(rss_mib=float("inf")),
        lambda p: p["status"]["process"]["loop_lag_s"].pop("p99"),
        lambda p: p["status"].update(present="yes"),
        lambda p: p["lanes"][0].update(bytes_total=p["lanes"][0]["bytes_total"] + 1),
        lambda p: p["lanes"][0].update(days_held=p["lanes"][0]["days_held"] + 1),
        lambda p: p["lanes"][0].update(days=list(reversed(p["lanes"][0]["days"]))),
        lambda p: p["lanes"][0].update(wal_bytes=p["lanes"][0]["bytes"]["lanes"] + 1),
        lambda p: p["lanes"][0].update(segment="perpetual"),
        lambda p: p["lanes"].append(copy.deepcopy(p["lanes"][0])),
        lambda p: p.update(bytes_total=0),
        lambda p: p["config"].update(source="/etc"),
        lambda p: p["config"]["assets"].append("../x"),
        lambda p: p["status"].update(fatal_error="cannot write /data"),
        lambda p: p["status"].update(fatal_error="cannot write C:\\Users\\rsi\\store"),
        lambda p: p["status"].update(fatal_error="worker pid=4242 exited"),
        lambda p: p["status"].update(error="process 4242 died"),
        lambda p: p["status"].update(started_at=9007199254740991),
        lambda p: p["status"].update(uptime_s=9007199254740991),
        lambda p: p["status"].update(age_s=-60),
        lambda p: p["retention"].update(window_s=9007199254740991),
    ],
)
def test_store_drift_or_path_disclosure_is_unavailable(edit):
    with pytest.raises(OwnerUnavailable):
        validate_payload("store", _mutated("store", edit), {})


WITHHELD = "(details withheld; read them on the owner host)"


@pytest.mark.parametrize(
    "message",
    [
        None,
        "status.json not found",
        "no lanes config given and status.json names none",
        f"status.json is not valid JSON {WITHHELD}",
        f"lanes config unreadable: FileNotFoundError {WITHHELD}",
        f"OSError {WITHHELD}",
        f"Message present {WITHHELD}",
    ],
)
def test_store_accepts_only_the_owner_message_kinds(message):
    payload = golden("store")
    payload["status"]["fatal_error"] = message
    payload["status"]["error"] = message
    payload["config"]["error"] = message
    safe = validate_payload("store", payload, {})
    assert safe["status"]["fatal_error"] == safe["config"]["error"] == message


@pytest.mark.parametrize(
    "message",
    [
        "worker PID: 4242 exited",
        "worker {'pid': 4242}",
        "process ID: 4242 died",
        "[Errno 13] Permission denied: '<path> Store/status.json.tmp.4242'",
        "OSError: cannot write <path>",
        f"OSError {WITHHELD} /home/rsi",
        f"oserror {WITHHELD}",
        "",
    ],
)
def test_store_rejects_any_other_message_text(message):
    for field in (("status", "fatal_error"), ("status", "error"), ("config", "error")):
        payload = golden("store")
        payload[field[0]][field[1]] = message
        with pytest.raises(OwnerUnavailable):
            validate_payload("store", payload, {})


@pytest.mark.parametrize(
    "edit",
    [
        lambda p: p["versions"]["found"].update(format="/home/rsi/x"),
        lambda p: p["versions"]["mismatches"].append("format: x y (dashboard reads z)"),
        lambda p: p.update(read_method="opened /home/rsi/store"),
    ],
)
def test_store_versions_and_method_are_fixed_forms(edit):
    payload = golden("store")
    edit(payload)
    with pytest.raises(OwnerUnavailable):
        validate_payload("store", payload, {})


def _heatmap_at(hour):
    """The golden heatmap moved so that the newest hour starts at ``hour`` with one closed minute."""
    payload = golden("heatmap_spot")
    payload["now"] = hour + 90
    payload["last_closed"] = hour
    payload["hours"] = [hour - 3600 * (167 - i) for i in range(168)]
    for row in payload["rows"]:
        row["cells"] = row["cells"][1:] + [[1, 0, 0, 0, 0]]
        row["first_minute"] = max(row["first_minute"], payload["hours"][0])
    return payload


def test_heatmap_cell_cannot_count_minutes_that_have_not_closed():
    hour = (golden("heatmap_spot")["last_closed"] // 3600 + 1) * 3600
    payload = _heatmap_at(hour)
    assert validate_payload("heatmap", payload, HEAT_SPOT)["hours"][-1] == hour
    payload["rows"][0]["cells"][-1] = [60, 0, 0, 0, 0]
    with pytest.raises(OwnerUnavailable):
        validate_payload("heatmap", payload, HEAT_SPOT)


def test_heatmap_cell_cannot_count_minutes_before_retention():
    payload = golden("heatmap_spot")
    row = payload["rows"][0]
    row["first_minute"] = (
        payload["hours"][0] + 46 * 60
    )  # 14 retained minutes in the oldest hour
    row["cells"][0] = [14, 0, 0, 0, 0]
    assert (
        validate_payload("heatmap", payload, HEAT_SPOT)["rows"][0]["first_minute"]
        == row["first_minute"]
    )
    row["cells"][0] = [60, 0, 0, 0, 0]
    with pytest.raises(OwnerUnavailable):
        validate_payload("heatmap", payload, HEAT_SPOT)


def test_heatmap_hours_before_retention_must_be_empty():
    payload = golden("heatmap_spot")
    row = payload["rows"][0]
    row["first_minute"] = payload["hours"][2]
    row["cells"][0] = row["cells"][1] = None
    validate_payload("heatmap", payload, HEAT_SPOT)
    row["cells"][0] = [0, 0, 0, 0, 0]
    with pytest.raises(OwnerUnavailable):
        validate_payload("heatmap", payload, HEAT_SPOT)
    for bad in (
        None,
        payload["hours"][0] - 60,
        payload["last_closed"] + 60,
        payload["hours"][0] + 1,
    ):
        payload = golden("heatmap_spot")
        payload["rows"][0]["first_minute"] = bad
        with pytest.raises(OwnerUnavailable):
            validate_payload("heatmap", payload, HEAT_SPOT)


def test_routes_are_authenticated_and_validated(tmp_path):
    settings = replace(
        make_settings(tmp_path), candle_store_socket=tmp_path / "absent.sock"
    )
    with TestClient(
        create_app(settings=settings, upstream=NoNetworkUpstream())
    ) as client:
        for path in ("cross?asset=BTC&segment=spot", "heatmap?segment=spot", "store"):
            assert client.get(f"/api/v5/candle-store/{path}").status_code == 401
        client.post(
            "/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}
        )
        for path in ("cross?asset=BTC&segment=spot", "heatmap?segment=spot", "store"):
            response = client.get(f"/api/v5/candle-store/{path}")
            assert response.status_code == 503, path
            assert response.json() == {
                "state": "UNAVAILABLE",
                "reason": "owner_unreachable",
                "data": None,
            }
        for path in (
            "cross?asset=BTC",
            "heatmap",
            "store?x=1",
            "cross?asset=BTC&segment=spot&res=1m",
        ):
            assert client.get(f"/api/v5/candle-store/{path}").status_code == 422, path
        assert client.get("/api/v5/candle-store/lanes").status_code == 404
        # `summary` is a valid read (one owner pass for overview + symbols); unreachable owner → 503, never stale.
        response = client.get("/api/v5/candle-store/summary")
        assert response.status_code == 503
        assert response.json()["reason"] == "owner_unreachable"
        assert client.get("/api/v5/candle-store/summary?full=1").status_code == 422
