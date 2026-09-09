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
from fastapi.responses import StreamingResponse

ORIGIN = "http://127.0.0.1:8873/api/knowledge"
MAX_BYTES = 1024 * 1024
DETAIL_MAX_BYTES = 4 * MAX_BYTES
NETWORK_MAX_BYTES = (
    64 * MAX_BYTES
)  # Current complete native topology: 32,566,250 bytes.
ARCHIVE_RECORD_MAX_BYTES = 64 * MAX_BYTES
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
    "network": set(),
    "queue": {"q", "family", "lane", "limit", "offset"},
    "learning": {"q", "family", "lane", "limit", "offset"},
    "unresolved": {"q", "kind", "limit", "offset"},
    "archive": {"q", "kind", "family", "lane", "status", "limit", "offset"},
    "archive-record": {"id"},
    "archive-overview": set(),
    "document": {"scope", "id", "ref"},
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
    for key, maximum, default in [("limit", 50, 30), ("offset", 1_000_000, 0)]:
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
    if (
        endpoint in {"node", "graph", "archive-record", "document"}
        and not parameters.get("id", "").strip()
    ):
        raise HTTPException(400, "A research node identity is required")
    if endpoint == "comparisons" and not parameters.get("idea_id", "").strip():
        raise HTTPException(400, "A research idea identity is required")
    if endpoint == "unresolved" and parameters.get("kind", "") not in {
        "",
        "recorded_gap",
        "unresolved_edge",
    }:
        raise HTTPException(400, "Unknown research evidence gap kind")
    if (
        endpoint not in {"unresolved", "archive"}
        and parameters.get("kind")
        and parameters["kind"] not in KINDS
    ):
        raise HTTPException(400, "Unknown research node kind")
    if (
        endpoint != "archive"
        and parameters.get("lane")
        and parameters["lane"] not in LANES
    ):
        raise HTTPException(400, "Unknown research accounting lane")
    if endpoint == "document" and (
        parameters.get("scope") not in {"node", "archive", "receipt"}
        or not re.fullmatch(r"[0-9a-f]{64}", parameters.get("ref", ""))
    ):
        raise HTTPException(400, "Document requires a bound scope and opaque reference")
    return parameters


def _client():
    return httpx.AsyncClient(timeout=45, follow_redirects=False, trust_env=False)


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
    if isinstance(value, str) and value.endswith("… [preview; full source retained]"):
        return "Preview withheld; full native fields remain in the owner source."
    if isinstance(value, str) and (
        value.lstrip().startswith("{")
        or re.match(r'^\s*\[\s*(?:[\[{"\]\d-]|true|false|null|$)', value)
    ):
        # Native graph compaction serializes nested records into string previews.
        # Apply the same boundary to complete previews; an incomplete container
        # cannot be safely redacted. Preserve string type for existing consumers.
        try:
            decoded = json.loads(value)
        except (ValueError, RecursionError):
            return "Preview withheld; full native fields remain in the owner source."
        return json.dumps(_project(decoded, depth + 1), ensure_ascii=False)
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
    if endpoint == "network":
        return _valid_network(data)
    if endpoint in {"archive", "learning", "queue", "unresolved"}:
        return (
            isinstance(data.get("items"), list)
            and len(data["items"]) <= int(parameters["limit"])
            and all(
                isinstance(item, dict) and isinstance(item.get("id"), str)
                for item in data["items"]
            )
            and type(data.get("total")) is int
            and data["total"] >= len(data["items"])
            and data.get("limit") == int(parameters["limit"])
            and data.get("offset") == int(parameters["offset"])
        )
    if endpoint == "archive-record":
        return (
            isinstance(data.get("record"), dict)
            and data["record"].get("id") == parameters["id"]
            and isinstance(data.get("revision"), str)
            and isinstance(data.get("documents"), list)
        )
    if endpoint == "archive-overview":
        return (
            isinstance(data.get("revision"), str)
            and all(
                isinstance(data.get(key), dict)
                for key in (
                    "counts",
                    "coverage",
                    "preservation",
                    "provenance",
                    "facets",
                )
            )
            and isinstance(data.get("documents"), list)
        )
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


