"""Read-only Tradepad store: published backtest bundles, their catalog metadata and the hosted viewer.

Layout of ``CONDOR_TRADEPAD_DIR``::

    bundles/<bundle_id>/bundle.json              tradepad.bundle.v2, served exactly as published
    bundles/<bundle_id>/bundle.meta.json         tradepad.bundle.meta.v1: catalog rows and research refs
    bundles/<bundle_id>/bundle.provenance.json   the bundle builder's receipt
    viewer/viewer.html                           the hosted Tradepad viewer (code only, no data)

rsibot's ``tradepad/publish.py`` writes the store; Condor only reads it. A catalog entry that cannot be read is
reported with its reason instead of being skipped, and a bundle is served only while its bytes match the sha256
recorded in its meta. Directories whose name starts with ``.`` (for example replaced bundles) are not entries.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BUNDLE_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,95}")
META_SCHEMA = "tradepad.bundle.meta.v1"
SHA256 = re.compile(r"[0-9a-f]{64}")
MAX_META_BYTES = 4 * 1024 * 1024
MAX_PROVENANCE_BYTES = 64 * 1024 * 1024
MAX_BUNDLE_BYTES = 1024 * 1024 * 1024
MAX_VIEWER_BYTES = 16 * 1024 * 1024


class TradepadUnavailable(Exception):
    """The store is not configured or its directory is missing."""


class TradepadNotFound(Exception):
    """No published bundle or file with that identity."""


class TradepadIntegrityError(Exception):
    """A published file does not match its recorded identity."""


@dataclass(frozen=True)
class VerifiedFile:
    path: Path
    sha256: str
    size: int


def store_root() -> Path:
    """The configured store directory, or ``TradepadUnavailable`` with the reason."""
    raw = os.environ.get("CONDOR_TRADEPAD_DIR", "")
    if not raw:
        raise TradepadUnavailable("Tradepad store is not configured")
    root = Path(raw)
    if not root.is_dir():
        raise TradepadUnavailable("Tradepad store directory is missing")
    return root


def _reject_constant(name: str) -> Any:
    raise ValueError(f"non-finite number {name}")


def _read_json(path: Path, limit: int) -> Any:
    size = path.stat().st_size
    if size > limit:
        raise ValueError(f"{path.name} is {size} bytes, above the {limit}-byte limit")
    value = json.loads(path.read_bytes(), parse_constant=_reject_constant)
    return value


def _finite(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("non-finite number")
    if isinstance(value, dict):
        for item in value.values():
            _finite(item)
    elif isinstance(value, list):
        for item in value:
            _finite(item)


def read_meta(directory: Path) -> dict[str, Any]:
    """The validated ``bundle.meta.json`` of one bundle directory (``ValueError`` names what is wrong)."""
    path = directory / "bundle.meta.json"
    if not path.is_file():
        raise ValueError("bundle.meta.json is missing")
    meta = _read_json(path, MAX_META_BYTES)
    if not isinstance(meta, dict):
        raise ValueError("bundle.meta.json is not an object")
    if meta.get("schema") != META_SCHEMA:
        raise ValueError(f"bundle.meta.json schema is not {META_SCHEMA}")
    if meta.get("id") != directory.name:
        raise ValueError("bundle.meta.json id does not match its directory")
    if not isinstance(meta.get("bundle_sha256"), str) or not SHA256.fullmatch(
        meta["bundle_sha256"]
    ):
        raise ValueError("bundle_sha256 is not a sha256 hex digest")
    size = meta.get("bundle_bytes")
    if type(size) is not int or not 0 < size <= MAX_BUNDLE_BYTES:
        raise ValueError("bundle_bytes is not a positive size within the limit")
    for key in ("title", "published_utc", "built_utc"):
        if not isinstance(meta.get(key), str) or not meta[key]:
            raise ValueError(f"{key} is missing")
    datasets = meta.get("datasets")
    if not isinstance(datasets, list) or not datasets:
        raise ValueError("datasets is missing or empty")
    for dataset in datasets:
        if not isinstance(dataset, dict) or not isinstance(dataset.get("id"), str):
            raise ValueError("a dataset has no id")
        if not isinstance(dataset.get("strategies"), list):
            raise ValueError(f"dataset {dataset['id']} has no strategies list")
        for row in dataset["strategies"]:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                raise ValueError(
                    f"dataset {dataset['id']} has a strategy row without an id"
                )
    _finite(meta)
    return meta


def catalog(root: Path) -> dict[str, Any]:
    """Every published bundle's meta, newest first, and every entry that could not be read with its reason."""
    bundles_dir = root / "bundles"
    metas: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    if not bundles_dir.is_dir():
        return {"bundles": metas, "errors": errors}
    for entry in sorted(bundles_dir.iterdir(), key=lambda p: p.name):
        if entry.name.startswith("."):
            continue
        if not entry.is_dir() or not BUNDLE_ID.fullmatch(entry.name):
            errors.append(
                {
                    "id": entry.name[:128],
                    "error": "not a bundle directory (lowercase id, digits, . _ -)",
                }
            )
            continue
        try:
            metas.append(read_meta(entry))
        except (OSError, ValueError) as exc:
            errors.append({"id": entry.name, "error": str(exc)[:500]})
    metas.sort(key=lambda meta: (meta["published_utc"], meta["id"]), reverse=True)
    return {"bundles": metas, "errors": errors}


def _sha256(path: Path) -> str:
    """Hash the current bytes; file metadata cannot prove byte identity."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _bundle_dir(root: Path, bundle_id: str) -> Path:
    if not BUNDLE_ID.fullmatch(bundle_id):
        raise TradepadNotFound(bundle_id)
    directory = root / "bundles" / bundle_id
    if not directory.is_dir():
        raise TradepadNotFound(bundle_id)
    return directory


def bundle_file(root: Path, bundle_id: str) -> VerifiedFile:
    """``bundle.json`` of a published bundle after checking its size and sha256 against the meta."""
    directory = _bundle_dir(root, bundle_id)
    try:
        meta = read_meta(directory)
    except (OSError, ValueError) as exc:
        raise TradepadIntegrityError(f"bundle meta is unreadable: {exc}") from exc
    path = directory / "bundle.json"
    if not path.is_file():
        raise TradepadIntegrityError("bundle.json is missing")
    stat = path.stat()
    if stat.st_size != meta["bundle_bytes"]:
        raise TradepadIntegrityError(
            "bundle.json size does not match its published meta"
        )
    digest = _sha256(path)
    if digest != meta["bundle_sha256"]:
        raise TradepadIntegrityError(
            "bundle.json bytes do not match their published sha256"
        )
    return VerifiedFile(path, digest, stat.st_size)


def provenance_file(root: Path, bundle_id: str) -> Path:
    """``bundle.provenance.json`` of a published bundle (it must parse as JSON within the size limit)."""
    path = _bundle_dir(root, bundle_id) / "bundle.provenance.json"
    if not path.is_file():
        raise TradepadNotFound(f"{bundle_id}/bundle.provenance.json")
    try:
        _read_json(path, MAX_PROVENANCE_BYTES)
    except (OSError, ValueError) as exc:
        raise TradepadIntegrityError(f"bundle provenance is unreadable: {exc}") from exc
    return path


def viewer_file(root: Path) -> Path:
    """The hosted viewer page, or ``TradepadNotFound`` when it has not been published."""
    path = root / "viewer" / "viewer.html"
    if not path.is_file():
        raise TradepadNotFound("viewer/viewer.html")
    if path.stat().st_size > MAX_VIEWER_BYTES:
        raise TradepadIntegrityError("viewer.html is above its size limit")
    return path
