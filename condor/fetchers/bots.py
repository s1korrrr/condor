"""Fetch bot data from Hummingbot API."""

import logging
import math
from typing import Any, Optional

logger = logging.getLogger(__name__)


def extract_bots_list(result: Any) -> list[dict]:
    """Normalize the various API response formats into a list of bot dicts."""
    if result is None:
        logger.warning("Bot status API returned None")
        return []
    if isinstance(result, str):
        logger.warning(
            "Bot status API returned string (possibly HTML error page): %s",
            result[:200],
        )
        return []
    if isinstance(result, dict):
        if result.get("status") == "error":
            logger.warning(
                "Bot status API returned error: %s", result.get("message", result)
            )
            return []
        data = result.get("data", {})
        if isinstance(data, dict):
            return [
                {"bot_name": k, **v} for k, v in data.items() if isinstance(v, dict)
            ]
        elif isinstance(data, list):
            return [b for b in data if isinstance(b, dict)]
        return []
    elif isinstance(result, list):
        return [b for b in result if isinstance(b, dict)]
    logger.warning("Bot status API returned unexpected type: %s", type(result).__name__)
    return []


def _pick_value(live: dict, db: dict, key: str, default: Any = None) -> Any:
    """Merge a field preferring live, by key presence — not truthiness.

    An empty live reading (``0``, ``{}``, ``[]``) is legitimate — a freshly
    redeployed controller has closed nothing and holds no positions — so it must
    win over the DB snapshot instead of falling through to a stale value from a
    previous deploy. Only an absent key falls back to the DB.
    """
    if key in live:
        return live[key]
    return db.get(key, default)


def _pick(live: dict, db: dict, key: str, default: float = 0.0) -> float:
    """Presence-based merge of a numeric field, coerced to float."""
    val = _pick_value(live, db, key, default)
    return float(val if val is not None else default)


def _native_number(performance: dict, field: str) -> Optional[float]:
    """Missing native metrics stay distinct from an explicitly reported zero."""
    value = performance.get(field)
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _native_observation_times(bot: dict) -> dict:
    """Carry source observation times, never renew freshness at HTTP/cache read."""
    threshold = _native_number(bot, "stale_after_seconds")
    threshold = threshold if threshold is not None and 0 < threshold <= 300 else None
    performance_time = _native_number(bot, "received_at")
    performance_time = (
        performance_time
        if performance_time is not None and performance_time > 0
        else None
    )
    lifecycle = bot.get("lifecycle")
    lifecycle = lifecycle if isinstance(lifecycle, dict) else {}
    observation = lifecycle.get("observation")
    observation = observation if isinstance(observation, dict) else {}
    payload = observation.get("payload")
    payload = payload if isinstance(payload, dict) else {}
    heartbeat = bot.get("heartbeat")
    heartbeat = heartbeat if isinstance(heartbeat, dict) else {}
    times = [
        _native_number(observation, "received_at"),
        _native_number(payload, "generated_at"),
        _native_number(heartbeat, "received_at"),
        _native_number(heartbeat, "source_timestamp"),
    ]
    status_time = None
    if lifecycle.get("valid") is True and all(
        value is not None and value > 0 for value in times
    ):
        times[-1] /= 1e6
        status_time = min(times)
    return {
        "performance_received_at": performance_time,
        "performance_stale_after_seconds": threshold,
        "status_received_at": status_time,
        "status_stale_after_seconds": threshold,
    }


