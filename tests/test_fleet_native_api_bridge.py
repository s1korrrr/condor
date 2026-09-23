"""Opt-in source-pair proof: native API ACL through Condor Fleet projection."""

import os
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("FLEET_NATIVE_API_ROOT"),
    reason="Exact isolated native API source must be supplied explicitly",
)


@pytest.mark.asyncio
async def test_provisioned_native_scope_reaches_complete_condor_catalogue(tmp_path, monkeypatch):
    import httpx

    from condor.fetchers.fleet import catalogue_from_api_payload, read_full_catalogue

    api_root = Path(os.environ["FLEET_NATIVE_API_ROOT"]).resolve()
    sys.path.insert(0, str(api_root))
    try:
        import native_profile
        from test.test_fleet_api import _loaded
        from test.test_native_profile import orchestrator, settings

        assert Path(native_profile.__file__).resolve().is_relative_to(api_root)
        store, _ = _loaded()
        config = settings()
        principal_file = tmp_path / "fleet-principals.json"

        async def read_with_scope(scopes):
            import json

            principal_file.write_text(json.dumps({config.username: scopes}))
            app = native_profile.create_native_app(config, orchestrator=orchestrator(), fleet_store=store)
            paths = []
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://isolated-api",
                auth=(config.username, config.password),
            ) as client:
                async def read_path(_client, path):
                    # Force real API cursor traversal across three visible rows.
                    path = path.replace("limit=100", "limit=1")
                    paths.append(path)
                    response = await client.get(path)
                    assert response.status_code == 200, response.text
                    return response.json()

                result = await read_full_catalogue(client, read_path)
                return catalogue_from_api_payload(result), paths

        monkeypatch.setenv("HB_API_FLEET_PRINCIPALS", str(principal_file))
        hidden, hidden_paths = await read_with_scope(["other-authority"])
        assert hidden["bots"] == []
        assert len(hidden_paths) == 1
        visible, visible_paths = await read_with_scope(["fixture-api"])
        assert len(visible["bots"]) == 3
        assert len(visible_paths) == 3
        assert visible["command_available"] is False
        assert visible["aggregated_pnl"] is None
    finally:
        sys.path.remove(str(api_root))
