from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from condor.v5.app import create_app
from test_v5_workspace_auth import ORIGIN, FakeUpstream, login, settings


@pytest.mark.parametrize("enabled", [None, "false", 0, True, False])
def test_task_enabled_projection_preserves_unknown_and_explicit_states(tmp_path, enabled):
    api = FakeUpstream()
    api.task_rows[0]["enabled"] = enabled
    app = create_app(
        settings=settings(tmp_path), upstream=api, static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        login(client)
        workspace = client.get("/api/v5/workspace").json()
        profile = workspace["advisor"]["task_profiles"][0]
        if isinstance(enabled, bool):
            assert profile["enabled"] is enabled
        else:
            assert "enabled" not in profile
        assert workspace["agents"][0]["status"] == (
            "ready" if enabled is True else "blocked"
        )


def test_missing_task_enabled_is_not_projected_as_disabled(tmp_path):
    api = FakeUpstream()
    del api.task_rows[0]["enabled"]
    app = create_app(
        settings=settings(tmp_path), upstream=api, static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        login(client)
        workspace = client.get("/api/v5/workspace").json()
        assert "enabled" not in workspace["advisor"]["task_profiles"][0]
        assert workspace["agents"][0]["status"] == "blocked"
        detail = client.get("/api/v5/agents/market_analyst").json()
        assert detail["status"] == "blocked"
        report = client.post(
            "/api/v5/agents/market_analyst/report", headers={"Origin": ORIGIN}
        ).json()
        assert report["status"] == "BLOCKED"
        assert api.report_calls == []


def test_existing_owner_expiry_is_published_but_no_cadence_is_fabricated(tmp_path):
    app = create_app(
        settings=settings(tmp_path), upstream=FakeUpstream(), static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        login(client)
        advisor = client.get("/api/v5/workspace").json()["advisor"]
        report = advisor["latest_by_task"]["market_context"]["record"]["result"]
        assert report["task_id"] == "market_context"
        assert report["received_at_ms"] == 101
        assert report["expires_at_ms"] == 200
        assert advisor["scheduler"] == {
            "enabled": True,
            "last_status": "COMPLETED",
            "last_attempt_ms": 123456,
            "task_id": "market_context",
        }


@pytest.mark.parametrize(
    ("enabled", "expected"),
    [
        ("absent", "task_enablement_not_published"),
        (None, "task_enablement_invalid"),
        ("false", "task_enablement_invalid"),
        (0, "task_enablement_invalid"),
        ({}, "task_enablement_invalid"),
        ([], "task_enablement_invalid"),
        (False, "task_disabled"),
    ],
)
def test_task_readiness_distinguishes_unknown_invalid_and_disabled(
    tmp_path, enabled, expected
):
    api = FakeUpstream()
    if enabled == "absent":
        del api.task_rows[0]["enabled"]
    else:
        api.task_rows[0]["enabled"] = enabled
    api.task_rows[0]["reason"] = "task_disabled"
    app = create_app(
        settings=settings(tmp_path), upstream=api, static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        login(client)
        workspace = client.get("/api/v5/workspace").json()
        assert workspace["agents"][0]["status"] == "blocked"
        assert workspace["agents"][0]["blockers"] == [expected]
        detail = client.get("/api/v5/agents/market_analyst").json()
        assert detail["status"] == "blocked"
        assert detail["blockers"] == [expected]
        report = client.post(
            "/api/v5/agents/market_analyst/report", headers={"Origin": ORIGIN}
        ).json()
        assert report["status"] == "BLOCKED"
        assert report["ticks"][0]["error"] == expected
        loop = client.post(
            "/api/v5/agents/market_analyst/loops/start",
            headers={"Origin": ORIGIN},
            json={
                "loop_id": "market_analyst_monitor",
                "frequency_sec": 900,
                "max_ticks": 1,
            },
        )
        assert loop.status_code == 409
        assert loop.json()["detail"]["code"] == expected
        assert api.report_calls == []
