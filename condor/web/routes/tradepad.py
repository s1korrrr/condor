"""Tradepad: published backtest bundles for the dashboard and the hosted viewer page.

The API is read-only and authenticated. ``/tradepad`` serves the viewer's code without data (the viewer reads
bundles through the API with the dashboard session), so it needs no authentication of its own.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

from condor import tradepad_store as store
from condor.web.auth import get_current_user
from condor.web.models import WebUser

router = APIRouter(prefix="/tradepad", tags=["tradepad"])
page_router = APIRouter(tags=["tradepad"])

_NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
_REVALIDATE = {
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
}
# The viewer is one self-contained page: inline code, no remote resources, reads only this origin's API.
VIEWER_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
        "img-src data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; "
        "frame-ancestors 'self'"
    ),
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
}


def _root():
    try:
        return store.store_root()
    except store.TradepadUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc


def _etag_matches(header: str, digest: str) -> bool:
    """RFC 9110 weak comparison: the gzip layer may serve the strong tag as ``W/"…"``."""
    for candidate in header.split(","):
        tag = candidate.strip()
        if tag == "*":
            return True
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag == f'"{digest}"':
            return True
    return False


@router.get("/catalog")
async def tradepad_catalog(user: WebUser = Depends(get_current_user)):
    root = _root()
    value = await run_in_threadpool(store.catalog, root)
    return JSONResponse(
        {"schema": "condor.tradepad.catalog.v1", **value}, headers=_NO_STORE
    )


@router.get("/bundles/{bundle_id}")
async def tradepad_bundle(
    bundle_id: str, request: Request, user: WebUser = Depends(get_current_user)
):
    root = _root()
    try:
        verified = await run_in_threadpool(store.bundle_file, root, bundle_id)
    except store.TradepadNotFound as exc:
        raise HTTPException(404, "Tradepad bundle not found") from exc
    except store.TradepadIntegrityError as exc:
        raise HTTPException(409, str(exc)) from exc
    headers = {**_REVALIDATE, "ETag": f'"{verified.sha256}"'}
    if _etag_matches(request.headers.get("if-none-match", ""), verified.sha256):
        return Response(status_code=304, headers=headers)
    return FileResponse(verified.path, media_type="application/json", headers=headers)


@router.get("/bundles/{bundle_id}/provenance")
async def tradepad_provenance(
    bundle_id: str, user: WebUser = Depends(get_current_user)
):
    root = _root()
    try:
        path = await run_in_threadpool(store.provenance_file, root, bundle_id)
    except store.TradepadNotFound as exc:
        raise HTTPException(404, "Tradepad bundle provenance not found") from exc
    except store.TradepadIntegrityError as exc:
        raise HTTPException(409, str(exc)) from exc
    return FileResponse(path, media_type="application/json", headers=_REVALIDATE)


def _unavailable_page(message: str) -> HTMLResponse:
    body = (
        "<!doctype html><meta charset=utf-8><title>Tradepad</title>"
        '<body style="font:14px system-ui;margin:40px">'
        f'<h1>Tradepad</h1><p>{message}</p><p><a href="/">Back to the dashboard</a></p>'
    )
    return HTMLResponse(body, status_code=503, headers=VIEWER_HEADERS)


@page_router.get("/tradepad", include_in_schema=False)
@page_router.get("/tradepad/", include_in_schema=False)
async def tradepad_page():
    try:
        root = store.store_root()
    except store.TradepadUnavailable:
        return _unavailable_page("Tradepad is not configured on this server.")
    try:
        path = await run_in_threadpool(store.viewer_file, root)
    except store.TradepadNotFound:
        return _unavailable_page(
            "The Tradepad viewer has not been published to this server yet."
        )
    except store.TradepadIntegrityError as exc:
        return _unavailable_page(f"The published Tradepad viewer is unusable: {exc}.")
    return FileResponse(
        path, media_type="text/html; charset=utf-8", headers=VIEWER_HEADERS
    )