def _valid_network(data):
    nodes, edges = data.get("nodes"), data.get("edges")
    if not (
        isinstance(nodes, list)
        and isinstance(edges, list)
        and isinstance(data.get("revision"), str)
        and data["revision"]
        and data.get("node_fields") == ["id", "kind", "title", "family", "lane"]
        and data.get("edge_fields") == ["source", "target", "relation", "basis"]
        and type(data.get("total_nodes")) is int
        and data["total_nodes"] == len(nodes)
        and type(data.get("unresolved_edges")) is int
        and data["unresolved_edges"] >= 0
        and type(data.get("total_edges")) is int
        and data["total_edges"] == len(edges) + data["unresolved_edges"]
        and isinstance(data.get("stats"), dict)
    ):
        return False
    if not all(
        isinstance(node, list)
        and len(node) == 5
        and all(isinstance(value, str) for value in node)
        for node in nodes
    ):
        return False
    if len({node[0] for node in nodes}) != len(nodes):
        return False
    for key in ("kinds", "relations", "families", "lanes"):
        groups = data["stats"].get(key)
        if not isinstance(groups, list) or not all(
            isinstance(group, dict)
            and isinstance(group.get("key"), str)
            and type(group.get("count")) is int
            and group["count"] >= 0
            for group in groups
        ):
            return False
        expected = data["total_edges"] if key == "relations" else data["total_nodes"]
        if sum(group["count"] for group in groups) != expected:
            return False
    return all(
        isinstance(edge, list)
        and len(edge) == 4
        and all(type(index) is int and 0 <= index < len(nodes) for index in edge[:2])
        and all(isinstance(value, str) for value in edge[2:])
        for edge in edges
    )


async def read_research(endpoint, parameters, server):
    upstream_parameters = dict(parameters)
    if endpoint in {"nodes", "node", "graph"}:
        upstream_parameters["projection"] = "summary"
    try:
        async with asyncio.timeout(
            45
            if endpoint in {"network", "archive", "archive-record", "archive-overview"}
            else 15
        ):
            async with _client() as client:
                async with client.stream(
                    "GET", ORIGIN + "/" + endpoint, params=upstream_parameters
                ) as response:
                    if response.status_code in {403, 404, 409, 413} and endpoint in {
                        "archive",
                        "archive-record",
                        "archive-overview",
                    }:
                        raise HTTPException(
                            response.status_code,
                            "Research archive or source revision is unavailable",
                        )
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
                        maximum = (
                            NETWORK_MAX_BYTES
                            if endpoint == "network"
                            else ARCHIVE_RECORD_MAX_BYTES
                            if endpoint == "archive-record"
                            else DETAIL_MAX_BYTES
                            if endpoint in {"graph", "node", "archive-overview"}
                            else MAX_BYTES
                        )
                        if len(payload) > maximum:
                            if endpoint in {"network", "archive-record"}:
                                raise HTTPException(
                                    413,
                                    "Complete research response exceeds the explicit 64 MiB read limit; no records were silently sampled",
                                )
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
        projected = _project(data)
        if endpoint == "network" and not _valid_network(projected):
            raise ValueError(
                "Research identity cannot be preserved by privacy projection"
            )
        return {
            "data": projected,
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


async def read_research_document(parameters):
    """Stream a record-bound owner file with no path or credential forwarding.

    Documents are never buffered as JSON or silently truncated. Exact declared
    length is checked during delivery; invalid/unknown length fails before 200.
    The browser receives attachment and opaque sandbox policies even for HTML.
    """
    client = _client()
    response = None
    try:
        request = client.build_request(
            "GET",
            ORIGIN + "/document",
            params=parameters,
            headers={"Accept-Encoding": "identity"},
        )
        response = await client.send(request, stream=True)
        if response.status_code in {400, 403, 404, 409, 413}:
            raise HTTPException(
                response.status_code,
                "Research document is unavailable, denied, or belongs to a different source revision",
            )
        if response.status_code != 200:
            raise HTTPException(502, "Research document source is unavailable")
        raw_length = response.headers.get("content-length", "")
        if not raw_length.isascii() or not raw_length.isdecimal():
            raise ValueError("Research document requires a known content length")
        length = int(raw_length)
        if response.headers.get("content-encoding", "identity") != "identity":
            raise ValueError("Research document encoding changes declared byte length")
        media = response.headers.get("content-type", "application/octet-stream")
        if not re.fullmatch(
            r"[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+(?:; charset=utf-8)?", media
        ):
            raise ValueError("Invalid document media type")

        async def content():
            received = 0
            try:
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    received += len(chunk)
                    if received > length:
                        raise RuntimeError(
                            "Research source exceeded its declared length"
                        )
                    yield chunk
                if received != length:
                    raise RuntimeError(
                        "Research source ended before its declared length"
                    )
            finally:
                await response.aclose()
                await client.aclose()

        return StreamingResponse(
            content(),
            headers={
                "Content-Type": media,
                "Content-Length": str(length),
                "Content-Disposition": "attachment",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "Content-Security-Policy": "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
            },
        )
    except (HTTPException, httpx.HTTPError, ValueError, TimeoutError) as error:
        if response is not None:
            await response.aclose()
        await client.aclose()
        if isinstance(error, HTTPException):
            raise
        raise HTTPException(
            502, "Research OS returned no usable document stream"
        ) from None