def build_bots_page(
    raw_status: Any,
    *,
    ctrl_configs: Optional[dict[str, dict]] = None,
    bot_runs: Optional[dict[str, str]] = None,
    latest_perf: Optional[dict[str, dict]] = None,
) -> dict:
    """Transform raw BOTS_STATUS data into a BotsPageResponse-shaped dict.

    Single source of truth for the {controllers, bots, total_pnl, total_volume}
    transform, shared by the REST route (with enrichment data) and the WS
    broadcast path (without enrichment, so all kwargs degrade to empty maps).

    Args:
        raw_status: Raw bot status API response (any of the shapes handled by
            ``extract_bots_list``).
        ctrl_configs: Controller configs keyed by config id / controller name.
        bot_runs: Deployed-at timestamps keyed by bot name.
        latest_perf: Latest DB performance snapshots keyed by controller_id.
    """
    ctrl_configs = ctrl_configs or {}
    bot_runs = bot_runs or {}
    latest_perf = latest_perf or {}

    bots_list = extract_bots_list(raw_status)
    controllers: list[dict] = []
    bots: list[dict] = []
    total_pnl = 0.0
    total_volume = 0.0
    metrics_available = True

    for bot_data in bots_list:
        bot_name = bot_data.get("bot_name", "")
        bot_status = bot_data.get("status", "unknown")
        performance = bot_data.get("performance", {})
        native = bot_data.get("source") == "native_mqtt"
        if native and (not isinstance(performance, dict) or not performance):
            metrics_available = False
        if (
            bot_data.get("source") == "native_mqtt"
            and bot_data.get("performance_current") is not True
        ):
            # Shared/retained/stale MQTT observations cannot establish current
            # controller identity. Never revive them through DB enrichment.
            performance = {}
            metrics_available = False
        error_logs = bot_data.get("error_logs", [])
        general_logs = bot_data.get("general_logs", [])
        if not isinstance(error_logs, list):
            error_logs = []
        if not isinstance(general_logs, list):
            general_logs = []

        num_controllers = 0

        if isinstance(performance, dict):
            for ctrl_name, ctrl_info in performance.items():
                if not isinstance(ctrl_info, dict):
                    if native:
                        metrics_available = False
                    continue

                num_controllers += 1
                ctrl_status = ctrl_info.get(
                    "status", "unknown" if native else "running"
                )

                # Get config from pre-fetched configs
                ctrl_config = ctrl_configs.get(
                    f"{bot_name}::{ctrl_name}"
                ) or ctrl_configs.get(ctrl_name, {})
                if (
                    not ctrl_config
                    and ctrl_configs.get(f"{bot_name}::__unavailable__")
                    and not (native and ctrl_info.get("status"))
                ):
                    ctrl_status = "unknown"
                if ctrl_config.get("manual_kill_switch") is True:
                    # This flag has controller-specific semantics: some RSI
                    # controllers only block new entries, while others also
                    # stop executors. Never claim runtime shutdown from the
                    # persisted flag alone.
                    ctrl_status = "control_requested"
                config_id = ctrl_config.get("id") or ctrl_config.get(
                    "controller_id", ctrl_name
                )

                # Use latest DB performance if available, fallback to live bot status
                db_snap = (
                    None
                    if native
                    else (latest_perf.get(config_id) or latest_perf.get(ctrl_name))
                )
                if db_snap:
                    db_perf = db_snap.get("performance", db_snap)
                    if not isinstance(db_perf, dict):
                        db_perf = {}
                else:
                    db_perf = {}

                # Live performance from bot status (always available)
                live_perf = ctrl_info.get("performance", {})
                if not isinstance(live_perf, dict):
                    live_perf = {}

                if native:
                    realized = _native_number(live_perf, "realized_pnl_quote")
                    unrealized = _native_number(live_perf, "unrealized_pnl_quote")
                    global_pnl = (
                        realized + unrealized
                        if realized is not None and unrealized is not None
                        else None
                    )
                    global_pnl_pct = _native_number(live_perf, "global_pnl_pct")
                    volume = _native_number(live_perf, "volume_traded")
                    if None in (realized, unrealized, global_pnl_pct, volume):
                        metrics_available = False
                else:
                    realized = _pick(live_perf, db_perf, "realized_pnl_quote")
                    unrealized = _pick(live_perf, db_perf, "unrealized_pnl_quote")
                    global_pnl = realized + unrealized
                    global_pnl_pct = _pick(live_perf, db_perf, "global_pnl_pct")
                    volume = _pick(live_perf, db_perf, "volume_traded")
                close_types = _pick_value(live_perf, db_perf, "close_type_counts", {})
                if not isinstance(close_types, dict):
                    close_types = {}
                positions = _pick_value(live_perf, db_perf, "positions_summary", [])
                if not isinstance(positions, list):
                    positions = []
                custom_info = _pick_value(ctrl_info, db_snap or {}, "custom_info", {})
                if not isinstance(custom_info, dict):
                    custom_info = {}

                # Primary: config dict (correct keys)
                connector = ctrl_config.get("connector_name", "")
                trading_pair = ctrl_config.get("trading_pair", "")

                if (
                    native
                    and not trading_pair
                    and isinstance(custom_info.get("pair"), str)
                ):
                    trading_pair = custom_info["pair"]

                # Fallback: try DB snapshot, then parse legacy controller names
                if not connector:
                    connector = db_perf.get(
                        "connector", db_perf.get("connector_name", "")
                    )
                if not trading_pair:
                    trading_pair = db_perf.get("trading_pair", "")

                if not native and (not connector or not trading_pair):
                    parts = ctrl_name.split("_")
                    for i, part in enumerate(parts):
                        if "-" in part and part[0].isupper():
                            if not trading_pair:
                                trading_pair = part
                            if not connector and i > 0:
                                connector = "_".join(parts[:i])
                            break

                if global_pnl is not None:
                    total_pnl += global_pnl
                if volume is not None:
                    total_volume += volume

                config_cname = ctrl_config.get("controller_name", "")
                display_name = config_cname or ctrl_name
                display_id = config_id or ctrl_name

                controllers.append(
                    {
                        "controller_name": display_name,
                        "controller_id": display_id,
                        "bot_name": bot_name,
                        "status": ctrl_status,
                        "connector": connector,
                        "trading_pair": trading_pair,
                        "realized_pnl_quote": realized,
                        "unrealized_pnl_quote": unrealized,
                        "global_pnl_quote": global_pnl,
                        "global_pnl_pct": global_pnl_pct,
                        "volume_traded": volume,
                        "close_type_counts": close_types,
                        "positions_summary": positions,
                        "deployed_at": bot_runs.get(bot_name),
                        "config": ctrl_config,
                        "custom_info": custom_info,
                    }
                )

        bots.append(
            {
                "bot_name": bot_name,
                "status": bot_status,
                "num_controllers": num_controllers,
                **(_native_observation_times(bot_data) if native else {}),
                **(
                    {
                        "controller_count_current": bot_data.get("performance_current")
                        is True
                        and isinstance(performance, dict)
                        and bool(performance)
                        and all(isinstance(row, dict) for row in performance.values())
                    }
                    if native
                    else {}
                ),
                "error_count": len(error_logs),
                "deployed_at": bot_runs.get(bot_name),
                "error_logs": error_logs[-100:],
                "general_logs": general_logs[-100:],
            }
        )

    page = {
        "controllers": controllers,
        "bots": bots,
        "total_pnl": total_pnl,
        "total_volume": total_volume,
        "server_online": True,
    }
    if not metrics_available:
        page.update(
            {
                "total_pnl": None,
                "total_volume": None,
                "metrics_available": False,
                "metrics_unavailable_reason": "Fleet economics are unavailable because native source coverage or reported metrics are incomplete. Observed controller counts and rows are shown separately.",
            }
        )
    return page


async def fetch_bots_status(client, **_kw):
    """Fetch active bots status."""
    return await client.bot_orchestration.get_active_bots_status()


async def fetch_bot_runs(client, **_kw):
    """Fetch bot run history."""
    return await client.bot_orchestration.get_bot_runs()
