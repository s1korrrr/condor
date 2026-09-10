import asyncio

import pytest

from condor.rsi_controllers import (
    controller_config_identity,
    load_deployable_controller_types,
    require_safe_rsi_deployment,
    resolve_controller_names,
    validate_controller_config_for_write,
)
from mcp_servers.hummingbot_api.tools.bot_management import update_bot_controller_config
from mcp_servers.hummingbot_api.tools.controllers import deploy_bot, modify_controllers


class _Controllers:
    def __init__(self, *, catalog=None, legacy=None, templates=None, configs=None):
        self.catalog = catalog
        self.legacy = legacy or {}
        self.templates = templates or {}
        self.validations = []
        self.configs = configs or []
        self.updates = []

    async def _get(self, path):
        if self.catalog is None:
            raise RuntimeError("catalog unavailable")
        assert path == "/controllers/catalog"
        return self.catalog

    async def list_controllers(self):
        return self.legacy

    async def get_controller_config_template(self, controller_type, controller_name):
        value = self.templates.get((controller_type, controller_name))
        if isinstance(value, Exception):
            raise value
        return value

    async def validate_controller_config(
        self, controller_type, controller_name, config
    ):
        self.validations.append((controller_type, controller_name, config))
        if config.get("rsi_buy_threshold") == 0:
            raise ValueError("rsi_buy_threshold must be greater than zero")
        return {"message": "Configuration is valid"}

    async def list_controller_configs(self):
        return self.configs

    async def get_bot_controller_configs(self, bot_name):
        return self.configs

    async def update_bot_controller_config(self, bot_name, config_name, config):
        self.updates.append((bot_name, config_name, config))
        return {"success": True}


class _Client:
    def __init__(self, controllers, bot_orchestration=None):
        self.controllers = controllers
        self.bot_orchestration = bot_orchestration


class _BotOrchestration:
    def __init__(self):
        self.deployments = []

    async def deploy_v2_controllers(self, **kwargs):
        self.deployments.append(kwargs)
        return {"success": True}


def test_controller_config_identity_prefers_api_filename_over_internal_id():
    assert (
        controller_config_identity(
            {"_config_name": "paper-rsi-v7", "id": "operator-visible-id"}
        )
        == "paper-rsi-v7"
    )


def test_catalog_exposes_only_schema_backed_rsi_controllers():
    controllers = _Controllers(
        catalog={
            "controllers": [
                {
                    "controller_type": "directional_trading",
                    "controller_name": "rsi_v7",
                    "deployable": True,
                },
                {
                    "controller_type": "directional_trading",
                    "controller_name": "rsi_v7_exit_brain",
                    "deployable": False,
                },
                {
                    "controller_type": "directional_trading",
                    "controller_name": "grid_strike",
                    "deployable": True,
                },
            ]
        }
    )

    result = asyncio.run(load_deployable_controller_types(_Client(controllers)))

    assert result == {"directional_trading": ["grid_strike", "rsi_v7"]}


def test_legacy_catalog_fails_closed_when_rsi_helper_has_no_template():
    controllers = _Controllers(
        legacy={"directional_trading": ["rsi_v7", "rsi_v7_exit_brain"]},
        templates={
            ("directional_trading", "rsi_v7"): {"id": {"type": "string"}},
            ("directional_trading", "rsi_v7_exit_brain"): RuntimeError(
                "not a controller"
            ),
        },
    )

    result = asyncio.run(load_deployable_controller_types(_Client(controllers)))

    assert result == {"directional_trading": ["rsi_v7"]}


def test_rsi_config_is_validated_before_write():
    controllers = _Controllers()
    config = {
        "id": "paper-rsi-v7",
        "controller_type": "directional_trading",
        "controller_name": "rsi_v7",
        "rsi_buy_threshold": 31,
        "_config_name": "ignored-in-validation",
    }

    clean = asyncio.run(
        validate_controller_config_for_write(_Client(controllers), config)
    )

    assert clean == {
        "id": "paper-rsi-v7",
        "controller_type": "directional_trading",
        "controller_name": "rsi_v7",
        "rsi_buy_threshold": 31,
    }
    assert controllers.validations == [("directional_trading", "rsi_v7", clean)]


def test_invalid_rsi_config_cannot_reach_persistence():
    controllers = _Controllers()
    config = {
        "id": "paper-rsi-v7",
        "controller_type": "directional_trading",
        "controller_name": "rsi_v7",
        "rsi_buy_threshold": 0,
    }

    with pytest.raises(ValueError, match="greater than zero"):
        asyncio.run(validate_controller_config_for_write(_Client(controllers), config))


