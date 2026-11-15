"""Bounded, read-only access to explicitly selected owner projections."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from urllib.parse import parse_qsl, urlencode, urlsplit

import aiohttp
from fastapi import HTTPException

MAX_BYTES = 64 * 1024 * 1024
TIMEOUT_SECONDS = 20
ID = r"[a-z0-9][a-z0-9._-]{0,95}"
CAMPAIGN = re.compile(r"/api/v1/tradepad/campaigns/(w[0-9]+-[0-9]+)\Z")
BUNDLE = re.compile(rf"/api/v1/tradepad/bundles/({ID})(?:/(asset|bundle|provenance))?\Z")


def tradepad_route(raw_path: str, campaign_id: str | None = None) -> tuple[str, str] | None:
    if len(raw_path) > 2048 or any(char in raw_path for char in ("\\", "#")):
        raise HTTPException(400, detail="invalid compatibility read path")
    parts = urlsplit(raw_path)
    if parts.scheme or parts.netloc or "%" in parts.path or not parts.path.startswith("/api/v1/") or any(segment in {".", ".."} for segment in parts.path.split("/")):
        raise HTTPException(400, detail="invalid compatibility read path")
    path = parts.path
    if not (path == "/api/v1/tradepad" or path.startswith("/api/v1/tradepad/")):
        return None
    try:
        params = parse_qsl(parts.query, keep_blank_values=True, max_num_fields=12)
    except ValueError:
        raise HTTPException(400, detail="invalid Tradepad query") from None
    if path in {"/api/v1/tradepad/catalog", "/api/v1/tradepad/campaigns", "/api/v1/tradepad/snapshot"}:
        if params:
            raise HTTPException(400, detail="unexpected Tradepad query")
        return path, path.rsplit("/", 1)[1]
    if CAMPAIGN.fullmatch(path):
        if not campaign_id:
            raise HTTPException(503, detail="Not connected: V5_TRADEPAD_CAMPAIGN_ID is unset")
        if CAMPAIGN.fullmatch(path).group(1) != campaign_id:
            raise HTTPException(404, detail="Tradepad campaign is outside configured scope")
        keys = [key for key, _ in params]
        if keys.count("delivery") != 1 or ("delivery", "deferred-assets-v1") not in params or any(key not in {"delivery", "snapshot"} for key in keys) or keys.count("snapshot") > 1:
            raise HTTPException(400, detail="Campaign requires deferred-assets-v1 delivery")
        return path + "?" + urlencode(params), "campaign"
    match = BUNDLE.fullmatch(path)
    if match:
        kind = match.group(2) or "bundle"
        if kind != "asset" and params:
            raise HTTPException(400, detail="unexpected Tradepad query")
        if kind == "asset":
            keys = [key for key, _ in params]
            required = {"source", "dataset", "pair", "kind", "sha256"}
            if not required.issubset(keys) or len(keys) != len(set(keys)) or set(keys) - required - {"strategy"} or any(not value or len(value) > 512 for _, value in params):
                raise HTTPException(400, detail="invalid Tradepad asset query")
            values = dict(params)
            if values["kind"] not in {"candles", "pair"} or (values["kind"] == "pair") != ("strategy" in values) or not all(re.fullmatch(r"[a-f0-9]{64}", values[key]) for key in ("source", "sha256")):
                raise HTTPException(400, detail="invalid Tradepad asset identity")
        owner_path = path[:-7] if match.group(2) == "bundle" else path
        return owner_path + ("?" + urlencode(params) if params else ""), kind
    raise HTTPException(404, detail="Tradepad read is not registered")


def _reject_constant(value: str):
    raise ValueError(value)


def valid_tradepad(kind: str, value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if kind == "catalog":
        return value.get("schema") == "condor.tradepad.catalog.v1" and isinstance(value.get("bundles"), list) and isinstance(value.get("errors"), list)
    if kind == "campaigns":
        return value.get("schema") == "condor.tradepad.campaigns.v1" and isinstance(value.get("campaigns"), list) and isinstance(value.get("errors"), list)
    if kind == "snapshot":
        return value.get("schema") == "condor.tradepad.snapshot.v1" and isinstance(value.get("snapshot_sha256"), str) and bool(re.fullmatch(r"[a-f0-9]{64}", value["snapshot_sha256"])) and valid_tradepad("catalog", value.get("catalog")) and valid_tradepad("campaigns", value.get("campaigns"))
    if kind == "campaign":
        datasets = value.get("datasets")
        campaign = value.get("campaign")
        if value.get("schema") != "tradepad.bundle.v2" or value.get("delivery") != "deferred-assets-v1" or not isinstance(campaign, dict) or not isinstance(campaign.get("id"), str) or not isinstance(datasets, list) or len(datasets) != 1 or not isinstance(datasets[0], dict):
            return False
        dataset = datasets[0]
        rows = dataset.get("strategies"), dataset.get("metrics_only")
        return dataset.get("id") == campaign["id"] and isinstance(dataset.get("source_index"), list) and all(isinstance(group, list) and all(isinstance(row, dict) and isinstance(row.get("id"), str) and bool(row["id"]) and isinstance(row.get("label"), str) for row in group) for group in rows)
    if kind == "bundle":
        return value.get("schema") == "tradepad.bundle.v2" and isinstance(value.get("datasets"), list)
    if kind == "provenance":
        return value.get("schema") == "tradepad.bundle.v2.provenance" and isinstance(value.get("bundle_sha256"), str) and bool(re.fullmatch(r"[a-f0-9]{64}", value["bundle_sha256"]))
    return bool(value)


async def read_tradepad(base_url: str | None, path: str, kind: str) -> bytes:
    if not base_url:
        raise HTTPException(503, detail="Not connected: V5_TRADEPAD_URL is unset")
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=TIMEOUT_SECONDS)) as session:
            async with session.get(base_url + path, allow_redirects=False, headers={"Accept": "application/json"}) as response:
                if response.status != 200:
                    raise HTTPException(503, detail=f"Not connected: Tradepad upstream returned HTTP {response.status}")
                content = bytearray()
                async for chunk in response.content.iter_chunked(65536):
                    content.extend(chunk)
                    if len(content) > MAX_BYTES:
                        raise HTTPException(503, detail="Not connected: Tradepad response too large")
        raw = bytes(content)
        value = json.loads(raw, parse_constant=_reject_constant)
        if not valid_tradepad(kind, value):
            raise ValueError("bad shape")
        if kind == "campaign" and value["campaign"]["id"] != CAMPAIGN.fullmatch(urlsplit(path).path).group(1):
            raise ValueError("campaign identity mismatch")
        if kind == "asset":
            params = dict(parse_qsl(urlsplit(path).query))
            if hashlib.sha256(raw).hexdigest() != params["sha256"]:
                raise ValueError("asset hash mismatch")
            if params["kind"] == "candles":
                if any(type(value.get(key)) is not int for key in ("t0", "step", "n", "o0")) or value["step"] != 60 or value["n"] < 1 or any(not isinstance(value.get(key), dict) for key in ("d", "qv", "check")):
                    raise ValueError("bad candle asset shape")
            elif any(not isinstance(value.get(key), dict) for key in ("metrics", "fills", "curve")):
                raise ValueError("bad pair asset shape")
        return raw
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
        raise HTTPException(503, detail="Not connected: Tradepad upstream unreachable or timed out") from None
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(503, detail="Not connected: Tradepad response has bad shape") from None
