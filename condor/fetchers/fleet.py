"""Catalogue-driven Condor rows. Display only; no permissions or orders."""

from condor.fetchers.bots import extract_fleet_items
from condor.fleet_projection import fleet_page, to_fleet_row


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
