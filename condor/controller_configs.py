"""Pure controller-config normalization and identity helpers."""

from __future__ import annotations

import re
from typing import Any

_ENUM_STR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*[.:][A-Za-z_][A-Za-z0-9_]*$")


def normalize_enum_value(value: Any) -> Any:
    """Normalize stringified enum members recursively for API validation."""
    if isinstance(value, str) and _ENUM_STR_RE.match(value):
        return re.split(r"[.:]", value, maxsplit=1)[1]
    if isinstance(value, dict):
        return {key: normalize_enum_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize_enum_value(item) for item in value]
    return value


def clean_config_for_save(config: dict[str, Any]) -> dict[str, Any]:
    """Strip API metadata and normalize enum values before validation/persistence."""
    return {
        key: normalize_enum_value(value)
        for key, value in config.items()
        if not key.startswith("_")
    }


def controller_config_identity(config: dict[str, Any]) -> str:
    """Return the stable API filename identity, falling back for older servers."""
    return str(
        config.get("_config_name")
        or config.get("config_base_name")
        or config.get("id")
        or ""
    )
