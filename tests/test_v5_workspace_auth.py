from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from condor.v5.app import _safe_feed_refresh, _safe_task_latest, create_app
from condor.v5.config import ConfigurationError, Settings
from condor.v5.state import WorkspaceState

TOKEN = "d" * 48
READ_TOKEN = "r" * 48
REQUEST_TOKEN = "q" * 48
ORIGIN = "https://v5.example.test"


def test_latest_task_projection_rejects_cross_task_and_unqualified_costs():
    wrong_task = {
        "status": "CURRENT_REPORT",
        "record": {
            "input": {"task_id": "source_quality"},
            "result": {"task_id": "market_context", "actual_usd": "0.01"},
        },
    }
    projected = _safe_task_latest("market_context", wrong_task)
    assert projected["status"] == "TASK_IDENTITY_MISMATCH"
    assert projected["record"] is None

    bad_cost = {
        "status": "CURRENT_REPORT",
        "record": {
            "input": {"task_id": "market_context", "snapshot_id": "s"},
            "result": {
                "task_id": "market_context",
                "actual_usd": "-1",
                "coverage_status": "NORMAL",
                "effect": "ORDER",
            },
        },
    }
    projected = _safe_task_latest("market_context", bad_cost)
    assert "actual_usd" not in projected["record"]["result"]
    assert "coverage_status" not in projected["record"]["result"]
    assert projected["record"]["result"]["effect"] == "NONE"


def test_feed_refresh_projection_is_schema_bounded_and_rejects_bad_timestamps():
    projected = _safe_feed_refresh(
        {
            "schema_version": "v5-feed-refresh-status.v1",
            "state": "HEALTHY",
            "last_attempt_at_ms": True,
            "last_success_at_ms": 123,
            "feed_freshness": "FRESH",
            "feed_fresh_until_ms": -1,
            "private": "must-not-leak",
        }
    )
    assert projected["state"] == "HEALTHY"
    assert "last_attempt_at_ms" not in projected
    assert projected["last_success_at_ms"] == 123
    assert "feed_fresh_until_ms" not in projected
    assert "private" not in projected
    assert _safe_feed_refresh({"schema_version": "wrong"})["state"] == "UNKNOWN"


class FakeUpstream:
    def __init__(self):
        self.report_calls = []
        self.observation_calls = []
        self.task_rows = [
            {
                "task_id": "market_context",
                "model": "claude-sonnet",
                "enabled": True,
                "reason": None,
            },
            {
                "task_id": "source_quality",
                "model": "claude-sonnet",
                "enabled": False,
                "reason": "profile_not_enabled",
            },
        ]
        self.report = {
            "request_id": "req-1",
            "status": "ACCEPTED",
            "advice": {
                "assessment": "CAUTION",
                "reason_codes": ["DATA_QUALITY"],
                "evidence_refs": ["breadth_1h"],
                "summary": "Coverage is partial.",
            },
            "requested_at_ms": 100,
            "received_at_ms": 101,
            "expires_at_ms": 200,
            "effect": "NONE",
        }
        self.context = {
            "schema_version": "multi-venue-evidence.v1",
            "snapshot_id": "snapshot-1",
            "available_at_ms": 100,
        }
        self.feed_refresh = {
            "schema_version": "v5-feed-refresh-status.v1",
            "state": "HEALTHY",
            "last_attempt_at_ms": 300,
            "last_success_at_ms": 299,
            "last_success_cutoff_ms": 250,
            "observed_at_ms": 301,
            "feed_fresh_until_ms": 370,
            "feed_freshness": "FRESH",
            "refresher_status": "CURRENT",
            "provider_token": "must-not-leak",
        }
        self.fail_source = False
        self.refuse = False
        self.credential_status = "READY"

    async def observation(self, path):
        self.observation_calls.append(path)
        if self.fail_source and path == "/v1/context":
            raise RuntimeError("sensitive host token must not leak")
        if path == "/v1/context":
            return self.context
        if path == "/v1/source/status":
            return self.feed_refresh
        if path == "/v1/identity":
            return {"upstream_revision": "api-test-sha"}
        if path == "/v1/advice/status":
            return {
                "enabled": True,
                "model": "claude-sonnet",
                "calls_today": 1,
                "spent_usd": "0.01",
                "reserved_usd": "0.00",
                "effect": "NONE",
                "provider_key": "must-not-leak",
            }
        if path == "/v1/advice/history":
            return {"records": [], "effect": "NONE"}
        if path == "/v1/advice/latest":
            return {"status": "UNAVAILABLE", "effect": "NONE", "record": None}
        raise AssertionError(path)

    async def task_profiles(self):
        return {
            "tasks": self.task_rows,
            "budget": {"calls_today": 1},
            "credential_status": self.credential_status,
            "budget_policy": {
                "pilot_usd": "150.00",
                "daily_usd": "5.00",
                "authorized_ceiling_usd": "200.00",
                "remaining_pilot_usd": "149.99",
                "provider_balance_usd": "999999",
            },
            "scheduler": {
                "enabled": True,
                "last_status": "COMPLETED",
                "last_attempt_ms": 123456,
                "task_id": "market_context",
                "secret": "must-not-leak",
            },
        }

    async def latest_task_report(self, task_id):
        return {
            "status": "CURRENT_REPORT",
            "effect": "NONE",
            "record": {
                "request_id": f"req-{task_id}",
                "input": {"task_id": task_id, "snapshot_id": "snap-1"},
                "result": {
                    "task_id": task_id,
                    "status": "ACCEPTED",
                    "coverage_status": "PARTIAL_OR_UNKNOWN",
                    "model": "claude-sonnet",
                    "requested_at_ms": 100,
                    "received_at_ms": 101,
                    "expires_at_ms": 200,
                    "actual_usd": "0.004200",
                    "advice": {
                        "assessment": "CAUTION",
                        "summary": "Task-bound summary",
                    },
                    "effect": "NONE",
                    "provider_key": "must-not-leak",
                },
            },
        }

    async def request_report(self, task_id, snapshot_id):
        self.report_calls.append((task_id, snapshot_id))
        if self.refuse:
            from condor.v5.upstream import UpstreamError

            raise UpstreamError(
                "task_refused",
                http_status=409,
                body={"status": "BUDGET_REFUSED", "effect": "NONE"},
            )
        return self.report


