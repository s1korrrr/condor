from __future__ import annotations

from fastapi.testclient import TestClient

from condor.v5.app import create_app
from condor.v5.upstream import UpstreamError, V5Upstream
from test_v5_workspace_auth import FakeUpstream, login, settings


class PrivateAdviceUpstream(FakeUpstream):
    async def private_report(self, task_id):
        report = await super().latest_task_report(task_id)
        report["record"]["input"]["private"] = "PRIVATE_INPUT"
        report["record"]["result"]["raw"] = "PRIVATE_MODEL_TEXT"
        return report

    async def observation(self, path):
        if path == "/v1/tasks":
            self.observation_calls.append(path)
            return await super().task_profiles()
        if path == "/v1/advice/history":
            self.observation_calls.append(path)
            raise UpstreamError("upstream_response_too_large")
        if path == "/v1/advice/latest":
            self.observation_calls.append(path)
            return await self.private_report("market_context")
        if path.startswith("/v1/advice/latest?task_id="):
            self.observation_calls.append(path)
            return await self.private_report(path.split("=", 1)[1])
        return await super().observation(path)

    async def task_profiles(self):
        return await V5Upstream.task_profiles(self)

    async def latest_task_report(self, task_id):
        return await V5Upstream.latest_task_report(self, task_id)


def read_workspace(tmp_path, api):
    app = create_app(
        settings=settings(tmp_path), upstream=api, static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        login(client)
        response = client.get("/api/v5/workspace")
        assert response.status_code == 200
        return response.json()


def test_workspace_never_exposes_owner_input_or_raw_model_reply(tmp_path):
    workspace = read_workspace(tmp_path, PrivateAdviceUpstream())

    def assert_private_fields_absent(value):
        if isinstance(value, dict):
            assert "input" not in value
            assert "raw" not in value
            for nested in value.values():
                assert_private_fields_absent(nested)
        elif isinstance(value, list):
            for nested in value:
                assert_private_fields_absent(nested)
        else:
            assert value not in ("PRIVATE_INPUT", "PRIVATE_MODEL_TEXT")

    assert_private_fields_absent(workspace)
    assert "latest" not in workspace["advisor"]
    for task_id in ("market_context", "source_quality"):
        report = workspace["advisor"]["latest_by_task"][task_id]
        assert report["record"]["snapshot_id"] == "snap-1"
        assert report["record"]["result"]["task_id"] == task_id
        assert report["record"]["result"]["advice"]["summary"] == "Task-bound summary"


def test_workspace_reads_only_status_and_task_bound_advice_paths(tmp_path):
    api = PrivateAdviceUpstream()
    read_workspace(tmp_path, api)

    assert sorted(api.observation_calls) == sorted(
        [
            "/v1/context",
            "/v1/source/status",
            "/v1/identity",
            "/v1/advice/status",
            "/v1/tasks",
            "/v1/advice/latest?task_id=market_context",
            "/v1/advice/latest?task_id=source_quality",
        ]
    )


def test_workspace_omits_unknown_history_total_instead_of_claiming_zero(tmp_path):
    workspace = read_workspace(tmp_path, PrivateAdviceUpstream())

    assert "history_count" not in workspace["advisor"]
    assert workspace["source_error"] is None
    assert workspace["agents"][0]["status"] == "ready"
