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
