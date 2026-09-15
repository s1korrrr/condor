from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from condor.performance_history import history
from condor.web.auth import get_current_user
from condor.web.models import WebUser
from config_manager import get_config_manager

router = APIRouter(tags=["bots"])


@router.get("/servers/{name}/bots/{bot}/performance-history")
def performance_history(
    name: str,
    bot: str,
    range: Literal["1D", "1W", "1M", "ALL"] = Query("1D"),
    user: WebUser = Depends(get_current_user),
):
    if not get_config_manager().has_server_access(user.id, name):
        raise HTTPException(status_code=403, detail="No access to this server")
    return JSONResponse(
        history.read(name, bot, range), headers={"Cache-Control": "no-store"}
    )
