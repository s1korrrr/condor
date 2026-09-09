"""Authenticated Research OS reads scoped to one explicitly configured server."""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from condor.research_read import (
    read_research,
    read_research_document,
    validated_parameters,
)
from condor.web.auth import get_current_user
from condor.web.models import WebUser
from config_manager import get_config_manager

router = APIRouter(prefix="/research", tags=["research"])


@router.get("/{endpoint:path}")
async def research_read(
    endpoint: str, request: Request, user: WebUser = Depends(get_current_user)
):
    servers = request.query_params.getlist("server")
    if len(servers) != 1:
        raise HTTPException(400, "Specify exactly one configured research server")
    configured = os.environ.get("CONDOR_RESEARCH_SERVER", "")
    if not configured:
        raise HTTPException(503, "Research knowledge source is not configured")
    server = servers[0]
    if server != configured or not get_config_manager().has_server_access(
        user.id, server
    ):
        raise HTTPException(404, "Research source not found")
    parameters = validated_parameters(
        endpoint,
        [
            (key, value)
            for key, value in request.query_params.multi_items()
            if key != "server"
        ],
    )
    if endpoint == "document":
        return await read_research_document(parameters)
    value = await read_research(endpoint, parameters, server)
    return JSONResponse(
        value,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