def settings(tmp_path: Path) -> Settings:
    token = tmp_path / "dashboard.token"
    read_token = tmp_path / "observation.token"
    request_token = tmp_path / "request.token"
    token.write_text(TOKEN)
    read_token.write_text(READ_TOKEN)
    request_token.write_text(REQUEST_TOKEN)
    return Settings(
        runtime_root=tmp_path / "v5-state",
        dashboard_token_file=token,
        dashboard_origin=ORIGIN,
        observation_base_url="http://market-api:8080",
        observation_read_token_file=read_token,
        advisor_control_base_url="http://advisor-api:8081",
        advisor_request_token_file=request_token,
        cookie_secure=False,
    )


def login(client: TestClient):
    response = client.post(
        "/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}
    )
    assert response.status_code == 200
    return response


def test_login_cookie_is_v5_scoped_and_same_origin_only(tmp_path):
    api = FakeUpstream()
    app = create_app(
        settings=settings(tmp_path), upstream=api, static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        assert client.get("/api/v5/auth").json() == {"authenticated": False}
        assert client.get("/api/v5/workspace").status_code == 401
        assert (
            client.post(
                "/api/v5/auth/login",
                json={"token": TOKEN},
                headers={"Origin": "https://evil.example"},
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/api/v5/auth/login",
                json={"token": "wrong-token-" + TOKEN},
                headers={"Origin": ORIGIN},
            ).status_code
            == 401
        )
        response = login(client)
        cookie = response.headers["set-cookie"]
        assert "rsi_v5_session=" in cookie
        assert "HttpOnly" in cookie and "SameSite=strict" in cookie
        assert "Path=/" in cookie
        assert client.get("/api/v5/auth").json() == {"authenticated": True}
        assert (
            client.post(
                "/api/v5/auth/logout", headers={"Origin": "https://evil.example"}
            ).status_code
            == 403
        )
        assert client.post(
            "/api/v5/auth/logout", headers={"Origin": ORIGIN}
        ).json() == {"authenticated": False}


def test_workspace_is_scoped_to_v5_roots_and_sanitizes_upstream(tmp_path):
    api = FakeUpstream()
    config = settings(tmp_path)
    app = create_app(settings=config, upstream=api, static_dir=tmp_path / "dist")
    ordinary_root = tmp_path / ".condor"
    ordinary_root.mkdir()
    before = list(ordinary_root.iterdir())
    with TestClient(app) as client:
        login(client)
        workspace = client.get("/api/v5/workspace").json()
        assert workspace["schema_version"] == "v5-workspace.v1"
        assert workspace["identity"] == {
            "name": "RSI V5",
            "host": "razer",
            "mode": "reports-only",
            "execution_enabled": False,
            "baseline_binding": None,
            "upstream_revision": "api-test-sha",
        }
        assert workspace["context"] == api.context
        assert workspace["source_refresh"]["last_success_cutoff_ms"] == 250
        assert "provider_token" not in workspace["source_refresh"]
        assert workspace["source_error"] is None
        assert workspace["advisor"]["task_profiles"][0]["task_id"] == "market_context"
        assert workspace["advisor"]["task_profiles"][0]["credential_status"] == "READY"
        assert workspace["advisor"]["task_profiles"][1]["credential_status"] == "READY"
        assert (
            workspace["advisor"]["budget_policy"]["authorized_ceiling_usd"] == "200.00"
        )
        assert "provider_balance_usd" not in workspace["advisor"]["budget_policy"]
        assert workspace["advisor"]["scheduler"]["task_id"] == "market_context"
        assert "secret" not in workspace["advisor"]["scheduler"]
        task_report = workspace["advisor"]["latest_by_task"]["market_context"]
        assert task_report["record"]["result"]["task_id"] == "market_context"
        assert task_report["record"]["result"]["actual_usd"] == "0.004200"
        assert (
            task_report["record"]["result"]["coverage_status"] == "PARTIAL_OR_UNKNOWN"
        )
        assert "provider_key" not in task_report["record"]["result"]
        assert "provider_key" not in workspace["advisor"]
        api.credential_status = "API_KEY_REQUIRED"
        key_required = client.get("/api/v5/workspace").json()
        assert (
            key_required["advisor"]["task_profiles"][0]["credential_status"]
            == "API_KEY_REQUIRED"
        )
        assert (
            key_required["advisor"]["task_profiles"][1]["credential_status"]
            == "API_KEY_REQUIRED"
        )
        assert [agent["id"] for agent in workspace["agents"]] == [
            "market_analyst",
            "source_auditor",
            "decision_reviewer",
        ]
        reviewer = workspace["agents"][-1]
        assert reviewer["status"] == "blocked"
        assert reviewer["tools"] == []
        assert reviewer["tool_policy_mode"] == "explicit_v5_allowlist"
        assert reviewer["empty_allowlist_means"] == "deny_all"
        assert list(ordinary_root.iterdir()) == before
        assert (config.runtime_root / "workspace.sqlite3").exists()


def test_stock_catalog_and_v5_frontend_use_repository_level_roots(tmp_path):
    config = settings(tmp_path)
    from condor.v5.agents import AgentCatalog

    catalog = AgentCatalog(config)
    assert catalog.stock_root == Path(__file__).resolve().parents[1] / "agents_v5"
    assert catalog.get("market_analyst").source == "stock"
    static_root = tmp_path / "frontend-v5"
    static_root.mkdir()
    (static_root / "v5.html").write_text("<main>V5 isolated app</main>")
    config = Settings(**{**config.__dict__, "frontend_dist": static_root})
    app = create_app(settings=config, upstream=FakeUpstream())
    with TestClient(app) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert response.text == "<main>V5 isolated app</main>"
        for path in ("/", "/settings", "/agents", "/agents/market_analyst"):
            policy = client.get(path).headers.get("Content-Security-Policy", "")
            assert (
                "script-src 'self'" in policy and "frame-ancestors 'none'" in policy
            ), path


def test_inspect_is_deterministic_and_never_calls_advisor(tmp_path):
    api = FakeUpstream()
    app = create_app(
        settings=settings(tmp_path), upstream=api, static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        login(client)
        result = client.post(
            "/api/v5/agents/market_analyst/inspect", headers={"Origin": ORIGIN}
        ).json()
        assert result["status"] == "COMPLETED"
        assert result["effect"] == "NONE"
        assert result["ticks"][0]["evidence_refs"] == ["snapshot-1"]
        assert api.report_calls == []
        blocked = client.post(
            "/api/v5/agents/decision_reviewer/inspect", headers={"Origin": ORIGIN}
        ).json()
        assert blocked["status"] == "BLOCKED"
        assert api.report_calls == []


def test_report_uses_fixed_task_and_snapshot_and_records_envelope(tmp_path):
    api = FakeUpstream()
    app = create_app(
        settings=settings(tmp_path), upstream=api, static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        login(client)
        result = client.post(
            "/api/v5/agents/market_analyst/report", headers={"Origin": ORIGIN}
        ).json()
        assert result["status"] == "COMPLETED"
        assert result["effect"] == "NONE"
        assert result["ticks"][0]["report"]["request_id"] == "req-1"
        assert api.report_calls == [("market_context", "snapshot-1")]
        denied = client.post(
            "/api/v5/agents/source_auditor/report", headers={"Origin": ORIGIN}
        ).json()
        assert denied["status"] == "BLOCKED"
        assert api.report_calls == [("market_context", "snapshot-1")]


def test_report_refusal_is_blocked_and_never_relabelled_as_success(tmp_path):
    api = FakeUpstream()
    api.refuse = True
    app = create_app(
        settings=settings(tmp_path), upstream=api, static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        login(client)
        result = client.post(
            "/api/v5/agents/market_analyst/report", headers={"Origin": ORIGIN}
        ).json()
        assert result["status"] == "BLOCKED"
        assert result["ticks"][0]["status"] == "BLOCKED"
        # The sanitized refusal status distinguishes refusals in the journal.
        assert result["ticks"][0]["error"] == "task_refused:BUDGET_REFUSED"
        assert result["effect"] == "NONE"


def test_source_errors_are_visible_without_exception_text(tmp_path):
    api = FakeUpstream()
    api.fail_source = True
    app = create_app(
        settings=settings(tmp_path), upstream=api, static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        login(client)
        result = client.get("/api/v5/workspace").json()
        assert "context:unavailable" in result["source_error"]
        assert "sensitive" not in result["source_error"]
        report = client.post(
            "/api/v5/agents/market_analyst/report", headers={"Origin": ORIGIN}
        ).json()
        assert report["status"] in {"BLOCKED", "FAILED"}
        assert "sensitive" not in str(report)


def test_loop_caps_origin_and_stop_are_enforced(tmp_path):
    api = FakeUpstream()
    app = create_app(
        settings=settings(tmp_path), upstream=api, static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        login(client)
        invalid = client.post(
            "/api/v5/agents/market_analyst/loops/start",
            json={
                "loop_id": "market_analyst_monitor",
                "frequency_sec": 60,
                "max_ticks": 1,
            },
            headers={"Origin": ORIGIN},
        )
        assert invalid.status_code == 422
        valid = client.post(
            "/api/v5/agents/market_analyst/loops/start",
            json={
                "loop_id": "market_analyst_monitor",
                "frequency_sec": 900,
                "max_ticks": 1,
            },
            headers={"Origin": ORIGIN},
        )
        assert valid.status_code == 200
        session_id = valid.json()["id"]
        assert (
            client.post(
                f"/api/v5/sessions/{session_id}/stop",
                headers={"Origin": "https://evil.example"},
            ).status_code
            == 403
        )
        stopped = client.post(
            f"/api/v5/sessions/{session_id}/stop", headers={"Origin": ORIGIN}
        )
        assert stopped.status_code == 200
        assert stopped.json()["status"] == "STOPPED"
        assert api.report_calls == []


def test_restart_marks_pending_sessions_interrupted(tmp_path):
    root = tmp_path / "state"
    first = WorkspaceState(root, clock=lambda: 1_000)
    session = first.create_session("market_analyst", kind="report")
    first.close()
    second = WorkspaceState(root, clock=lambda: 2_000)
    assert second.session(session["id"])["status"] == "INTERRUPTED"
    assert second.session(session["id"])["finished_at_ms"] == 2_000
    second.close()


def test_runtime_lease_refuses_second_process_before_recovery(tmp_path):
    from condor.v5.state import RuntimeInUseError

    root = tmp_path / "one-owner"
    first = WorkspaceState(root)
    session = first.create_session("market_analyst", kind="report")
    try:
        WorkspaceState(root)
        raise AssertionError("a second process must not open the same V5 runtime")
    except RuntimeInUseError:
        pass
    assert first.session(session["id"])["status"] == "RUNNING"
    first.close()
    second = WorkspaceState(root)
    assert second.session(session["id"])["status"] == "INTERRUPTED"
    second.close()


def test_storage_limit_preserves_old_sessions_without_pruning(tmp_path, monkeypatch):
    import condor.v5.state as state_module
    from condor.v5.state import StateCapacityError

    monkeypatch.setattr(state_module, "MAX_ROWS", 2)
    state = WorkspaceState(tmp_path / "append-only")
    one = state.create_session("market_analyst", kind="inspect")
    state.add_tick(
        one["id"],
        status="COMPLETED",
        summary="retained evidence",
        evidence_refs=["snapshot-a"],
    )
    state.finish_session(one["id"], "COMPLETED", "retained")
    two = state.create_session("source_auditor", kind="inspect")
    try:
        state.create_session("market_analyst", kind="inspect")
        raise AssertionError("session capacity must refuse new work")
    except StateCapacityError:
        pass
    assert state.session(one["id"]) is not None
    assert state.session(one["id"])["ticks"][0]["evidence_refs"] == ["snapshot-a"]
    assert state.session(two["id"]) is not None
    state.close()


def test_state_backup_uses_sqlite_backup_and_preserves_journal(tmp_path):
    import sqlite3

    source_root = tmp_path / "source"
    state = WorkspaceState(source_root)
    session = state.create_session("market_analyst", kind="inspect")
    state.add_tick(session["id"], status="COMPLETED", summary="backup record")
    target = tmp_path / "backup" / "workspace.sqlite3"
    WorkspaceState.backup_database(state.path, target)
    state.close()
    with sqlite3.connect(target) as backup:
        assert backup.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
        assert (
            backup.execute("SELECT summary FROM ticks").fetchone()[0] == "backup record"
        )


def test_report_storage_capacity_refuses_before_upstream_request(tmp_path, monkeypatch):
    import condor.v5.state as state_module

    monkeypatch.setattr(state_module, "MAX_ROWS", 1)
    config = settings(tmp_path)
    state = WorkspaceState(config.runtime_root)
    state.create_session("market_analyst", kind="inspect")
    api = FakeUpstream()
    app = create_app(
        settings=config, upstream=api, state=state, static_dir=tmp_path / "dist"
    )
    with TestClient(app) as client:
        login(client)
        result = client.post(
            "/api/v5/agents/market_analyst/report", headers={"Origin": ORIGIN}
        )
        assert result.status_code == 507
        assert result.json()["detail"]["code"] == "workspace_storage_capacity"
        assert api.report_calls == []


def test_local_overlay_cannot_expand_tools_or_write_outside_root(tmp_path):
    config = settings(tmp_path)
    from condor.v5.agents import AgentCatalog

    catalog = AgentCatalog(config)
    local = config.runtime_root / "agents" / "market_analyst"
    local.mkdir(parents=True)
    (local / "AGENT.md").write_text(
        "---\nname: Local V5 Analyst\ntools: [place_order, shell]\n---\nLocal notes.\n"
    )
    agent = catalog.get("market_analyst")
    assert agent.source == "local"
    assert agent.name == "Local V5 Analyst"
    assert set(agent.tools) == {
        "get_market_context",
        "get_advice_history",
        "request_market_report",
    }
    assert catalog.get("../../web") is None
    catalog.save_notes("market_analyst", "Owned V5 note")
    assert (local / "notes.md").read_text() == "Owned V5 note"
    outside = tmp_path / "outside.md"
    outside.write_text("keep")
    (local / "notes.md").unlink()
    (local / "notes.md").symlink_to(outside)
    try:
        catalog.save_notes("market_analyst", "escape")
        raise AssertionError("symlink write should fail")
    except ValueError:
        pass
    assert outside.read_text() == "keep"


def test_runtime_root_rejects_condor_state(tmp_path):
    config = settings(tmp_path)
    from condor.v5.config import Settings as RuntimeSettings

    for ordinary in (
        (Path(__file__).resolve().parents[1] / ".condor").resolve(),
        (Path(__file__).resolve().parents[1] / "condor" / ".condor").resolve(),
        (Path(__file__).resolve().parents[1] / "agents").resolve(),
        (Path(__file__).resolve().parents[1] / "condor" / "agents").resolve(),
    ):
        try:
            RuntimeSettings.from_env(
                {
                    "V5_RUNTIME_ROOT": str(ordinary),
                    "V5_DASHBOARD_TOKEN_FILE": str(config.dashboard_token_file),
                    "V5_DASHBOARD_ORIGIN": ORIGIN,
                    "V5_OBSERVATION_BASE_URL": config.observation_base_url,
                    "V5_OBSERVATION_TOKEN_FILE": str(
                        config.observation_read_token_file
                    ),
                    "V5_ADVISOR_CONTROL_BASE_URL": config.advisor_control_base_url,
                    "V5_ADVISORY_REQUEST_TOKEN_FILE": str(
                        config.advisor_request_token_file
                    ),
                }
            )
            raise AssertionError("shared runtime root should be rejected")
        except ConfigurationError:
            pass


def test_secret_reader_is_bounded_and_rejects_nonprintable_tokens(tmp_path):
    from condor.v5.config import read_secret_file

    large = tmp_path / "large"
    large.write_bytes(b"x" * 50_000)
    bad = tmp_path / "bad"
    bad.write_text("a" * 31 + "\n")
    good = tmp_path / "good"
    good.write_text("a" * 48)
    assert read_secret_file(large) == ""
    assert read_secret_file(bad) == ""
    assert read_secret_file(good) == "a" * 48


def test_wire_body_limit_precedes_json_decode_for_chunked_and_length(tmp_path):
    app = create_app(settings=settings(tmp_path), upstream=FakeUpstream())
    with TestClient(app) as client:
        for content in (b"[" + b" " * 20000, iter((b"[", b" " * 20000))):
            result = client.post(
                "/api/v5/auth/login",
                content=content,
                headers={"Origin": ORIGIN, "Content-Type": "application/json"},
            )
            assert result.status_code == 413
        assert (
            client.post(
                "/api/v5/agents/market_analyst/notes", content=b"x" * 20000
            ).status_code
            == 413
        )


def test_source_inspection_uses_real_available_at_ms_field(tmp_path):
    api = FakeUpstream()
    api.context = {
        "schema_version": "multi-venue-evidence.v1",
        "snapshot_id": "snapshot-1",
        "available_at_ms": 123456,
    }
    app = create_app(settings=settings(tmp_path), upstream=api)
    with TestClient(app) as client:
        login(client)
        response = client.post(
            "/api/v5/agents/market_analyst/inspect", headers={"Origin": ORIGIN}
        )
        assert response.status_code == 200
        assert "availability=123456" in str(response.json())


def test_loop_refuses_disabled_task_or_unavailable_source(tmp_path):
    api = FakeUpstream()
    app = create_app(settings=settings(tmp_path), upstream=api)
    with TestClient(app) as client:
        login(client)
        body = {
            "loop_id": "market_analyst_monitor",
            "frequency_sec": 900,
            "max_ticks": 1,
        }
        api.task_rows[0]["enabled"] = False
        assert (
            client.post(
                "/api/v5/agents/market_analyst/loops/start",
                json=body,
                headers={"Origin": ORIGIN},
            ).status_code
            == 409
        )
        api.task_rows[0]["enabled"] = True
        api.fail_source = True
        assert (
            client.post(
                "/api/v5/agents/market_analyst/loops/start",
                json=body,
                headers={"Origin": ORIGIN},
            ).status_code
            == 409
        )
        assert client.get("/api/v5/sessions").json() == {"sessions": []}
        assert api.report_calls == []


def test_health_is_public_liveness_and_claims_no_source_readiness(tmp_path):
    api = FakeUpstream()
    api.fail_source = True
    app = create_app(settings=settings(tmp_path), upstream=api)
    with TestClient(app) as client:
        result = client.get("/health")
        assert result.status_code == 200
        assert result.json() == {
            "status": "RUNNING",
            "readiness": "UNCHECKED",
            "execution_enabled": False,
            "authority": "reports-only",
        }
        assert api.observation_calls == []


def test_settings_preserve_owner_model_and_source_revision(tmp_path):
    app = create_app(settings=settings(tmp_path), upstream=FakeUpstream())
    with TestClient(app) as client:
        login(client)
        data = client.get("/api/v5/settings").json()
        assert data["identity"]["upstream_revision"] == "api-test-sha"
        assert data["budget"]["model"] == "claude-sonnet"
