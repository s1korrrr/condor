"""Transform Fleet API records into Condor rows. Display only."""
from __future__ import annotations


def to_fleet_row(snapshot: dict) -> dict:
    identity = snapshot.get("identity") or {}
    return {
        "bot_key": snapshot.get("bot_key"),
        "authority_id": identity.get("authority_id"),
        "stack_id": identity.get("stack_id"),
        "bot_instance_id": identity.get("bot_instance_id"),
        "display_name": snapshot.get("display_name") or (snapshot.get("descriptor") or {}).get("presentation", {}).get("display_name"),
        "execution_mode": snapshot.get("execution_mode") or (snapshot.get("descriptor") or {}).get("execution_mode"),
        "stack_generation": snapshot.get("stack_generation") or (snapshot.get("descriptor") or {}).get("stack_generation"),
        "identity_verified": snapshot.get("identity_verified") is True,
        "registration": snapshot.get("registration"),
        "reason_code": snapshot.get("reason_code"),
        "query_key": (
            identity.get("authority_id"),
            identity.get("stack_id"),
            identity.get("bot_instance_id"),
            snapshot.get("catalogue_revision"),
        ),
    }


def select_default(rows: list[dict]) -> list[dict]:
    v2 = [row for row in rows if row.get("stack_generation") == "modular_v2"]
    legacy = [row for row in rows if row.get("stack_generation") == "legacy_v1"]
    return v2 + legacy


def fleet_page(snapshots: list[dict]) -> dict:
    rows = [to_fleet_row(item) for item in snapshots]
    return {
        "bots": select_default(rows) or rows,
        "aggregated_pnl": None,
        "command_available": False,
    }


def catalogue_from_sources(sources: dict) -> dict:
    """Build a Fleet page from config.json bots / CONDOR_TRADING_VISUALS_SOURCES."""
    snapshots = []
    for name, source in (sources or {}).items():
        if not isinstance(source, dict):
            continue
        stack = source.get("stack_id") or ("rsibot-stack-v2" if str(name).endswith("_v2") else "rsibot-stack")
        snapshots.append(
            {
                "bot_key": name,
                "display_name": name,
                "execution_mode": source.get("execution_mode"),
                "stack_generation": "modular_v2" if stack == "rsibot-stack-v2" else "legacy_v1",
                "identity": {
                    "authority_id": source.get("server") or "condor",
                    "stack_id": stack,
                    "bot_instance_id": name,
                },
                "identity_verified": False,
                "reason_code": "owner_unobserved",
            }
        )
    return fleet_page(snapshots)
