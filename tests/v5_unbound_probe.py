"""Observable no-paper contract of the V5 app, for comparison with the base release.

``probe()`` drives the app through its HTTP routes with a fixed fake upstream and
no paper status file, and returns only deterministic fields. The fixture
``fixtures/v5_unbound_base_8284ffe7.json`` is this probe's output on the
unbound release (condor 8284ffe7), captured from an archived copy of that commit:

    git archive 8284ffe7 | tar -x -C <empty dir>
    cp tests/v5_unbound_probe.py <dir>/tests/
    cd <dir> && PYTHONPATH=.:tests python -B tests/v5_unbound_probe.py > fixture.json

It must keep importing only names that exist in that release.
"""

from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from test_v5_dashboard_bridge import ORIGIN, SERVER, TOKEN, make_settings

from condor.v5.app import create_app

AGENT_IDS = ("market_analyst", "source_auditor", "decision_reviewer")
COMPATIBILITY_PATHS = (
    f"/api/v1/servers/{SERVER}/status",
    f"/api/v1/servers/{SERVER}/bots",
    "/api/v1/trading-visuals/sources",
    "/api/v1/trading-visuals/bootstrap?bot=meridian_v5_paper",
    "/api/v1/operations",
    "/api/v1/research",
    "/api/v1/market-picture",
    "/api/v1/servers",
)


class FakeUpstream:
    """Reports a decision_review task and scheduler as an upgraded advisor would."""

    def __init__(self):
        self.calls = []

    async def observation(self, path):
        self.calls.append(["GET", path])
        if path == "/v1/context":
            return {"snapshot_id": "source-1", "available_at_ms": 1}
        if path == "/v1/advice/history":
            return {"records": []}
        return {}

    async def task_profiles(self):
        self.calls.append(["GET", "/v1/tasks"])
        return {
            "tasks": [
                {"task_id": task, "model": "fixture", "enabled": True}
                for task in ("market_context", "source_quality", "decision_review")
            ],
            "credential_status": "READY",
            "scheduler": {"last_status": "ACCEPTED", "task_id": "decision_review"},
        }

    async def latest_task_report(self, task_id):
        self.calls.append(["GET", f"latest:{task_id}"])
        return {"status": "UNAVAILABLE", "effect": "NONE", "record": None}

    async def request_report(self, task_id, snapshot_id):
        self.calls.append(["POST", task_id, snapshot_id])
        return {"status": "ACCEPTED", "effect": "NONE", "advice": {"summary": "x"}}


def _response(response) -> dict:
    try:
        body = response.json()
    except ValueError:
        body = response.text
    return {"status_code": response.status_code, "body": body}


def _session(response) -> dict:
    body = response.json()
    return {
        "status_code": response.status_code,
        "status": body.get("status"),
        "summary": body.get("summary"),
        "ticks": [
            {key: tick.get(key) for key in ("status", "summary", "error")}
            for tick in body.get("ticks", [])
        ],
    }


def probe() -> dict:
    with TemporaryDirectory() as directory:
        root = Path(directory)
        settings = make_settings(root)
        assert getattr(settings, "paper_status_file", None) is None
        upstream = FakeUpstream()
        app = create_app(
            settings=settings,
            upstream=upstream,
            static_dir=root / "dist",
            clock=lambda: 1_800_000_000_000,
        )
        headers = {"Origin": ORIGIN}
        result: dict = {}
        with TestClient(app) as client:
            login = client.post(
                "/api/v5/auth/login", json={"token": TOKEN}, headers=headers
            )
            assert login.status_code == 200
            workspace = client.get("/api/v5/workspace").json()
            result["workspace_agents"] = workspace["agents"]
            result["workspace_task_profiles"] = workspace.get("task_profiles")
            settings_view = client.get("/api/v5/settings").json()
            result["settings"] = {
                key: settings_view.get(key)
                for key in ("task_profiles", "scheduler", "effective_policy")
            }
            result["profile"] = _response(client.get("/api/v5/dashboard/profile"))
            result["compatibility"] = {
                path: _response(
                    client.get("/api/v5/dashboard/read", params={"path": path})
                )
                for path in COMPATIBILITY_PATHS
            }
            for agent_id in AGENT_IDS:
                result[f"agent:{agent_id}"] = _response(
                    client.get(f"/api/v5/agents/{agent_id}")
                )
                notes = client.put(
                    f"/api/v5/agents/{agent_id}/notes",
                    json={"text": "fixture note"},
                    headers=headers,
                )
                result[f"notes:{agent_id}"] = _response(notes)
            reviewer = "/api/v5/agents/decision_reviewer"
            result["inspect:decision_reviewer"] = _session(
                client.post(f"{reviewer}/inspect", headers=headers)
            )
            result["report:decision_reviewer"] = _session(
                client.post(f"{reviewer}/report", headers=headers)
            )
            result["loop:decision_reviewer"] = _response(
                client.post(
                    f"{reviewer}/loops/start",
                    json={
                        "loop_id": "decision_reviewer_monitor",
                        "frequency_sec": 1800,
                        "max_ticks": 2,
                    },
                    headers=headers,
                )
            )
            result["agent_page:decision_reviewer"] = client.get(
                "/agents/decision_reviewer"
            ).status_code
        result["upstream_posts"] = [
            call for call in upstream.calls if call[0] == "POST"
        ]
        result["upstream_task_reads"] = sorted(
            {call[1] for call in upstream.calls if call[1].startswith("latest:")}
        )
        return result


if __name__ == "__main__":
    print(json.dumps(probe(), indent=1, sort_keys=True))
