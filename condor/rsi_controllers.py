"""Schema-driven integration helpers for rsibot's managed RSI controllers.

Strategy logic remains owned by Hummingbot.  Condor consumes Hummingbot API
schemas and enforces operator-boundary checks before config or deployment
mutations.
"""

from __future__ import annotations

import asyncio
import re
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

from condor.controller_configs import clean_config_for_save, controller_config_identity

NATIVE_CONTROLLERS = frozenset({"modular_spot", "modular_ok_rsi", "modular_rsi_v5", "rsi_modular"})


def require_explicit_profile(config: dict[str, Any]) -> None:
    """Check routing identity only; the native API validates strategy parameters."""
    if config.get("controller_name") == "rsi_modular" and config.get("profile") not in ("ok_rsi", "rsi_v5"):
        raise ValueError("RSI Modular requires an explicit ok_rsi or rsi_v5 profile")


async def load_controller_template(client: Any, controller_type: str, controller_name: str,
                                   profile: str | None = None) -> dict:
    if controller_name == "rsi_modular":
        require_explicit_profile({"controller_name": controller_name, "profile": profile})
        # The pinned SDK has no profile argument; use its authenticated transport.
        return await client.controllers._get(
            f"/controllers/{controller_type}/{controller_name}/config/template",
            params={"profile": profile},
        )
    return await client.controllers.get_controller_config_template(controller_type, controller_name)


def is_managed_rsi_controller(controller_name: str) -> bool:
    name = controller_name.strip().lower()
    return (
        name in NATIVE_CONTROLLERS
        or name in {"ok_rsi", "hl_rsi"}
        or name.startswith("rsi_")
        or name.startswith("hyperliquid_portfolio_rsi")
    )


async def load_deployable_controller_types(client: Any) -> dict[str, list[str]]:
    """Return only schema-backed controllers, using the additive catalog when available."""
    try:
        payload = await client.controllers._get("/controllers/catalog")
        rows = payload.get("controllers", []) if isinstance(payload, dict) else []
        grouped: dict[str, list[str]] = defaultdict(list)
        unified = any(isinstance(row, dict) and row.get("deployable") is True
                      and row.get("controller_type") == "generic"
                      and row.get("controller_name") == "rsi_modular" for row in rows)
        for row in rows:
            if not isinstance(row, dict) or row.get("deployable") is not True:
                continue
            controller_type = str(row.get("controller_type", ""))
            controller_name = str(row.get("controller_name", ""))
            # New configurations use one public entry point. Existing configs
            # still load through their original API models and receipts.
            if unified and controller_type == "generic" and controller_name in {"modular_ok_rsi", "modular_rsi_v5"}:
                continue
            if controller_type and controller_name:
                grouped[controller_type].append(controller_name)
        return {key: sorted(set(value)) for key, value in grouped.items()}
    except Exception:
        pass

    legacy = await client.controllers.list_controllers()
    if not isinstance(legacy, dict):
        return {}

    async def probe(controller_type: str, controller_name: str):
        try:
            template = await client.controllers.get_controller_config_template(
                controller_type, controller_name
            )
            if template:
                return controller_type, controller_name
        except Exception:
            return None
        return None

    candidates = [
        (str(controller_type), str(controller_name))
        for controller_type, controller_names in legacy.items()
        if isinstance(controller_names, list)
        for controller_name in controller_names
    ]
    results = await asyncio.gather(*(probe(*candidate) for candidate in candidates))
    grouped = defaultdict(list)
    for result in results:
        if result is not None:
            grouped[result[0]].append(result[1])
    return {key: sorted(set(value)) for key, value in grouped.items()}


async def validate_controller_config_for_write(
    client: Any, config: dict[str, Any]
) -> dict[str, Any]:
    """Normalize and validate a config through its exact API-owned model."""
    clean = clean_config_for_save(config)
    require_explicit_profile(clean)
    controller_type = str(clean.get("controller_type", "")).strip()
    controller_name = str(clean.get("controller_name", "")).strip()
    if not controller_type or not controller_name:
        raise ValueError("controller_type and controller_name are required")
    await client.controllers.validate_controller_config(
        controller_type, controller_name, clean
    )
    return clean


