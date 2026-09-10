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


def is_managed_rsi_controller(controller_name: str) -> bool:
    name = controller_name.strip().lower()
    return name.startswith("rsi_") or name.startswith("hyperliquid_portfolio_rsi")


async def load_deployable_controller_types(client: Any) -> dict[str, list[str]]:
    """Return only schema-backed controllers, using the additive catalog when available."""
    try:
        payload = await client.controllers._get("/controllers/catalog")
        rows = payload.get("controllers", []) if isinstance(payload, dict) else []
        grouped: dict[str, list[str]] = defaultdict(list)
        for row in rows:
            if not isinstance(row, dict) or row.get("deployable") is not True:
                continue
            controller_type = str(row.get("controller_type", ""))
            controller_name = str(row.get("controller_name", ""))
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
    controller_type = str(clean.get("controller_type", "")).strip()
    controller_name = str(clean.get("controller_name", "")).strip()
    if not controller_type or not controller_name:
        raise ValueError("controller_type and controller_name are required")
    await client.controllers.validate_controller_config(
        controller_type, controller_name, clean
    )
    return clean


async def resolve_controller_names(
    client: Any, config_names: Iterable[str]
) -> list[str]:
    """Resolve stable config filenames to controller names, failing on ambiguity."""
    requested = [str(name) for name in config_names]
    configs = await client.controllers.list_controller_configs()
    if not isinstance(configs, list):
        raise ValueError("Controller config catalog is unavailable")
    by_identity: dict[str, str] = {}
    for config in configs:
        if not isinstance(config, dict):
            continue
        controller_name = str(config.get("controller_name", ""))
        identities = {
            str(config.get(key, ""))
            for key in ("_config_name", "config_base_name", "id")
        }
        for identity in identities - {""}:
            if identity in by_identity and by_identity[identity] != controller_name:
                raise ValueError(f"Ambiguous controller config identity: {identity}")
            by_identity[identity] = controller_name
    missing = [name for name in requested if not by_identity.get(name)]
    if missing:
        raise ValueError(f"Controller config identity not found: {', '.join(missing)}")
    return [by_identity[name] for name in requested]


def _positive(value: Any) -> bool:
    try:
        return Decimal(str(value)) > 0
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
    if not any(is_managed_rsi_controller(name) for name in controller_names):
        return
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
