"""Reads the fleet Market index inputs the way the app's ``FleetMarketLoader`` does, server side.

For one server: the registered reporting sources (``CONDOR_TRADING_VISUALS_SOURCES``, the same
sources, client and credentials the ``/api/v1/trading-visuals`` proxy uses), each bot's pair
membership from its composite page (``chart_mode=composite_rsi_v5``, 1d; cached for an hour),
then every (bot, pair) series (1d, 1m, ``compact=false``, ``projection=ohlc``), at most four
requests at a time under one overall deadline. ``condor.push.market_index`` builds the index;
the result is the Live Activity ``market_index`` object. Any failure raises
``MarketIndexUnavailable``: the caller omits the object, it never fabricates one. Only the
publisher builds; the content route serves what the publisher last built.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, Callable

import httpx

from condor.push import market_index as mi
from condor.web.routes import trading_visuals

COMPOSITE_MODE = "composite_rsi_v5"
MEMBERSHIP_TTL_SECONDS = 3600.0
READ_CONCURRENCY = 4
INDEX_TIMEOUT_SECONDS = 35.0  # well under the publisher interval budget (<= 40 s)
MAX_BOTS = 32
MAX_JOBS = 128
INTERVAL = "1m"
INTERVAL_SECONDS = 60
_SAFE_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}")

# (server, bot) -> (read at, sorted pairs). Only successful reads are kept.
_membership: dict[tuple[str, str], tuple[float, list[str]]] = {}
# server -> (published at, market_index object): the last good index the publisher built in
# this process. The publisher reuses it for a failed pass; the content route serves it.
_published: dict[str, tuple[float, dict[str, Any]]] = {}

# A failed pass keeps showing the last good index while it is younger than this.
REUSE_MAX_AGE_MS = 180_000


class MarketIndexUnavailable(RuntimeError):
    """The index could not be built; the message is safe to log."""


def _reject_constant(name: str) -> Any:
    raise ValueError(
        f"non-JSON number {name}"
    )  # Swift's JSONDecoder rejects NaN/Infinity


async def _read(client: httpx.AsyncClient, source: dict, params: dict) -> Any:
    async with client.stream(
        "GET",
        source["url"].rstrip("/") + "/chart-series",
        params=params,
        auth=trading_visuals.source_auth(source),
    ) as upstream:
        if upstream.status_code != 200:
            raise MarketIndexUnavailable(f"chart-series HTTP {upstream.status_code}")
        body = bytearray()
        async for chunk in upstream.aiter_bytes():
            if len(body) + len(chunk) > trading_visuals.REPORTING_MAX_BYTES:
                raise MarketIndexUnavailable("chart-series response too large")
            body.extend(chunk)
    return json.loads(bytes(body), parse_constant=_reject_constant)


def _pairs_from_page(page: Any, bot: str) -> list[str]:
    """``page.coverage.expectedPairs + page.componentPairs``, de-duplicated and sorted."""
    if not isinstance(page, dict) or page.get("chart_mode") != COMPOSITE_MODE:
        raise MarketIndexUnavailable("composite page has another chart mode")
    if page.get("bot_name") not in (None, "", bot):
        raise MarketIndexUnavailable("composite page belongs to another bot")
    coverage = page.get("coverage") if isinstance(page.get("coverage"), dict) else {}
    found: list[str] = []
    for raw in (coverage.get("expected_pairs"), page.get("component_pairs")):
        if raw is None:
            continue
        if not isinstance(raw, list) or not all(isinstance(p, str) for p in raw):
            raise MarketIndexUnavailable("composite page pairs are invalid")
        found.extend(raw)
    return sorted(set(found))


async def _bot_pairs(
    client: httpx.AsyncClient, server: str, bot: str, source: dict, now: float
) -> list[str] | None:
    cached = _membership.get((server, bot))
    if cached is not None and 0 <= now - cached[0] < MEMBERSHIP_TTL_SECONDS:
        return cached[1]
    try:
        page = await _read(
            client,
            source,
            {
                "bot": bot,
                "chart_mode": COMPOSITE_MODE,
                "time_range": "1d",
                "interval": INTERVAL,
            },
        )
        pairs = _pairs_from_page(page, bot)
    except (MarketIndexUnavailable, httpx.HTTPError, ValueError):
        return None  # as in the app: this bot adds no pairs, the others still count
    if not pairs:
        return None
    _membership[(server, bot)] = (now, pairs)
    return pairs


async def _pair_input(
    client: httpx.AsyncClient,
    bot: str,
    pair: str,
    source: dict,
    clock: Callable[[], float],
) -> mi.Input | None:
    if not _SAFE_SEGMENT.fullmatch(pair):
        return None
    try:
        raw = await _read(
            client,
            source,
            {
                "bot": bot,
                "pair": pair,
                "time_range": "1d",
                "interval": INTERVAL,
                "compact": "false",
                "projection": "ohlc",
            },
        )
        series = mi.decode_series(raw)
    except (MarketIndexUnavailable, httpx.HTTPError, ValueError):
        return None
    # The app's client rejects a response whose identity differs from the request.
    if (
        (series.pair is not None and series.pair != pair)
        or (series.bot_name is not None and series.bot_name != bot)
        or (series.interval is not None and series.interval != INTERVAL)
    ):
        return None
    return mi.Input(bot, pair, series, INTERVAL_SECONDS, mi.date(clock()))


async def _bounded(jobs: list[Callable[[], Any]]) -> list[Any]:
    """Run the jobs at most READ_CONCURRENCY at a time, results in job order."""
    semaphore = asyncio.Semaphore(READ_CONCURRENCY)

    async def one(job):
        async with semaphore:
            return await job()

    return await asyncio.gather(*(one(job) for job in jobs))


async def build_market_index(
    server: str, *, clock: Callable[[], float] = time.time
) -> dict[str, Any]:
    """The ``market_index`` object for one server; raises ``MarketIndexUnavailable``."""
    try:
        sources = trading_visuals._sources()
    except Exception:  # noqa: BLE001 - an HTTPException from the shared validator
        raise MarketIndexUnavailable("trading-visuals sources are invalid") from None
    registered = [
        (bot, source) for bot, source in sources.items() if source["server"] == server
    ]
    if not registered:
        raise MarketIndexUnavailable("no registered strategies on this server")
    if len(registered) > MAX_BOTS:
        raise MarketIndexUnavailable("too many registered strategies")
    try:
        async with asyncio.timeout(INDEX_TIMEOUT_SECONDS):
            async with trading_visuals._client() as client:
                now = clock()
                memberships = await _bounded(
                    [
                        (
                            lambda bot=bot, source=source: _bot_pairs(
                                client, server, bot, source, now
                            )
                        )
                        for bot, source in registered
                    ]
                )
                jobs = [
                    (bot, pair, source)
                    for (bot, source), pairs in zip(registered, memberships)
                    for pair in pairs or []
                ]
                if len(jobs) > MAX_JOBS:
                    raise MarketIndexUnavailable("too many strategy/pair sources")
                expected = sorted({pair for _, pair, _ in jobs})
                reads = await _bounded(
                    [
                        (
                            lambda bot=bot, pair=pair, source=source: _pair_input(
                                client, bot, pair, source, clock
                            )
                        )
                        for bot, pair, source in jobs
                    ]
                )
    except TimeoutError:
        raise MarketIndexUnavailable(
            "market index reads exceeded their deadline"
        ) from None
    inputs = [item for item in reads if item is not None]
    if not inputs:
        raise MarketIndexUnavailable("no recorded pair data was available")
    built_at = clock()
    now_date = mi.date(built_at)
    headline = mi.headline(mi.build(inputs, expected, now_date), now_date)
    if headline is None:
        raise MarketIndexUnavailable("the index has no point")
    return headline


def remember_index(server: str, headline: dict[str, Any], *, now: float) -> None:
    """The publisher keeps the last good index per server (``now`` in epoch seconds)."""
    _published[server] = (now, dict(headline))


def _aged(headline: dict[str, Any], published_at: float, now: float) -> dict[str, Any]:
    """The stored index with ``stale`` recomputed by the headline's 300 s rule: its age now is
    ``source_age_ms`` at build plus the time since; an unknown age is stale."""
    age_ms = headline.get("source_age_ms")
    if isinstance(age_ms, bool) or not isinstance(age_ms, int):
        old = True
    else:
        age = age_ms / 1000 + max(0.0, now - published_at)
        old = age > mi.HEADLINE_STALE_AFTER_SECONDS
    return {**headline, "stale": bool(headline["stale"] or old)}


def reusable_index(server: str, *, now: float) -> dict[str, Any] | None:
    """For a pass whose build failed: the last good index while its as-of is < 180 s old."""
    hit = _published.get(server)
    if hit is None:
        return None
    if not 0 <= now * 1000 - hit[1]["as_of_ms"] < REUSE_MAX_AGE_MS:
        return None
    return _aged(hit[1], hit[0], now)


def published_index(
    server: str, *, max_age_seconds: float, now: float
) -> dict[str, Any] | None:
    """For the content route: the last published index when published within
    ``max_age_seconds``; never built on demand."""
    hit = _published.get(server)
    if hit is None or not 0 <= now - hit[0] <= max_age_seconds:
        return None
    return _aged(hit[1], hit[0], now)
