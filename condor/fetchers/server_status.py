"""Fetch server status from Hummingbot API."""

import logging

logger = logging.getLogger(__name__)


async def fetch_server_status(client, **_kw) -> dict:
    """Check API liveness without confusing unsupported accounts with downtime."""
    try:
        from condor.api_health import verify_api_connection
        health = await verify_api_connection(client)
        return {**health, "status": "online"}
    except Exception as e:
        return {"status": "error", "message": str(e)[:80]}
