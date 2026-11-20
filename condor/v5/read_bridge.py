"""Bounded, read-only access to explicitly selected owner projections."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import re
import struct
import zlib
from urllib.parse import parse_qsl, urlencode, urlsplit
from datetime import datetime

import aiohttp
from fastapi import HTTPException
from .config import MAX_STRATEGIES, MAX_SOURCES, MAX_NODES, MAX_EDGES, MAX_STATS_ROWS, READ_BYTE_LIMITS

MAX_BYTES = 64 * 1024 * 1024
TIMEOUT_SECONDS = 20
ID = r"[a-z0-9][a-z0-9._-]{0,95}"
CAMPAIGN = re.compile(r"/api/v1/tradepad/campaigns/(w[0-9]+-[0-9]+)\Z")
BUNDLE = re.compile(rf"/api/v1/tradepad/bundles/({ID})/(asset|bundle|provenance)\Z")


def _number(value):
    return type(value) is int or type(value) is float and math.isfinite(value)


def _pack(value, kinds, count=None):
    formats = {"f64": ("d", 8), "f32": ("f", 4), "i32": ("i", 4), "u16": ("H", 2), "u8": ("B", 1)}
    if not isinstance(value, dict) or not isinstance(value.get("$pack"), str) or value["$pack"] not in kinds or type(value.get("n")) is not int or value["n"] < 0 or not isinstance(value.get("z"), str):
        raise ValueError("bad pack")
    size = formats[value["$pack"]][1] * value["n"]
    if size > MAX_BYTES or (count is not None and value["n"] != count):
        raise ValueError("bad pack length")
    try:
        decoder = zlib.decompressobj()
        raw = decoder.decompress(base64.b64decode(value["z"], validate=True), size + 1)
        if not decoder.eof or decoder.unused_data or len(raw) != size:
            raise ValueError("bad pack stream")
        numbers = struct.iter_unpack("<" + formats[value["$pack"]][0], raw)
        if any(not math.isfinite(number[0]) for number in numbers):
            raise ValueError("nonfinite pack")
    except (ValueError, zlib.error, struct.error) as error:
        raise ValueError("bad pack") from error


def _asset(value, kind):
    if kind == "candles":
        if any(type(value.get(key)) is not int for key in ("t0", "step", "n", "o0")) or value["step"] != 60 or value["n"] < 1 or not _number(value.get("scale")) or value["scale"] <= 0 or not _number(value.get("vk")):
            raise ValueError("bad candle header")
        _pack(value.get("d"), {"i32"}, 4 * value["n"])
        _pack(value.get("qv"), {"u16"}, value["n"])
        check = value.get("check")
        if not isinstance(check, dict) or any(not isinstance(check.get(key), list) or len(check[key]) != 4 or not all(_number(item) for item in check[key]) for key in ("first", "last")) or not _number(check.get("sum_close")):
            raise ValueError("bad candle check")
        return
    metrics, fills, curve = (value.get(key) for key in ("metrics", "fills", "curve"))
    if not all(isinstance(item, dict) for item in (metrics, fills, curve)) or type(fills.get("n")) is not int or fills["n"] < 0 or type(curve.get("t0")) is not int or type(curve.get("step")) is not int or curve["step"] <= 0:
        raise ValueError("bad pair header")
    _pack(curve.get("pnl"), {"f32", "f64"})
    _pack(curve.get("invested"), {"f32", "f64"}, curve["pnl"]["n"])
    if fills["n"]:
        if not isinstance(fills.get("tags"), list) or not fills["tags"] or not all(isinstance(tag, str) for tag in fills["tags"]):
            raise ValueError("bad fill tags")
        for key, kinds in (("t", {"i32"}), ("side", {"u8"}), ("px", {"f64"}), ("qty", {"f64"}), ("fee", {"f64"}), ("tag", {"u8", "u16", "i32"}), ("maker", {"u8"})):
            _pack(fills.get(key), kinds, fills["n"])
        if "owner" in fills:
            owner = fills["owner"]
            if not isinstance(owner, dict) or owner.get("schema") != "original_lot_allocations.v1" or not isinstance(owner.get("ids"), list) or len(owner["ids"]) != fills["n"] or not isinstance(value.get("owner_raw_fills"), list) or len(value["owner_raw_fills"]) != fills["n"] or not isinstance(value.get("owner_buy_fills"), list) or len(value["owner_buy_fills"]) > fills["n"]:
                raise ValueError("bad owner fills")
            for key in ("cost", "realized"):
                _pack(owner.get(key), {"f64"}, fills["n"])


def tradepad_route(raw_path: str, campaign_id: str | None = None) -> tuple[str, str] | None:
    if len(raw_path) > 2048 or any(char in raw_path for char in ("\\", "#")):
        raise HTTPException(400, detail="invalid compatibility read path")
    try:
        parts = urlsplit(raw_path)
    except ValueError:
        raise HTTPException(400, detail="invalid compatibility read path") from None
    if parts.scheme or parts.netloc or "%" in parts.path or not parts.path.startswith("/api/v1/") or any(segment in {".", ".."} for segment in parts.path.split("/")):
        raise HTTPException(400, detail="invalid compatibility read path")
    path = parts.path
    if not (path == "/api/v1/tradepad" or path.startswith("/api/v1/tradepad/")):
        return None
    try:
        params = parse_qsl(parts.query, keep_blank_values=True, max_num_fields=12)
    except ValueError:
        raise HTTPException(400, detail="invalid Tradepad query") from None
    asset_route = BUNDLE.fullmatch(path)
    if asset_route and asset_route.group(2) == "asset":
        if any(raw.split("=", 1)[0] != key for raw, (key, _) in zip(parts.query.split("&"), params)):
            raise HTTPException(400, detail="invalid Tradepad query encoding")
    elif urlencode(params) != parts.query:
        raise HTTPException(400, detail="invalid Tradepad query encoding")
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


def _optional(record: dict, key: str, kind: type) -> bool:
    return key not in record or record[key] is None or isinstance(record[key], kind)


def _timestamp(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except (ValueError, OverflowError):
        return False


def _timestamps(value: dict) -> bool:
    return all(key not in value or value[key] is None or _timestamp(value[key]) for key in ("generated_at", "fresh_until")) and ("built_utc" not in value or value["built_utc"] in (None, "") or _timestamp(value["built_utc"]))


def _strategy(row: object) -> bool:
    if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"] or not isinstance(row.get("label"), str):
        return False
    if not _optional(row, "source_basis", str) or not _optional(row, "source", dict) or not _optional(row, "metrics", dict):
        return False
    source = row.get("source") or {}
    if not _optional(source, "dataset_title", str):
        return False
    metrics = row.get("metrics") or {}
    pnl = metrics.get("pnl")
    return pnl is None or type(pnl) is int or type(pnl) is float and math.isfinite(pnl) or isinstance(pnl, str) and bool(re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", pnl))


def _metadata(row: object) -> bool:
    if not isinstance(row, dict) or not all(_optional(row, key, str) for key in ("id", "title", "dataset_title", "published_utc", "error", "basis")):
        return False
    for key in ("datasets", "sources", "strategies", "metrics_only"):
        if key in row and (not isinstance(row[key], list) or not all(_metadata(item) for item in row[key])):
            return False
    return True


def _cap(rows: object, limit: int, label: str) -> None:
    if isinstance(rows, list) and len(rows) > limit:
        raise HTTPException(503, detail=f"Not connected: owner payload exceeds {limit} {label}")


def _check_caps(kind: str, value: object) -> None:
    if not isinstance(value, dict):
        return
    if kind in ("snapshot", "catalog", "campaigns", "campaign", "bundle"):
        totals = {"strategies": 0, "sources": 0, "datasets": 0}
        pending = [value]
        while pending:
            item = pending.pop()
            if isinstance(item, dict):
                for key, rows in item.items():
                    if isinstance(rows, list):
                        category = {"strategies": "strategies", "metrics_only": "strategies", "sources": "sources", "source_index": "sources", "datasets": "datasets"}.get(key)
                        if category:
                            totals[category] += len(rows)
                        pending.extend(rows)
                    elif isinstance(rows, dict):
                        pending.append(rows)
        for category, limit in (("strategies", MAX_STRATEGIES), ("sources", MAX_SOURCES), ("datasets", MAX_SOURCES)):
            if totals[category] > limit:
                raise HTTPException(503, detail=f"Not connected: owner payload exceeds {limit} {category}")
    if kind == "snapshot":
        _check_caps("catalog", value.get("catalog"))
        _check_caps("campaigns", value.get("campaigns"))
    if kind in ("catalog", "campaigns"):
        rows = value.get("bundles" if kind == "catalog" else "campaigns")
        _cap(rows, MAX_SOURCES, kind + " entries")
        strategy_count = 0
        source_count = 0
        if isinstance(rows, list):
            for row in rows:
                if isinstance(row, dict):
                    _cap(row.get("sources"), MAX_SOURCES, "sources")
                    _cap(row.get("strategies"), MAX_STRATEGIES, "strategies")
                    if isinstance(row.get("sources"), list):
                        source_count += len(row["sources"])
                    if isinstance(row.get("strategies"), list):
                        strategy_count += len(row["strategies"])
                    datasets = row.get("datasets")
                    _cap(datasets, MAX_SOURCES, "datasets")
                    if isinstance(datasets, list):
                        for dataset in datasets:
                            if isinstance(dataset, dict):
                                _cap(dataset.get("strategies"), MAX_STRATEGIES, "strategies")
                                for key in ("strategies", "metrics_only"):
                                    if isinstance(dataset.get(key), list):
                                        strategy_count += len(dataset[key])
        if strategy_count > MAX_STRATEGIES:
            raise HTTPException(503, detail=f"Not connected: owner payload exceeds {MAX_STRATEGIES} strategies")
        if source_count > MAX_SOURCES:
            raise HTTPException(503, detail=f"Not connected: owner payload exceeds {MAX_SOURCES} sources")
    if kind in ("campaign", "bundle"):
        campaign = value.get("campaign")
        if isinstance(campaign, dict):
            _cap(campaign.get("sources"), MAX_SOURCES, "sources")
        datasets = value.get("datasets")
        _cap(datasets, MAX_SOURCES, "datasets")
        source_count = 0
        strategy_count = 0
        if isinstance(datasets, list):
            for dataset in datasets:
                if isinstance(dataset, dict):
                    _cap(dataset.get("source_index"), MAX_SOURCES, "sources")
                    if isinstance(dataset.get("source_index"), list):
                        source_count += len(dataset["source_index"])
                    strategy_count += sum(len(dataset[key]) for key in ("strategies", "metrics_only") if isinstance(dataset.get(key), list))
        if source_count > MAX_SOURCES:
            raise HTTPException(503, detail=f"Not connected: owner payload exceeds {MAX_SOURCES} sources")
        if strategy_count > MAX_STRATEGIES:
            raise HTTPException(503, detail=f"Not connected: owner payload exceeds {MAX_STRATEGIES} strategies")
    if kind == "network":
        _cap(value.get("nodes"), MAX_NODES, "nodes")
        _cap(value.get("edges"), MAX_EDGES, "edges")
        stats = value.get("stats")
        if isinstance(stats, dict):
            if sum(len(rows) for rows in stats.values() if isinstance(rows, list)) > MAX_STATS_ROWS:
                raise HTTPException(503, detail=f"Not connected: owner payload exceeds {MAX_STATS_ROWS} stats rows")
            for rows in stats.values():
                _cap(rows, MAX_STATS_ROWS, "stats rows")
    if kind == "overview":
        facets = value.get("facets")
        if isinstance(facets, dict):
            if sum(len(rows) for rows in facets.values() if isinstance(rows, list)) > MAX_STATS_ROWS:
                raise HTTPException(503, detail=f"Not connected: owner payload exceeds {MAX_STATS_ROWS} facet rows")
            for rows in facets.values():
                _cap(rows, MAX_STATS_ROWS, "facet rows")
        _cap(value.get("limitations"), MAX_STATS_ROWS, "limitations")


def valid_tradepad(kind: str, value: object) -> bool:
    if not isinstance(value, dict) or not _timestamps(value):
        return False
    if kind == "catalog":
        return value.get("schema") == "condor.tradepad.catalog.v1" and isinstance(value.get("bundles"), list) and all(_metadata(row) for row in value["bundles"]) and isinstance(value.get("errors"), list) and all(_metadata(row) for row in value["errors"])
    if kind == "campaigns":
        return value.get("schema") == "condor.tradepad.campaigns.v1" and isinstance(value.get("campaigns"), list) and all(_metadata(row) for row in value["campaigns"]) and isinstance(value.get("errors"), list) and all(_metadata(row) for row in value["errors"])
    if kind == "snapshot":
        return value.get("schema") == "condor.tradepad.snapshot.v1" and isinstance(value.get("snapshot_sha256"), str) and bool(re.fullmatch(r"[a-f0-9]{64}", value["snapshot_sha256"])) and valid_tradepad("catalog", value.get("catalog")) and valid_tradepad("campaigns", value.get("campaigns"))
    if kind == "campaign":
        datasets = value.get("datasets")
        campaign = value.get("campaign")
        if value.get("schema") != "tradepad.bundle.v2" or value.get("delivery") != "deferred-assets-v1" or not isinstance(campaign, dict) or not isinstance(campaign.get("id"), str) or not isinstance(datasets, list) or len(datasets) != 1 or not isinstance(datasets[0], dict):
            return False
        dataset = datasets[0]
        rows = dataset.get("strategies"), dataset.get("metrics_only")
        return _metadata(campaign) and dataset.get("id") == campaign["id"] and _optional(dataset, "title", str) and isinstance(dataset.get("source_index"), list) and all(_metadata(row) for row in dataset["source_index"]) and all(isinstance(group, list) and all(_strategy(row) for row in group) for group in rows)
    if kind == "bundle":
        return value.get("schema") == "tradepad.bundle.v2" and isinstance(value.get("datasets"), list) and all(_metadata(row) for row in value["datasets"])
    if kind == "provenance":
        return value.get("schema") == "tradepad.bundle.v2.provenance" and isinstance(value.get("bundle_sha256"), str) and bool(re.fullmatch(r"[a-f0-9]{64}", value["bundle_sha256"]))
    return bool(value)


async def _bounded_read(base_url: str | None, path: str, owner: str, setting: str, kind: str) -> bytes:
    if not base_url:
        raise HTTPException(503, detail=f"Not connected: {setting} is unset")
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=TIMEOUT_SECONDS)) as session:
                async with session.get(base_url + path, allow_redirects=False, headers={"Accept": "application/json"}) as response:
                    if response.status != 200:
                        raise HTTPException(503, detail=f"Not connected: {owner} upstream returned HTTP {response.status}")
                    content = bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        if len(content) + len(chunk) > min(MAX_BYTES, READ_BYTE_LIMITS[kind]):
                            raise HTTPException(503, detail=f"Not connected: {owner} response too large")
                        content.extend(chunk)
        return bytes(content)
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
        raise HTTPException(503, detail=f"Not connected: {owner} upstream unreachable or timed out") from None


async def read_tradepad(base_url: str | None, path: str, kind: str) -> bytes:
    raw = await _bounded_read(base_url, path, "Tradepad", "V5_TRADEPAD_URL", kind)
    try:
        value = json.loads(raw, parse_constant=_reject_constant)
        _check_caps(kind, value)
        if not valid_tradepad(kind, value):
            raise ValueError("bad shape")
        if kind == "campaign" and value["campaign"]["id"] != CAMPAIGN.fullmatch(urlsplit(path).path).group(1):
            raise ValueError("campaign identity mismatch")
        if kind == "asset":
            params = dict(parse_qsl(urlsplit(path).query))
            if hashlib.sha256(raw).hexdigest() != params["sha256"]:
                raise ValueError("asset hash mismatch")
            _asset(value, params["kind"])
        return raw
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(503, detail="Not connected: Tradepad response has bad shape") from None


def research_route(raw_path: str) -> tuple[str, str] | None:
    try:
        parts = urlsplit(raw_path)
    except ValueError:
        raise HTTPException(400, detail="invalid Research path") from None
    if parts.scheme or parts.netloc or parts.fragment or "\\" in raw_path or "%" in parts.path or any(segment in {".", ".."} for segment in parts.path.split("/")):
        raise HTTPException(400, detail="invalid Research path")
    allowed = {"/api/v1/research/overview": "overview", "/api/v1/research/network": "network"}
    kind = allowed.get(parts.path)
    if kind is None:
        return None
    try:
        query = parse_qsl(parts.query, keep_blank_values=True, max_num_fields=2)
    except ValueError:
        raise HTTPException(400, detail="invalid Research query") from None
    if urlencode(query) != parts.query:
        raise HTTPException(400, detail="invalid Research query encoding")
    if query not in ([], [("server", "rsibot-v5")]):
        raise HTTPException(400, detail="invalid Research scope")
    return "/api/knowledge/" + kind, kind


def valid_research(kind: str, value: object) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get("revision"), str) or not value["revision"]:
        return False
    if kind == "overview":
        if not _timestamp(value.get("generated_at")) or not _timestamps(value):
            return False
        freshness = value.get("freshness")
        if freshness is not None:
            if not isinstance(freshness, dict) or not all(_optional(freshness, key, str) for key in ("state", "freshness_basis", "last_sync", "verification_checked_at")):
                return False
            if freshness.get("state") is not None and freshness["state"] not in {"CURRENT", "PENDING", "UNAVAILABLE"}:
                return False
            if freshness.get("verification_checked_at") is not None and not _timestamp(freshness["verification_checked_at"]):
                return False
            pending = freshness.get("pending_events")
            if pending is not None and (type(pending) is not int or not 0 <= pending <= 2**53 - 1):
                return False
            for key in ("verification_age_seconds", "max_verification_age_seconds"):
                number = freshness.get(key)
                if number is not None and (type(number) not in (int, float) or number < 0 or number > 2**53 - 1 or type(number) is float and not math.isfinite(number)):
                    return False
        counts, facets, limitations = value.get("counts"), value.get("facets"), value.get("limitations")
        return isinstance(counts, dict) and all(type(count) is int and 0 <= count <= 2**53 - 1 for count in counts.values()) and isinstance(facets, dict) and all(isinstance(rows, list) and all(isinstance(item, str) for item in rows) for rows in facets.values()) and isinstance(limitations, list) and all(isinstance(item, str) for item in limitations)
    nodes, edges = value.get("nodes"), value.get("edges")
    missing = value.get("unresolved_edges")
    if value.get("node_fields") != ["id", "kind", "title", "family", "lane"] or value.get("edge_fields") != ["source", "target", "relation", "basis"] or not isinstance(nodes, list) or not isinstance(edges, list) or type(missing) is not int or not 0 <= missing <= 2**53 - 1 or type(value.get("total_nodes")) is not int or type(value.get("total_edges")) is not int or value.get("total_nodes") != len(nodes) or value.get("total_edges") != len(edges) + missing or value["total_edges"] > 2**53 - 1:
        return False
    ids = set()
    for node in nodes:
        if not isinstance(node, list) or len(node) != 5 or any(not isinstance(item, str) for item in node) or not node[0] or node[0] in ids:
            return False
        ids.add(node[0])
    for edge in edges:
        if not isinstance(edge, list) or len(edge) != 4 or any(type(index) is not int or index < 0 or index >= len(nodes) for index in edge[:2]) or any(not isinstance(item, str) for item in edge[2:]):
            return False
    stats = value.get("stats")
    if not isinstance(stats, dict):
        return False
    for key, total in (("kinds", len(nodes)), ("families", len(nodes)), ("lanes", len(nodes)), ("relations", len(edges) + missing)):
        rows = stats.get(key)
        if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get("key"), str) or type(row.get("count")) is not int or not 0 <= row["count"] <= 2**53 - 1 for row in rows) or sum(row["count"] for row in rows) != total:
            return False
    return True


async def read_research(base_url: str | None, path: str, kind: str) -> bytes:
    raw = await _bounded_read(base_url, path, "Research", "V5_RESEARCH_URL", kind)
    try:
        value = json.loads(raw, parse_constant=_reject_constant)
        _check_caps(kind, value)
        if not valid_research(kind, value):
            raise ValueError("bad shape")
        return raw
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(503, detail="Not connected: Research response has bad shape") from None
