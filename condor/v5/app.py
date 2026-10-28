"""Independent reports-only FastAPI application for the RSI V5 workspace.

This app intentionally does not import ``condor.web.app``, AgentStore,
TickEngine, MCP tools, Hummingbot controls, or any general Condor router.
"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from .agents import AGENT_SPECS, REPORT_ROLES, AgentCatalog, AgentDefinition
from .config import Settings, read_secret_file
from .dashboard import dashboard_profile, read_compatibility_path
from .state import StateCapacityError, WorkspaceState
from .upstream import UpstreamError, V5Upstream

logger = logging.getLogger(__name__)
COOKIE_NAME = "rsi_v5_session"
SESSION_ID_RE = re.compile(r"^[a-f0-9]{32}$")
MAX_JSON_BODY_BYTES = 16_384
MAX_TICKS_PER_LOOP = 96
MIN_LOOP_FREQUENCY_SEC = 900


class RequestBodyLimit:
    """Enforce the byte cap on wire input before FastAPI JSON decoding."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        data = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            data.extend(message.get("body", b""))
            if len(data) > MAX_JSON_BODY_BYTES:
                return await JSONResponse(
                    {"detail": {"code": "request_too_large"}}, status_code=413
                )(scope, receive, send)
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(data), "more_body": False}
            return await receive()

        return await self.app(scope, replay, send)


class LoginBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=16, max_length=4096)


class ReportLoopBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    loop_id: str = Field(min_length=1, max_length=64)
    frequency_sec: int = Field(ge=MIN_LOOP_FREQUENCY_SEC, le=86_400)
    max_ticks: int = Field(ge=1, le=MAX_TICKS_PER_LOOP)


class NotesBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=8_000)


