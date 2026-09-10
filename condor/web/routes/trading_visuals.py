"""Authenticated, server-scoped reads from explicit local reporting sources."""

from __future__ import annotations

import asyncio
import json
import os
import re
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from config_manager import get_config_manager

router = APIRouter(prefix='/trading-visuals', tags=['trading-visuals'])
REPORTING_MAX_BYTES = 16 * 1024 * 1024
REPORTING_TOTAL_TIMEOUT = 20.0
READ_ROUTES = frozenset({
    'operations', 'health', 'bootstrap', 'overview', 'bots', 'orders', 'fills', 'executors',
    'positions', 'pnl-series', 'attribution', 'incidents', 'trade-journal',
    'activity-tape', 'operator-summary', 'chart-series', 'drilldown',
})


def _sources() -> dict[str, dict[str, str]]:
    try:
        sources = json.loads(os.environ.get('CONDOR_TRADING_VISUALS_SOURCES', '{}'))
        if not isinstance(sources, dict):
            raise ValueError('Expected mapping')
        for bot, source in sources.items():
            if not re.fullmatch(r'[A-Za-z0-9_-]+', bot) or not isinstance(source, dict):
                raise ValueError('Invalid bot source')
            server, url = source['server'], source['url']
            parsed = urlsplit(url)
            if (not isinstance(server, str) or not server or parsed.scheme != 'http'
                    or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}
                    or parsed.username or parsed.password or parsed.query or parsed.fragment
                    or parsed.path.rstrip('/') not in {'/api/v1', '/trading-visuals'}):
                raise ValueError('Expected explicit loopback reporting endpoint')
            _ = parsed.port  # reject malformed port before constructing a request
            auth_keys = (source.get('username_env'), source.get('password_env'))
            if any(auth_keys) and not all(
                isinstance(key, str) and re.fullmatch(r'[A-Z][A-Z0-9_]+', key)
                and os.environ.get(key) for key in auth_keys
            ):
                raise ValueError('Missing configured backend credentials')
        return sources
    except (ValueError, TypeError, KeyError, AttributeError):
        raise HTTPException(503, 'Trading Visuals source configuration is invalid') from None


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=30, follow_redirects=False, trust_env=False)


@router.get('/sources')
async def list_sources(user: WebUser = Depends(get_current_user)):
    cm = get_config_manager()
    return {'sources': [
        {'bot': bot, 'server': source['server']}
        for bot, source in _sources().items()
        if cm.has_server_access(user.id, source['server'])
    ]}


@router.get('/{path:path}')
async def read_visuals(path: str, request: Request, user: WebUser = Depends(get_current_user)):
    if path == 'operations' and not get_config_manager().is_admin(user.id):
        raise HTTPException(403, 'Operations requires administrator access')
    download = re.fullmatch(r'export/(orders|executors)\.(csv|json)', path)
    if path not in READ_ROUTES and not re.fullmatch(r'drilldown/[a-f0-9]+', path) and not download:
        raise HTTPException(404, 'Trading Visuals route not found')
    bots = request.query_params.getlist('bot')
    if len(bots) > 1:
        raise HTTPException(400, 'Specify one monitoring bot')
    bot = bots[0] if bots else 'ok_rsi'
    source = _sources().get(bot)
    if source is None or not get_config_manager().has_server_access(user.id, source['server']):
        raise HTTPException(404, 'Monitoring source not found')
    try:
        auth = None
        if source.get('username_env'):
            auth = httpx.BasicAuth(
                os.environ[source['username_env']], os.environ[source['password_env']],
            )
        async with asyncio.timeout(REPORTING_TOTAL_TIMEOUT):
            async with _client() as client:
                async with client.stream(
                    'GET', source['url'].rstrip('/') + '/' + path,
                    params=request.query_params.multi_items(), auth=auth,
                ) as upstream:
                    if 300 <= upstream.status_code < 400:
                        raise HTTPException(502, 'Reporting backend returned an unexpected redirect')
                    content = bytearray()
                    async for chunk in upstream.aiter_bytes():
                        if len(content) + len(chunk) > REPORTING_MAX_BYTES:
                            raise HTTPException(502, 'Reporting response exceeds the 16 MiB limit')
                        content.extend(chunk)
        headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}
        if download:
            headers['Content-Disposition'] = f'attachment; filename="{path.split("/")[-1]}"'
        return Response(
            content=bytes(content), status_code=upstream.status_code,
            media_type=upstream.headers.get('content-type', 'application/json'), headers=headers,
        )
    except TimeoutError:
        raise HTTPException(502, 'Reporting backend exceeded the total request deadline') from None
    except httpx.HTTPError:
        raise HTTPException(502, 'Reporting backend unavailable') from None
