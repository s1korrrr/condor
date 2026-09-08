from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_read_only_boundary_allows_reads_auth_but_blocks_all_mutations():
    from condor.web.read_only import ReadOnlyWeb

    app = FastAPI()

    @app.get("/api/v1/example")
    async def read():
        return {"value": 1}

    @app.post("/api/v1/auth/tailscale")
    async def login():
        return {"login": True}

    @app.post("/api/v1/servers/local/bots/start")
    async def start():
        raise AssertionError("must not reach bot command")

    c = TestClient(ReadOnlyWeb(app))
    assert c.get("/api/v1/example").json() == {"value": 1}
    assert c.post("/api/v1/auth/tailscale").status_code == 200
    for method in ("post", "put", "delete", "patch"):
        assert getattr(c, method)("/api/v1/servers/local/bots/start").status_code == 403


def test_read_only_boundary_rejects_chat_websocket():
    import pytest
    from starlette.websockets import WebSocketDisconnect
    from condor.web.read_only import ReadOnlyWeb

    with pytest.raises(WebSocketDisconnect) as error:
        with TestClient(ReadOnlyWeb(FastAPI())).websocket_connect("/api/v1/chat/ws"):
            pass
    assert error.value.code == 1008


def test_account_setup_opt_in_allows_only_credential_routes():
    from condor.web.read_only import ReadOnlyWeb

    app = FastAPI()

    @app.post("/api/v1/settings/credentials")
    async def add():
        return {"added": True}

    @app.delete("/api/v1/settings/credentials/{connector}")
    async def remove(connector: str):
        return {"deleted": connector}

    client = TestClient(ReadOnlyWeb(app, allow_account_management=True))
    assert client.post("/api/v1/settings/credentials?server=local").status_code == 200
    assert client.delete("/api/v1/settings/credentials/okx?server=local").json() == {
        "deleted": "okx"
    }
    for method, path in [
        ("put", "/api/v1/settings/credentials"),
        ("post", "/api/v1/settings/credentials/okx"),
        ("delete", "/api/v1/settings/credentials/okx/extra"),
        ("post", "/api/v1/settings/servers"),
        ("post", "/api/v1/settings/gateway/start"),
        ("post", "/api/v1/trade/order"),
        ("post", "/api/v1/bots/start"),
    ]:
        assert getattr(client, method)(path).status_code == 403


def test_account_setup_stays_disabled_by_default():
    from condor.web.read_only import ReadOnlyWeb

    client = TestClient(ReadOnlyWeb(FastAPI()))
    assert client.post("/api/v1/settings/credentials").status_code == 403
    assert client.delete("/api/v1/settings/credentials/okx").status_code == 403


def test_native_lifecycle_opt_in_allows_only_exact_native_posts():
    from condor.web.read_only import ReadOnlyWeb

    app = FastAPI()

    @app.post("/api/v1/servers/{server}/bots/{bot}/native/{action}")
    async def native(server: str, bot: str, action: str):
        return {"server": server, "bot": bot, "action": action}

    client = TestClient(ReadOnlyWeb(app, allow_native_lifecycle=True))
    for action in ("start", "stop"):
        response = client.post(
            f"/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/{action}"
        )
        assert response.status_code == 200
        assert response.json()["action"] == action
    for method, path in [
        ("put", "/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/start"),
        ("delete", "/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/stop"),
        ("post", "/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/restart"),
        ("post", "/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/start/"),
        ("post", "/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/stop/extra"),
        ("post", "/api/v1/servers/native-ok-rsi/bots/ok_rsi/stop"),
        ("post", "/api/v1/servers/native-ok-rsi/bots/ok_rsi/controllers/start"),
        ("post", "/api/v1/servers/native-ok-rsi/bots/deploy"),
        ("post", "/api/v1/trade/order"),
        ("post", "/api/v1/settings/credentials"),
        ("post", "/api/v1/servers/native-ok-rsi/bots/bad%2Fbot/native/start"),
    ]:
        assert getattr(client, method)(path).status_code == 403, path


def test_native_lifecycle_is_independent_and_off_by_default():
    from condor.web.read_only import ReadOnlyWeb

    for kwargs in ({}, {"allow_account_management": True}):
        client = TestClient(ReadOnlyWeb(FastAPI(), **kwargs))
        assert (
            client.post(
                "/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/start"
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/stop"
            ).status_code
            == 403
        )


def test_native_lifecycle_flag_preserves_account_exception():
    from condor.web.read_only import ReadOnlyWeb

    app = FastAPI()

    @app.post("/api/v1/settings/credentials")
    async def account():
        return {"account": True}

    client = TestClient(
        ReadOnlyWeb(app, allow_account_management=True, allow_native_lifecycle=True)
    )
    assert client.post("/api/v1/settings/credentials").status_code == 200
