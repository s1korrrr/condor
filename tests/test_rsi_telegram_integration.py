import asyncio

from handlers.bots.controller_handlers import _selected_deploy_config_names
from handlers.bots.menu import _controller_config_target


def test_telegram_deploy_uses_stable_config_filename_not_internal_id():
    configs = [
        {
            "_config_name": "paper-rsi-v7",
            "id": "operator-visible-id",
            "controller_name": "rsi_v7",
        }
    ]

    assert _selected_deploy_config_names(configs, {0}) == ["paper-rsi-v7"]


def test_telegram_control_uses_config_filename_not_runtime_id():
    class Controllers:
        async def get_bot_controller_configs(self, bot_name):
            assert bot_name == "paper-bot"
            return [{"_config_name": "paper-rsi-v7", "id": "operator-visible-id"}]

    class Client:
        controllers = Controllers()

    target = asyncio.run(
        _controller_config_target(Client(), "paper-bot", "operator-visible-id")
    )

    assert target == "paper-rsi-v7"


from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.mark.parametrize("flow", ["execute", "custom_name"])
@pytest.mark.parametrize("seal", ["a" * 64, None])
def test_telegram_native_deploy_forwards_seal_or_rejects_before_api(
    monkeypatch, flow, seal
):
    from handlers.bots import controller_handlers as handlers

    row = {
        "_config_name": "native",
        "id": "modular_spot_test",
        "controller_name": "modular_ok_rsi",
        "recipe_binding": {"source_sha256": seal},
    }
    transport = AsyncMock(return_value={"success": True, "status": "success"})
    legacy = AsyncMock()
    client = SimpleNamespace(
        controllers=SimpleNamespace(
            list_controller_configs=AsyncMock(return_value=[row])
        ),
        bot_orchestration=SimpleNamespace(
            _post=transport, deploy_v2_controllers=legacy
        ),
    )
    monkeypatch.setattr(
        handlers, "get_bots_client", AsyncMock(return_value=(client, "isolated"))
    )
    update = SimpleNamespace(
        effective_chat=SimpleNamespace(id=1),
        callback_query=SimpleNamespace(
            answer=AsyncMock(), message=SimpleNamespace(edit_text=AsyncMock())
        ),
        message=SimpleNamespace(delete=AsyncMock()),
    )
    params = dict(
        instance_name="candidate",
        credentials_profile="isolated",
        controllers_config=["native"],
        image="sha256:" + "b" * 64,
        max_global_drawdown_quote=100,
        max_controller_drawdown_quote=20,
    )
    context = SimpleNamespace(
        user_data={
            "deploy_params": params,
            "deploy_message_id": 1,
            "deploy_chat_id": 1,
        },
        bot=SimpleNamespace(edit_message_text=AsyncMock()),
    )
    if flow == "execute":
        asyncio.run(handlers.handle_execute_deploy(update, context))
    else:
        asyncio.run(
            handlers.process_deploy_custom_name_input(update, context, "candidate")
        )
    legacy.assert_not_awaited()
    if seal:
        transport.assert_awaited_once()
        assert (
            transport.await_args.kwargs["json"]["native_bundle_source_sha256"] == seal
        )
    else:
        transport.assert_not_awaited()
