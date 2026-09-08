"""Bounded read projection of the existing Research OS knowledge HTTP API."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException

ORIGIN = "http://127.0.0.1:8873/api/knowledge"
MAX_BYTES = 1024 * 1024
DETAIL_MAX_BYTES = 4 * MAX_BYTES
# Match local path tokens inside prose/serialized receipts without treating
# HTTPS URLs or ordinary slash-separated prose as filesystem paths.
LOCAL_LOCATOR = re.compile(
    r"(?<![\w:/])(?:file://)?(?:/[A-Za-z0-9._-]+){2,}[^\s\"'<>]*"
    r"|(?<![\w:/])(?:[A-Za-z]:[\\/]|~/)[^\s\"'<>]+"
)
PARAMETERS = {
    "overview": set(),
    "nodes": {"kind", "q", "family", "lane", "limit", "offset"},
    "node": {"id"},
    "graph": {"id", "limit"},
    "comparisons": {"idea_id"},
    "clusters": set(),
}
KINDS = {
    "artifact_bundle",
    "assessment",
    "claim",
    "decision",
    "evidence",
    "experiment",
    "idea",
    "idea_revision",
    "paper",
    "paper_version",
    "report",
    "run",
    "source",
}
LANES = {"FUTURES", "MIXED", "PROXY", "SPOT", "UNAVAILABLE"}
# Record provenance hashes and origin remain visible; filesystem locators and
# executable/raw payloads do not become a second source-file delivery endpoint.
PRIVATE_FIELDS = {
    "path",
    "event_path",
    "source_root",
    "store",
    "cwd",
    "argv",
    "command",
    "env",
    "environment",
    "password",
    "passphrase",
    "api_key",
    "secret_key",
    "private_key",
    "credentials",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "authorization",
    "cookie",
    "cookies",
    "entrypoints",
    "input_files",
    "snapshot_dir",
    "workspace",
    "html",
    "raw",
    "content",
    "file_path",
    "artifact_path",
    "source_path",
    "output_path",
    "root_path",
}


def validated_parameters(endpoint, pairs):
    if endpoint not in PARAMETERS:
        raise HTTPException(404, "Research route not found")
    parameters = {}
    for key, value in pairs:
        if key in parameters or key not in PARAMETERS[endpoint]:
            raise HTTPException(400, "Unknown or repeated research query parameter")
        maximum = 512 if key in {"id", "idea_id"} else 256
        if len(value) > maximum or any(
            ord(char) < 32 or ord(char) == 127 for char in value
        ):
            raise HTTPException(
                400, "Research query is too long or contains control characters"
            )
        parameters[key] = value
    for key, maximum, default in [("limit", 50, 30), ("offset", 10000, 0)]:
        if key in PARAMETERS[endpoint]:
            value = parameters.get(key, str(default))
            minimum = 1 if key == "limit" else 0
            if (
                not value.isascii()
                or not value.isdecimal()
                or not minimum <= int(value) <= maximum
            ):
                raise HTTPException(
                    400, "Research pagination is outside its allowed bounds"
                )
            parameters[key] = str(int(value))
    if endpoint in {"node", "graph"} and not parameters.get("id", "").strip():
        raise HTTPException(400, "A research node identity is required")
    if endpoint == "comparisons" and not parameters.get("idea_id", "").strip():
        raise HTTPException(400, "A research idea identity is required")
    if parameters.get("kind") and parameters["kind"] not in KINDS:
        raise HTTPException(400, "Unknown research node kind")
    if parameters.get("lane") and parameters["lane"] not in LANES:
        raise HTTPException(400, "Unknown research accounting lane")
    return parameters


def _client():
    return httpx.AsyncClient(timeout=15, follow_redirects=False, trust_env=False)


def _project(value, depth=0):
    if depth > 24:
        raise ValueError("Research payload nesting exceeded")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Research payload contains a nonfinite number")
    if isinstance(value, dict):
        projected = {}
        for key, item in value.items():
            if key.lower() in PRIVATE_FIELDS or key.lower().endswith(
                (
                    "_password",
                    "_secret_key",
                    "_api_key",
                    "_passphrase",
                    "_path",
                    "_argv",
                    "_command",
                    "_token",
                    "_secret",
                    "_dir",
                )
            ):
                continue
            public_key = (
                "local-locator:" + hashlib.sha256(key.encode()).hexdigest()
                if key.startswith(("/", "~/", "file://", "\\\\"))
                or LOCAL_LOCATOR.search(key)
                else key
            )
            if public_key in projected:
                raise ValueError("Research projection key collision")
            projected[public_key] = _project(item, depth + 1)
        return projected
    if isinstance(value, list):
        return [_project(item, depth + 1) for item in value]
    if isinstance(value, str) and (
        value.startswith(("/", "~/", "file://", "\\\\"))
        or re.match(r"^[A-Za-z]:[\\/]", value)
    ):
        return "[local locator withheld]"
    if isinstance(value, str):
        return LOCAL_LOCATOR.sub("[local locator withheld]", value)
    return value


def _node(value):
    return isinstance(value, dict) and all(
        isinstance(value.get(key), str) for key in ("id", "kind", "title", "status")
    )


def _valid_shape(endpoint, data, parameters):
    if not isinstance(data, dict):
        return False
    if endpoint == "comparisons":
        return (
            isinstance(data.get("items"), list)
            and isinstance(data.get("limitations"), list)
            and all(
                isinstance(item, dict)
                and isinstance(item.get("conditions"), dict)
                and all(
                    isinstance(item.get(key), str)
                    for key in (
                        "id",
                        "label",
                        "unit",
                        "metric",
                        "baseline",
                        "comparable_group",
                        "verdict",
                    )
                )
                and type(item.get("value")) in (int, float)
                for item in data["items"]
            )
        )
    if endpoint == "clusters":
        return (
            isinstance(data.get("items"), list)
            and isinstance(data.get("basis"), str)
            and type(data.get("total")) is int
            and data["total"] == len(data["items"])
            and all(
                isinstance(item, dict)
                and isinstance(item.get("family"), str)
                and isinstance(item.get("lane"), str)
                and all(
                    type(item.get(key)) is int and item[key] >= 0
                    for key in ("node_count", "idea_count", "experiment_count")
                )
                for item in data["items"]
            )
        )
    if endpoint == "overview":
        return (
            isinstance(data.get("counts"), dict)
            and all(
                type(value) is int and value >= 0 for value in data["counts"].values()
            )
            and isinstance(data.get("facets"), dict)
            and isinstance(data.get("limitations"), list)
            and isinstance(data.get("freshness"), dict)
            and data["freshness"].get("state") in {"CURRENT", "PENDING", "UNAVAILABLE"}
        )
    if endpoint == "nodes":
        return (
            isinstance(data.get("items"), list)
            and len(data["items"]) <= int(parameters["limit"])
            and all(_node(item) for item in data["items"])
            and type(data.get("total")) is int
            and data["total"] >= 0
            and data.get("limit") == int(parameters["limit"])
            and data.get("offset") == int(parameters["offset"])
        )
    if endpoint == "node":
        return (
            _node(data.get("node"))
            and data["node"]["id"] == parameters["id"]
            and isinstance(data.get("edges"), list)
            and isinstance(data.get("related"), list)
            and all(_node(item) for item in data["related"])
        )
    return (
        isinstance(data.get("nodes"), list)
        and len(data["nodes"]) <= int(parameters["limit"])
        and all(_node(item) for item in data["nodes"])
        and isinstance(data.get("edges"), list)
        and any(item["id"] == parameters["id"] for item in data["nodes"])
        and type(data.get("truncated")) is bool
    )


async def read_research(endpoint, parameters, server):
    upstream_parameters = dict(parameters)
    if endpoint in {"nodes", "node", "graph"}:
        upstream_parameters["projection"] = "summary"
    try:
        async with asyncio.timeout(15):
            async with _client() as client:
                async with client.stream(
                    "GET", ORIGIN + "/" + endpoint, params=upstream_parameters
                ) as response:
                    if response.status_code == 404 and endpoint in {
                        "node",
                        "graph",
                        "comparisons",
                    }:
                        raise HTTPException(404, "Research node not found")
                    if response.status_code != 200:
                        raise HTTPException(
                            502, "Research OS read service is unavailable"
                        )
                    if (
                        response.headers.get("content-type", "").split(";")[0].strip()
                        != "application/json"
                    ):
                        raise ValueError("Expected JSON")
                    payload = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=65536):
                        payload.extend(chunk)
                        if len(payload) > (
                            DETAIL_MAX_BYTES
                            if endpoint in {"graph", "node"}
                            else MAX_BYTES
                        ):
                            raise ValueError("Research response exceeds allowed size")
        data = json.loads(
            payload,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError("Nonfinite JSON")
            ),
        )
        if not _valid_shape(endpoint, data, parameters):
            raise ValueError("Invalid knowledge read model")
        if endpoint == "graph":
            # The native graph includes full evidence records. The graph needs
            # identity/provenance and edges; details stay on the node endpoint.
            data = dict(
                data,
                nodes=[
                    {key: value for key, value in node.items() if key != "data"}
                    for node in data["nodes"]
                ],
            )
        return {
            "data": _project(data),
            "source": {
                "owner": "research_os",
                "server": server,
                "read_only": True,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "projection": "knowledge_records_without_file_locators",
                "freshness_note": "Fetch time is transport observation only. Research indexing freshness is the owner overview.freshness.",
            },
        }
    except HTTPException:
        raise
    except (httpx.HTTPError, TimeoutError, ValueError, TypeError, RecursionError):
        raise HTTPException(
            502, "Research OS returned no usable bounded knowledge observation"
        ) from None
