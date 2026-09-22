"""Catalogue-driven Condor rows. Display only; no permissions or orders."""

from urllib.parse import quote

from condor.fetchers.bots import extract_fleet_items
from condor.fleet_projection import fleet_page, to_fleet_row


async def read_full_catalogue(client, read_path) -> dict:
    """Read one bounded, complete visible revision or show no catalogue rows."""
    items: list[dict] = []
    seen_cursors: set[str] = set()
    cursor: str | None = None
    revision: str | None = None
    count: int | None = None
    partial = False
    for _ in range(32):
        path = "/fleet/v1/bots?limit=100"
        if cursor is not None:
            path += f"&cursor={quote(cursor, safe='')}"
        payload = await read_path(client, path)
        if not isinstance(payload, dict):
            return {"items": [], "reason_code": "source_unavailable"}
        if payload.get("reason_code"):
            if not items and payload.get("reason_code") == "catalogue_unavailable":
                return payload
            return {"items": [], "reason_code": "source_unavailable"}
        page_revision = payload.get("catalogue_revision")
        page_count = payload.get("count")
        rows = payload.get("items")
        if (
            not isinstance(page_revision, str)
            or not page_revision
            or not isinstance(page_count, int)
            or isinstance(page_count, bool)
            or page_count < 0
            or not isinstance(rows, list)
            or any(not isinstance(row, dict) for row in rows)
            or (revision is not None and revision != page_revision)
            or (count is not None and count != page_count)
        ):
            return {"items": [], "reason_code": "source_unavailable"}
        revision, count = page_revision, page_count
        items.extend(rows)
        partial = partial or payload.get("partial") is True
        next_cursor = payload.get("cursor")
        if next_cursor is None:
            if len(items) != count:
                return {"items": [], "reason_code": "source_unavailable"}
            return {**payload, "items": items, "partial": partial, "cursor": None}
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors or len(items) >= count:
            return {"items": [], "reason_code": "source_unavailable"}
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    return {"items": [], "reason_code": "source_unavailable"}


def catalogue_from_api_payload(payload: dict | None) -> dict:
    if not isinstance(payload, dict):
        page = fleet_page([])
        page["reason_code"] = "catalogue_unavailable"
        return page
    items = extract_fleet_items(payload, enabled=True)
    page = fleet_page(items)
    page["catalogue_revision"] = payload.get("catalogue_revision")
    page["reason_code"] = payload.get("reason_code")
    page["command_available"] = False
    page["aggregated_pnl"] = None
    return page


def adapt_fleet_records(records: list[dict]) -> dict:
    return fleet_page(records)


def adapt_fleet_row(snapshot: dict) -> dict:
    row = to_fleet_row(snapshot)
    row["command_available"] = False
    return row