def test_config_filename_identity_resolves_controller_for_deployment():
    controllers = _Controllers(
        configs=[
            {
                "_config_name": "paper-rsi-v7",
                "id": "operator-visible-id",
                "controller_name": "rsi_v7",
            }
        ]
    )

    names = asyncio.run(
        resolve_controller_names(_Client(controllers), ["paper-rsi-v7"])
    )

    assert names == ["rsi_v7"]


@pytest.mark.parametrize(
    "image",
    [
        None,
        "",
        "hummingbot/hummingbot",
        "hummingbot/hummingbot:latest",
        "hummingbot/hummingbot:development",
        "hummingbot/hummingbot@sha256:not-a-digest",
    ],
)
def test_rsi_deployment_rejects_unpinned_hummingbot_image(image):
    with pytest.raises(ValueError, match="pinned Hummingbot image"):
        require_safe_rsi_deployment(
            controller_names=["rsi_v7"],
            image=image,
            max_global_drawdown_quote=100,
            max_controller_drawdown_quote=50,
        )


def test_rsi_deployment_requires_positive_loss_rails():
    with pytest.raises(ValueError, match="drawdown limits"):
        require_safe_rsi_deployment(
            controller_names=["rsi_v7"],
            image="rsibot/hummingbot:2355cd342b87",
            max_global_drawdown_quote=None,
            max_controller_drawdown_quote=50,
        )


def test_non_rsi_deployment_preserves_existing_defaults():
    require_safe_rsi_deployment(
        controller_names=["grid_strike"],
        image=None,
        max_global_drawdown_quote=None,
        max_controller_drawdown_quote=None,
    )


@pytest.mark.parametrize(
    "image",
    [
        "rsibot/hummingbot:2355cd342b87",
        "rsibot/hummingbot@sha256:" + "a" * 64,
        "registry.local:5000/rsibot/hummingbot:2026.08.13",
    ],
)
def test_rsi_deployment_accepts_explicit_image_tag_or_digest(image):
    require_safe_rsi_deployment(
        controller_names=["rsi_v7"],
        image=image,
        max_global_drawdown_quote=100,
        max_controller_drawdown_quote=50,
    )


def test_safe_rsi_deployment_reaches_api_with_stable_config_filename():
    controllers = _Controllers(
        configs=[
            {
                "_config_name": "paper-rsi-v7",
                "id": "operator-visible-id",
                "controller_name": "rsi_v7",
            }
        ]
    )
    orchestration = _BotOrchestration()
    client = _Client(controllers, orchestration)

    result = asyncio.run(
        deploy_bot(
            client=client,
            bot_name="rsi-paper",
            controllers_config=["paper-rsi-v7"],
            image="rsibot/hummingbot:2355cd342b87",
            max_global_drawdown_quote=100,
            max_controller_drawdown_quote=40,
        )
    )

    assert result["result"] == {"success": True}
    assert orchestration.deployments == [
        {
            "instance_name": "rsi-paper",
            "controllers_config": ["paper-rsi-v7"],
            "credentials_profile": "master_account",
            "max_global_drawdown_quote": 100,
            "max_controller_drawdown_quote": 40,
            "image": "rsibot/hummingbot:2355cd342b87",
        }
    ]


@pytest.mark.parametrize("action", ["upsert", "delete"])
def test_mcp_cannot_mutate_managed_rsi_source(action):
    kwargs = {
        "client": _Client(_Controllers()),
        "action": action,
        "target": "controller",
        "controller_type": "directional_trading",
        "controller_name": "rsi_v7",
    }
    if action == "upsert":
        kwargs.update(controller_code="class Unsafe: pass", confirm_override=True)

    with pytest.raises(ValueError, match="read-only"):
        asyncio.run(modify_controllers(**kwargs))


def test_mcp_running_config_update_preserves_id_and_addresses_filename():
    controllers = _Controllers(
        configs=[
            {
                "_config_name": "paper-rsi-v7",
                "id": "operator-visible-id",
                "controller_type": "directional_trading",
                "controller_name": "rsi_v7",
            }
        ]
    )
    payload = {
        "controller_type": "directional_trading",
        "controller_name": "rsi_v7",
        "rsi_buy_threshold": 31,
    }

    asyncio.run(
        update_bot_controller_config(
            _Client(controllers),
            "paper-bot",
            "operator-visible-id",
            payload,
            confirm_override=True,
        )
    )

    assert controllers.updates == [
        (
            "paper-bot",
            "paper-rsi-v7",
            {
                "id": "operator-visible-id",
                "controller_type": "directional_trading",
                "controller_name": "rsi_v7",
                "rsi_buy_threshold": 31,
            },
        )
    ]