async def resolve_controller_configs(
    client: Any, config_names: Iterable[str]
) -> list[dict]:
    """Resolve exact API config identities and reject conflicting catalog rows."""
    requested = list(config_names)
    if not requested or len(set(requested)) != len(requested):
        raise ValueError("Controller selection is empty or duplicated")
    configs = await client.controllers.list_controller_configs()
    if not isinstance(configs, list):
        raise ValueError("Controller config catalog is unavailable")
    by_identity: dict[str, dict] = {}
    for config in configs:
        if not isinstance(config, dict):
            continue
        identities = {
            str(config.get(key, ""))
            for key in ("_config_name", "config_base_name", "id")
        }
        for identity in identities - {""}:
            if identity in by_identity and by_identity[identity] != config:
                raise ValueError(f"Ambiguous controller config identity: {identity}")
            by_identity[identity] = config
    missing = [
        name
        for name in requested
        if not by_identity.get(name, {}).get("controller_name")
    ]
    if missing:
        raise ValueError(f"Controller config identity not found: {', '.join(missing)}")
    return [by_identity[name] for name in requested]


async def resolve_controller_names(
    client: Any, config_names: Iterable[str]
) -> list[str]:
    return [
        config["controller_name"]
        for config in await resolve_controller_configs(client, config_names)
    ]


async def deploy_controller_bot(client: Any, **parameters) -> dict:
    """Forward the selected native seal through the existing authenticated transport.

    API remains authoritative for model, configuration bytes and image validation.
    The pinned SDK predates this field; never fall back to its unsealed request.
    """
    configs = await resolve_controller_configs(client, parameters["controllers_config"])
    names = [config["controller_name"] for config in configs]
    require_safe_rsi_deployment(
        controller_names=names,
        image=parameters.get("image"),
        max_global_drawdown_quote=parameters.get("max_global_drawdown_quote"),
        max_controller_drawdown_quote=parameters.get("max_controller_drawdown_quote"),
    )
    native = [name in NATIVE_CONTROLLERS for name in names]
    if not any(native):
        return await client.bot_orchestration.deploy_v2_controllers(**parameters)
    if not all(native):
        raise ValueError(
            "Native deployment cannot mix editable and native controller configurations"
        )
    seals = []
    for config in configs:
        require_explicit_profile(config)
        binding = config.get("recipe_binding")
        seal = binding.get("source_sha256") if isinstance(binding, dict) else None
        if not isinstance(seal, str) or not re.fullmatch(r"[0-9a-f]{64}", seal):
            raise ValueError(
                "Native deployment requires a source-bound recipe configuration"
            )
        seals.append(seal)
    if len(set(seals)) != 1:
        raise ValueError("Native deployment requires one common source identity")
    post = getattr(client.bot_orchestration, "_post", None)
    if not callable(post):
        raise ValueError("API client has no authenticated native deployment transport")
    return await post(
        "/bot-orchestration/deploy-v2-controllers",
        json={**parameters, "native_bundle_source_sha256": seals[0]},
    )


def _positive(value: Any) -> bool:
    try:
        number = Decimal(str(value))
        return not isinstance(value, bool) and number.is_finite() and number > 0
    except (InvalidOperation, TypeError, ValueError):
        return False


def _is_pinned_image(image: str | None) -> bool:
    normalized = (image or "").strip()
    if not normalized or any(character.isspace() for character in normalized):
        return False
    if "@" in normalized:
        return bool(re.fullmatch(r"[^@]+@sha256:[0-9a-fA-F]{64}", normalized))
    image_name = normalized.rsplit("/", 1)[-1]
    if ":" not in image_name:
        return False
    tag = image_name.rsplit(":", 1)[-1].lower()
    floating_tags = {"latest", "development", "dev", "main", "master", "edge", "stable"}
    return bool(tag and tag not in floating_tags)


def require_safe_rsi_deployment(
    *,
    controller_names: Iterable[str],
    image: str | None,
    max_global_drawdown_quote: Any,
    max_controller_drawdown_quote: Any,
) -> None:
    """Fail closed on provenance and loss rails for managed RSI deployments."""
    controller_names = list(controller_names)
    if not any(is_managed_rsi_controller(name) for name in controller_names):
        return
    if any(
        name in NATIVE_CONTROLLERS for name in controller_names
    ) and not re.fullmatch(
        r"(?:sha256:[0-9a-f]{64}|[^\s]+@sha256:[0-9a-f]{64})", image or ""
    ):
        raise ValueError(
            "Native modular deployment requires an immutable image ID or digest"
        )
    if not _is_pinned_image(image):
        raise ValueError(
            "Managed RSI deployment requires an explicit pinned Hummingbot image tag or digest"
        )
    if not (
        _positive(max_global_drawdown_quote)
        and _positive(max_controller_drawdown_quote)
    ):
        raise ValueError(
            "Managed RSI deployment requires positive global and per-controller drawdown limits"
        )
    if Decimal(str(max_controller_drawdown_quote)) > Decimal(
        str(max_global_drawdown_quote)
    ):
        raise ValueError("Per-controller drawdown limit cannot exceed the global limit")