def create_app(
    *,
    settings: Settings | None = None,
    upstream: V5Upstream | Any | None = None,
    state: WorkspaceState | None = None,
    catalog: AgentCatalog | None = None,
    static_dir: Path | None = None,
    clock=lambda: time.time_ns() // 1_000_000,
) -> FastAPI:
    config = settings or Settings.from_env()
    store = state or WorkspaceState(config.runtime_root, clock=clock)
    agents = catalog or AgentCatalog(config)
    api = upstream or V5Upstream(config)
    active_loop_task: asyncio.Task | None = None
    active_loop_stop: asyncio.Event | None = None
    login_failures: dict[str, list[float]] = {}

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            yield
        finally:
            if active_loop_task is not None and not active_loop_task.done():
                active_loop_task.cancel()
                try:
                    await active_loop_task
                except asyncio.CancelledError:
                    pass
            close = getattr(store, "close", None)
            if callable(close):
                close()

    app = FastAPI(
        title="RSI V5 Workspace",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(RequestBodyLimit)
    app.state.v5_settings = config
    app.state.v5_state = store
    app.state.v5_catalog = agents

    @app.middleware("http")
    async def safe_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-V5-Authority"] = "reports-only"
        if request.url.path == "/" or request.url.path.startswith("/assets/"):
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
            )
        return response

    def dashboard_token() -> str:
        token = read_secret_file(config.dashboard_token_file)
        if not 32 <= len(token) <= 256:
            raise HTTPException(503, detail={"code": "dashboard_auth_unavailable"})
        return token

    def caller_key(request: Request) -> str:
        host = request.client.host if request.client else "unknown"
        try:
            return str(ipaddress.ip_address(host))
        except ValueError:
            return "unknown"

    def check_origin(request: Request) -> None:
        origin = request.headers.get("origin", "").rstrip("/")
        site = request.headers.get("sec-fetch-site", "")
        if not hmac.compare_digest(
            origin.encode("utf-8"), config.dashboard_origin.encode("utf-8")
        ):
            raise HTTPException(403, detail={"code": "same_origin_required"})
        if site and site not in {"same-origin", "none"}:
            raise HTTPException(403, detail={"code": "same_origin_required"})

    async def require_auth(request: Request) -> None:
        expected = dashboard_token()
        supplied = request.cookies.get(COOKIE_NAME, "")
        if not supplied or not hmac.compare_digest(supplied, expected):
            raise HTTPException(401, detail={"code": "authentication_required"})

    @app.get("/health")
    async def health():
        return {
            "status": "RUNNING",
            "readiness": "UNCHECKED",
            "execution_enabled": False,
            "authority": "reports-only",
        }

    @app.get("/api/v5/auth")
    async def auth_status(request: Request):
        token = read_secret_file(config.dashboard_token_file)
        if not 32 <= len(token) <= 256:
            return {"authenticated": False}
        supplied = request.cookies.get(COOKIE_NAME, "")
        return {
            "authenticated": bool(supplied and hmac.compare_digest(supplied, token))
        }

    @app.get("/api/v5/dashboard/profile", dependencies=[Depends(require_auth)])
    async def dashboard_compatibility_profile():
        return dashboard_profile()

    @app.get("/api/v5/dashboard/read", dependencies=[Depends(require_auth)])
    async def dashboard_compatibility_read(
        path: str = Query(min_length=1, max_length=2048),
    ):
        return read_compatibility_path(path)

    @app.post("/api/v5/auth/login")
    async def login(payload: LoginBody, request: Request, response: Response):
        check_origin(request)
        now = time.monotonic()
        key = caller_key(request)
        attempts = [time for time in login_failures.get(key, []) if now - time < 60]
        if len(attempts) >= 8:
            raise HTTPException(429, detail={"code": "login_rate_limited"})
        expected = read_secret_file(config.dashboard_token_file)
        if not 32 <= len(expected) <= 256 or not hmac.compare_digest(
            payload.token, expected
        ):
            attempts.append(now)
            login_failures[key] = attempts
            raise HTTPException(401, detail={"code": "invalid_dashboard_token"})
        login_failures.pop(key, None)
        response.set_cookie(
            COOKIE_NAME,
            expected,
            httponly=True,
            secure=config.cookie_secure,
            samesite="strict",
            path="/",
            max_age=86_400,
        )
        return {"authenticated": True}

    @app.post("/api/v5/auth/logout")
    async def logout(
        request: Request, response: Response, _auth: None = Depends(require_auth)
    ):
        check_origin(request)
        response.delete_cookie(
            COOKIE_NAME,
            path="/",
            secure=config.cookie_secure,
            httponly=True,
            samesite="strict",
        )
        return {"authenticated": False}

    async def authorized_post(request: Request):
        check_origin(request)
        await require_auth(request)

    async def get_json(path: str) -> dict[str, Any]:
        return await api.observation(path)

    def task_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
        rows = payload.get("tasks", [])
        allowed = {"market_context", "source_quality"}
        result = []
        if not isinstance(rows, list):
            return result
        for row in rows[:16]:
            if not isinstance(row, dict) or row.get("task_id") not in allowed:
                continue
            profile = {"task_id": row["task_id"]}
            if isinstance(row.get("model"), str):
                profile["model"] = row["model"][:128]
            profile["enabled"] = row.get("enabled") is True
            if isinstance(row.get("reason"), str):
                profile["reason"] = row["reason"][:200]
            result.append(profile)
        return result

    def task_ready(task_id: str, rows: list[dict[str, Any]]) -> tuple[bool, str | None]:
        profile = next((item for item in rows if item.get("task_id") == task_id), None)
        if profile is None:
            return False, "task_profile_unavailable"
        if profile.get("enabled") is not True:
            reason = profile.get("reason")
            return False, (
                str(reason)[:200]
                if isinstance(reason, str) and reason
                else "task_disabled"
            )
        return True, None

    def safe_advisor_status(status: dict[str, Any]) -> dict[str, Any]:
        allowed = (
            "enabled",
            "model",
            "calls_today",
            "spent_usd",
            "reserved_usd",
            "mode",
            "effect",
            "journal_status",
            "baseline_binding_hash",
            "native_v5_parity",
        )
        return {key: status[key] for key in allowed if key in status}

    def apply_task_status(
        agent: AgentDefinition, rows: list[dict[str, Any]]
    ) -> dict[str, Any]:
        value = agent.summary()
        if agent.task_id:
            ready, reason = task_ready(agent.task_id, rows)
            if not ready:
                value["status"] = "blocked"
                value["blockers"] = [reason or "task_disabled"]
            else:
                profile = next(
                    (item for item in rows if item.get("task_id") == agent.task_id), {}
                )
                model = profile.get("model")
                value["model"] = model[:128] if isinstance(model, str) else None
        return value

    async def collect_sources() -> (
        tuple[dict[str, Any], list[dict[str, Any]], list[str]]
    ):
        paths = {
            "context": "/v1/context",
            "identity": "/v1/identity",
            "advisor": "/v1/advice/status",
            "history": "/v1/advice/history",
            "latest": "/v1/advice/latest",
        }
        names = list(paths)
        results = await asyncio.gather(
            *(get_json(paths[name]) for name in names),
            api.task_profiles(),
            return_exceptions=True,
        )
        source: dict[str, Any] = {}
        errors: list[str] = []
        for name, result in zip(names, results[: len(names)]):
            if isinstance(result, BaseException):
                errors.append(
                    f"{name}:{result.code if isinstance(result, UpstreamError) else 'unavailable'}"
                )
            else:
                source[name] = result
        task_result = results[-1]
        if isinstance(task_result, BaseException):
            errors.append(
                f"task_profiles:{task_result.code if isinstance(task_result, UpstreamError) else 'unavailable'}"
            )
            rows = []
        else:
            rows = task_rows(task_result)
        return source, rows, errors

    @app.get("/api/v5/workspace", dependencies=[Depends(require_auth)])
    async def workspace():
        source, rows, errors = await collect_sources()
        context = source.get("context")
        identity = source.get("identity", {})
        status = safe_advisor_status(source.get("advisor", {}))
        budget = {
            key: source["advisor"][key]
            for key in ("calls_today", "spent_usd", "reserved_usd")
            if key in source.get("advisor", {})
        }
        if "budget" in source.get("advisor", {}) and isinstance(
            source["advisor"]["budget"], dict
        ):
            budget.update(
                {
                    key: value
                    for key, value in source["advisor"]["budget"].items()
                    if key in {"calls_today", "spent_usd", "reserved_usd"}
                }
            )
        status.update(budget)
        source_error = ";".join(errors) if errors else None
        history = source.get("history", {}).get("records", [])
        sessions = store.sessions()
        return {
            "schema_version": "v5-workspace.v1",
            "identity": {
                "name": "RSI V5",
                "host": "razer",
                "mode": "reports-only",
                "execution_enabled": False,
                "baseline_binding": None,
                "upstream_revision": identity.get(
                    "upstream_revision",
                    identity.get("revision", identity.get("api_declared_commit")),
                ),
            },
            "context": context,
            "advisor": {
                **status,
                "task_profiles": rows,
                "latest": source.get("latest"),
                "history_count": len(history) if isinstance(history, list) else 0,
            },
            "agents": [
                apply_task_status(agent, rows)
                for agent_id in agents.ids()
                if (agent := agents.get(agent_id)) is not None
            ],
            "sessions": sessions,
            "storage": store.storage_status(),
            "source_error": source_error,
        }

    def agent_or_404(agent_id: str) -> AgentDefinition:
        agent = agents.get(agent_id)
        if agent is None:
            raise HTTPException(404, detail={"code": "agent_not_found"})
        return agent

    @app.get("/api/v5/agents/{agent_id}", dependencies=[Depends(require_auth)])
    async def agent_detail(agent_id: str):
        agent = agent_or_404(agent_id)
        _, rows, errors = await collect_sources()
        value = apply_task_status(agent, rows)
        value.update(
            playbook=agent.playbook,
            skills=[dict(skill) for skill in agent.skills],
            notes=agent.notes,
            policy={
                "allowed_tools": list(agent.tools),
                "execution_enabled": False,
                "tool_policy_mode": "explicit_v5_allowlist",
                "empty_allowlist_means": "deny_all",
            },
            source_error=";".join(errors) if errors else None,
        )
        return value

    async def authorized_mutation(request: Request):
        await authorized_post(request)

    def session_response(session_id: str) -> dict[str, Any]:
        value = store.session(session_id)
        if value is None:
            raise HTTPException(404, detail={"code": "session_not_found"})
        return value

    @app.post("/api/v5/agents/{agent_id}/inspect")
    async def inspect_agent(agent_id: str, request: Request):
        await authorized_mutation(request)
        agent = agent_or_404(agent_id)
        try:
            session = store.create_session(
                agent_id, kind="inspect", summary="Source inspection started"
            )
        except StateCapacityError as exc:
            raise HTTPException(
                507, detail={"code": "workspace_storage_capacity"}
            ) from exc
        if agent_id == "decision_reviewer":
            summary = (
                "Blocked: exact native V5 baseline and decision trace are not bound"
            )
            store.add_tick(
                session["id"],
                status="BLOCKED",
                summary=summary,
                error="baseline_unbound",
            )
            store.finish_session(session["id"], "BLOCKED", summary)
            return session_response(session["id"])
        try:
            context = await get_json("/v1/context")
        except Exception as exc:
            code = exc.code if isinstance(exc, UpstreamError) else "source_unavailable"
            summary = "Source inspection could not read current market evidence"
            store.add_tick(session["id"], status="FAILED", summary=summary, error=code)
            store.finish_session(session["id"], "FAILED", summary)
            return session_response(session["id"])
        snapshot_id = context.get("snapshot_id") if isinstance(context, dict) else None
        refs = [snapshot_id] if isinstance(snapshot_id, str) and snapshot_id else []
        availability = (
            context.get("available_at_ms") if isinstance(context, dict) else None
        )
        if not refs:
            summary = "Source inspection found no qualified snapshot identity"
            store.add_tick(
                session["id"],
                status="BLOCKED",
                summary=summary,
                error="snapshot_identity_unavailable",
            )
            store.finish_session(session["id"], "BLOCKED", summary)
        else:
            summary = f"Inspected source snapshot {snapshot_id}; availability={availability if availability is not None else 'unavailable'}"
            store.add_tick(
                session["id"], status="COMPLETED", summary=summary, evidence_refs=refs
            )
            store.finish_session(session["id"], "COMPLETED", summary)
        return session_response(session["id"])

    async def perform_report(agent: AgentDefinition, session_id: str) -> dict[str, Any]:
        if agent.task_id is None or agent.id not in REPORT_ROLES:
            store.add_tick(
                session_id,
                status="BLOCKED",
                summary="This role has no enabled public-data task",
                error="task_not_allowed",
            )
            store.finish_session(
                session_id,
                "BLOCKED",
                "This role is blocked until the native baseline is bound",
            )
            return session_response(session_id)
        try:
            source, rows, source_errors = await collect_sources()
            if source_errors:
                raise UpstreamError("source_unavailable")
            enabled, reason = task_ready(agent.task_id, rows)
            if not enabled:
                detail = reason or "task_disabled"
                store.add_tick(
                    session_id,
                    status="BLOCKED",
                    summary="Advisor task is not enabled",
                    error=detail,
                )
                store.finish_session(
                    session_id, "BLOCKED", "Advisor task is not enabled"
                )
                return session_response(session_id)
            context = source.get("context")
            snapshot_id = (
                context.get("snapshot_id") if isinstance(context, dict) else None
            )
            if not isinstance(snapshot_id, str) or not snapshot_id:
                raise UpstreamError("snapshot_identity_unavailable")
            envelope = await api.request_report(agent.task_id, snapshot_id)
            result_status = str(envelope.get("status", "UNKNOWN"))[:64]
            advice = envelope.get("advice")
            summary_text = advice.get("summary") if isinstance(advice, dict) else None
            summary = (
                summary_text
                if isinstance(summary_text, str) and summary_text
                else f"Report request completed with status {result_status}"
            )
            tick_status = (
                "COMPLETED"
                if result_status
                in {"ACCEPTED", "COMPLETED", "CURRENT_REPORT", "HISTORICAL_REPORT"}
                else "BLOCKED"
            )
            if tick_status == "BLOCKED":
                error = str(envelope.get("reason", result_status))[:160]
            else:
                error = None
            evidence_refs = (
                advice.get("evidence_refs", []) if isinstance(advice, dict) else []
            )
            store.add_tick(
                session_id,
                status=tick_status,
                summary=summary,
                evidence_refs=evidence_refs if isinstance(evidence_refs, list) else [],
                report=envelope,
                error=error,
            )
            store.finish_session(session_id, tick_status, summary)
        except UpstreamError as exc:
            status = "BLOCKED" if exc.http_status == 409 else "FAILED"
            summary = (
                "Advisor refused the report request"
                if status == "BLOCKED"
                else "Advisor report request is unavailable"
            )
            store.add_tick(session_id, status=status, summary=summary, error=exc.code)
            store.finish_session(session_id, status, summary)
        except Exception as exc:
            logger.warning("V5 report request failed: %s", type(exc).__name__)
            summary = "Advisor report request is unavailable"
            store.add_tick(
                session_id,
                status="FAILED",
                summary=summary,
                error="upstream_unavailable",
            )
            store.finish_session(session_id, "FAILED", summary)
        return session_response(session_id)

    @app.post("/api/v5/agents/{agent_id}/report")
    async def request_agent_report(agent_id: str, request: Request):
        await authorized_mutation(request)
        agent = agent_or_404(agent_id)
        try:
            session = store.create_session(
                agent_id, kind="report", summary="Report request started"
            )
        except StateCapacityError as exc:
            raise HTTPException(
                507, detail={"code": "workspace_storage_capacity"}
            ) from exc
        return await perform_report(agent, session["id"])

    async def loop_runner(
        agent: AgentDefinition,
        session_id: str,
        frequency_sec: int,
        max_ticks: int,
        stop: asyncio.Event,
    ):
        try:
            for index in range(max_ticks):
                try:
                    await asyncio.wait_for(stop.wait(), timeout=frequency_sec)
                    break
                except asyncio.TimeoutError:
                    pass
                if stop.is_set():
                    break
                # Each loop tick gets a child session journal row and is bounded
                # by the API worker's own call, price and spend caps.
                tick_session = store.create_session(
                    agent.id,
                    kind="report",
                    loop_id=f"{agent.id}_monitor",
                    summary="Loop report tick",
                )
                result = await perform_report(agent, tick_session["id"])
                detail = result.get("ticks", [])
                latest = detail[-1] if detail else {}
                store.add_tick(
                    session_id,
                    status=latest.get("status", "FAILED"),
                    summary=latest.get("summary", "Report tick unavailable"),
                    evidence_refs=latest.get("evidence_refs", []),
                    report=latest.get("report"),
                    error=latest.get("error"),
                )
                current = store.session(session_id)
                if current and current.get("status") != "RUNNING":
                    break
                if index + 1 >= max_ticks:
                    store.finish_session(
                        session_id,
                        "COMPLETED",
                        f"Bounded loop completed {max_ticks} report ticks",
                    )
                    break
            else:
                store.finish_session(
                    session_id,
                    "COMPLETED",
                    f"Bounded loop completed {max_ticks} report ticks",
                )
            current = store.session(session_id)
            if current and current.get("status") == "RUNNING":
                store.finish_session(session_id, "STOPPED", "Report loop stopped")
        except asyncio.CancelledError:
            store.finish_session(
                session_id,
                "INTERRUPTED",
                "Process stopped; pending work was not replayed",
            )
            raise
        except Exception as exc:
            logger.warning("V5 report loop failed: %s", type(exc).__name__)
            summary = (
                "Report loop stopped because journal capacity was reached"
                if isinstance(exc, StateCapacityError)
                else "Report loop stopped after an internal error"
            )
            store.finish_session(session_id, "FAILED", summary)

    @app.post("/api/v5/agents/{agent_id}/loops/start")
    async def start_loop(agent_id: str, payload: ReportLoopBody, request: Request):
        nonlocal active_loop_task, active_loop_stop
        await authorized_mutation(request)
        agent = agent_or_404(agent_id)
        allowed_loop = f"{agent_id}_monitor"
        if agent_id not in REPORT_ROLES or payload.loop_id != allowed_loop:
            raise HTTPException(403, detail={"code": "loop_not_allowed"})
        source, rows, errors = await collect_sources()
        if (
            errors
            or not isinstance(source.get("context"), dict)
            or not source["context"].get("snapshot_id")
        ):
            raise HTTPException(409, detail={"code": "source_unavailable"})
        enabled, reason = task_ready(agent.task_id, rows)
        if not enabled:
            raise HTTPException(409, detail={"code": reason or "task_disabled"})
        if active_loop_task is not None and not active_loop_task.done():
            raise HTTPException(409, detail={"code": "active_loop_exists"})
        if store.active_loop() is not None:
            raise HTTPException(409, detail={"code": "active_loop_exists"})
        active_loop_stop = asyncio.Event()
        try:
            session = store.create_session(
                agent_id,
                kind="loop",
                loop_id=allowed_loop,
                summary="Bounded reports-only loop scheduled",
                reserve_bytes=payload.max_ticks * 24 * 1024,
                expected_sessions=payload.max_ticks,
                expected_ticks=payload.max_ticks * 2,
            )
        except StateCapacityError as exc:
            raise HTTPException(
                507, detail={"code": "workspace_storage_capacity"}
            ) from exc
        except RuntimeError as exc:
            raise HTTPException(409, detail={"code": "active_loop_exists"}) from exc
        active_loop_task = asyncio.create_task(
            loop_runner(
                agent,
                session["id"],
                payload.frequency_sec,
                payload.max_ticks,
                active_loop_stop,
            )
        )
        return session_response(session["id"])

    @app.post("/api/v5/sessions/{session_id}/stop")
    async def stop_session(session_id: str, request: Request):
        nonlocal active_loop_task, active_loop_stop
        await authorized_mutation(request)
        if not SESSION_ID_RE.fullmatch(session_id):
            raise HTTPException(404, detail={"code": "session_not_found"})
        session = store.session(session_id)
        if session is None:
            raise HTTPException(404, detail={"code": "session_not_found"})
        if session.get("kind") != "loop":
            raise HTTPException(409, detail={"code": "session_not_a_loop"})
        if session.get("status") != "RUNNING":
            return session
        if active_loop_stop:
            active_loop_stop.set()
        if active_loop_task is not None:
            # Let an in-flight upstream call reach its bounded timeout and be
            # journaled before the loop exits; do not cancel a possible charge.
            await active_loop_task
            active_loop_task = None
            active_loop_stop = None
        if store.session(session_id).get("status") == "RUNNING":
            store.finish_session(
                session_id, "STOPPED", "Report loop stopped by operator"
            )
        return session_response(session_id)

    @app.get("/api/v5/sessions", dependencies=[Depends(require_auth)])
    async def list_sessions():
        return {"sessions": store.sessions()}

    @app.get("/api/v5/sessions/{session_id}", dependencies=[Depends(require_auth)])
    async def get_session(session_id: str):
        if not SESSION_ID_RE.fullmatch(session_id):
            raise HTTPException(404, detail={"code": "session_not_found"})
        return session_response(session_id)

    @app.put("/api/v5/agents/{agent_id}/notes")
    async def put_notes(agent_id: str, payload: NotesBody, request: Request):
        await authorized_mutation(request)
        agent_or_404(agent_id)
        try:
            agents.save_notes(agent_id, payload.text)
        except ValueError as exc:
            raise HTTPException(400, detail={"code": "notes_invalid"}) from exc
        return {"agent_id": agent_id, "notes": payload.text}

    @app.get("/api/v5/settings", dependencies=[Depends(require_auth)])
    async def settings_view():
        source, rows, errors = await collect_sources()
        advisor = source.get("advisor", {})
        identity = source.get("identity", {})
        return {
            "identity": {
                "name": "RSI V5",
                "host": "razer",
                "mode": "reports-only",
                "execution_enabled": False,
                "baseline_binding": None,
                "upstream_revision": identity.get(
                    "upstream_revision",
                    identity.get("revision", identity.get("api_declared_commit")),
                ),
            },
            "model": advisor.get("model"),
            "budget": {
                key: advisor[key]
                for key in (
                    "enabled",
                    "model",
                    "calls_today",
                    "spent_usd",
                    "reserved_usd",
                    "effect",
                )
                if key in advisor
            },
            "task_profiles": rows,
            "effective_policy": {
                "allowed_tools": sorted(
                    {
                        tool
                        for spec in AGENT_SPECS.values()
                        for tool in spec["allowed_tools"]
                    }
                ),
                "execution_enabled": False,
                "report_requests_require_explicit_user_action": True,
                "provider_key_exposed_to_dashboard": False,
            },
            "source_readiness": "AVAILABLE" if not errors else "PARTIAL",
            "source_error": ";".join(errors) if errors else None,
            "storage": store.storage_status(),
        }

    static_root = (
        static_dir
        or config.frontend_dist
        or Path(__file__).resolve().parents[2] / "frontend" / "dist-v5"
    ).resolve()
    html_path = static_root / "v5.html"
    assets_path = static_root / "assets"
    if assets_path.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_path), name="v5-assets")

    @app.get("/", response_class=HTMLResponse)
    async def root_page():
        if html_path.is_file() and not html_path.is_symlink():
            return FileResponse(html_path, media_type="text/html")
        return HTMLResponse(
            "V5 workspace frontend has not been built.", status_code=503
        )

    for ui_path in (
        "/capital",
        "/bots",
        "/operations",
        "/research",
        "/backtests",
        "/settings",
        "/market/evidence",
        "/v5/readiness",
        "/agents",
        "/sessions",
    ):
        app.add_api_route(
            ui_path,
            root_page,
            methods=["GET"],
            response_class=HTMLResponse,
            include_in_schema=False,
        )

    @app.get("/agents/{agent_id}", response_class=HTMLResponse)
    async def agent_page(agent_id: str):
        if agent_id not in agents.ids():
            raise HTTPException(404)
        return await root_page()

    @app.get("/sessions/{session_id}", response_class=HTMLResponse)
    async def session_page(session_id: str):
        if not SESSION_ID_RE.fullmatch(session_id):
            raise HTTPException(404)
        return await root_page()

    return app
