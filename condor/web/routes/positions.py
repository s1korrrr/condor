from __future__ import annotations

import asyncio
import logging
import math

from fastapi import APIRouter, Depends, HTTPException

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from config_manager import get_config_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["positions"])

# Keep the dashboard poll bounded even when one owner API call is stalled.
POSITION_READ_TIMEOUT = 5.0


def _finite_number(pos: dict, *keys: str) -> float | None:
    for key in keys:
        if key in pos and pos[key] is not None:
            if isinstance(pos[key], bool):
                return None
            try:
                value = float(pos[key])
                if value == value and abs(value) != float("inf"):
                    return value
            except (ValueError, TypeError, OverflowError):
                return None
    return None


def _valid_position_economics(pos: dict) -> bool:
    pair = pos.get("trading_pair")
    amount = _finite_number(pos, "net_amount_base", "amount")
    entry = _finite_number(pos, "buy_breakeven_price", "entry_price", "breakeven_price")
    unrealized = _finite_number(pos, "unrealized_pnl_quote", "unrealized_pnl")
    current_price = pos.get("current_price")
    valid_mark = current_price is None or (
        _finite_number(pos, "current_price") is not None
        and _finite_number(pos, "current_price") > 0
    )
    return bool(
        isinstance(pair, str)
        and bool(pair.strip())
        and amount is not None
        and entry is not None
        and unrealized is not None
        and math.isfinite(abs(amount) * entry)
        and valid_mark
    )


def _normalize_position(
    pos: dict,
    source: str,
    source_name: str,
    *,
    source_instance: str | None = None,
    source_timestamp: int | float | str | None = None,
    reporting_scope: str,
) -> dict:
    """Normalize a position dict to a common shape with source info."""

    amount = _finite_number(pos, "net_amount_base", "amount")
    entry_price = _finite_number(
        pos, "buy_breakeven_price", "entry_price", "breakeven_price"
    )
    cost_basis_value = (
        abs(amount) * entry_price
        if amount is not None and entry_price is not None
        else None
    )
    if cost_basis_value is not None and not math.isfinite(cost_basis_value):
        cost_basis_value = None
    return {
        "connector_name": pos.get("connector_name") or pos.get("connector") or "",
        "trading_pair": pos.get("trading_pair") or "",
        "position_side": pos.get("position_side") or pos.get("side") or "",
        "amount": amount,
        "entry_price": entry_price,
        "notional_value": None,
        "cost_basis_value": cost_basis_value,
        "current_price": (
            _finite_number(pos, "current_price")
            if _finite_number(pos, "current_price") is not None
            and _finite_number(pos, "current_price") > 0
            else None
        ),
        "unrealized_pnl": _finite_number(pos, "unrealized_pnl_quote", "unrealized_pnl"),
        "leverage": pos.get("leverage") or 1,
        "controller_id": pos.get("controller_id") or "",
        "realized_pnl": _finite_number(pos, "realized_pnl_quote"),
        "cum_fees": _finite_number(pos, "cum_fees_quote"),
        "executor_count": pos.get("executor_count") or 0,
        "source": source,
        "source_name": source_name,
        "source_instance": source_instance,
        "source_timestamp": source_timestamp,
        "reporting_scope": reporting_scope,
        "reconciliation_status": "not_reconciled",
    }


def _bot_rows_and_status(result):
    """Extract only controller rows owned by current bot runtimes.

    ``get_active_bots_status`` is the runtime membership source. The status on a
    historical controller-performance row is not sufficient to make it live.
    """
    partial = False
    if isinstance(result, dict):
        if result.get("status") == "error" or "data" not in result:
            return None, "unavailable", None
        data = result["data"]
        partial = False
        if isinstance(data, dict):
            bots = []
            for name, value in data.items():
                if not isinstance(name, str) or not isinstance(value, dict):
                    partial = True
                    continue
                embedded_name = value.get("bot_name")
                if embedded_name is not None and embedded_name != name:
                    partial = True
                    continue
                bot = dict(value)
                if embedded_name is None:
                    bot["bot_name"] = name
                bots.append(bot)
        elif isinstance(data, list):
            bots = [value for value in data if isinstance(value, dict)]
            if len(bots) != len(data):
                partial = True
        else:
            return None, "unavailable", None
    elif isinstance(result, list):
        bots = [value for value in result if isinstance(value, dict)]
        partial = len(bots) != len(result)
    else:
        return None, "unavailable", None

    identities = [
        bot.get("bot_name") for bot in bots if isinstance(bot.get("bot_name"), str)
    ]
    duplicates = {name for name in identities if identities.count(name) > 1}
    if duplicates:
        partial = True
        bots = [bot for bot in bots if bot.get("bot_name") not in duplicates]

    rows = []
    non_current_rows = []
    active_states = {"running"}
    for bot in bots:
        bot_name = bot.get("bot_name")
        status = str(bot.get("status") or "").lower()
        performance = bot.get("performance")
        timestamp = bot.get("received_at", bot.get("timestamp"))
        if status == "reporting_only":
            # Known native rows kept for observability are not runtime members.
            continue
        if status in {"starting", "stopping"}:
            partial = True
            if isinstance(performance, dict):
                for controller_name, controller in performance.items():
                    details = (
                        controller.get("performance")
                        if isinstance(controller, dict)
                        else None
                    )
                    positions = (
                        details.get("positions_summary")
                        if isinstance(details, dict)
                        else None
                    )
                    if isinstance(positions, list):
                        non_current_rows.extend(
                            (p, f"{bot_name}/{controller_name}", bot_name, timestamp)
                            for p in positions
                            if isinstance(p, dict)
                        )
            continue
        if not isinstance(bot_name, str) or not bot_name or status not in active_states:
            if status in {"stopped", "terminated", "completed", "failed"}:
                if isinstance(performance, dict):
                    for controller_name, controller in performance.items():
                        details = (
                            controller.get("performance")
                            if isinstance(controller, dict)
                            else None
                        )
                        positions = (
                            details.get("positions_summary")
                            if isinstance(details, dict)
                            else None
                        )
                        if isinstance(positions, list):
                            non_current_rows.extend(
                                (
                                    p,
                                    f"{bot_name}/{controller_name}",
                                    bot_name,
                                    timestamp,
                                )
                                for p in positions
                                if isinstance(p, dict)
                            )
                continue
            partial = True
            continue
        if bot.get("source") == "native_mqtt":
            from condor.fetchers.bots import native_performance_is_current

            if native_performance_is_current(bot):
                native_current = True
            else:
                native_current = False
        else:
            native_current = True
        if not native_current:
            partial = True
            if isinstance(performance, dict):
                for controller_name, controller in performance.items():
                    details = (
                        controller.get("performance")
                        if isinstance(controller, dict)
                        else None
                    )
                    positions = (
                        details.get("positions_summary")
                        if isinstance(details, dict)
                        else None
                    )
                    if isinstance(positions, list):
                        non_current_rows.extend(
                            (p, f"{bot_name}/{controller_name}", bot_name, timestamp)
                            for p in positions
                            if isinstance(p, dict)
                        )
            continue
        if not isinstance(performance, dict) or not performance:
            partial = True
            continue
        for controller_name, controller in performance.items():
            if not isinstance(controller, dict):
                partial = True
                continue
            controller_status = str(controller.get("status") or "").lower()
            if controller_status != "running":
                # A missing or non-running controller status cannot establish a
                # current controller position from its retained performance row.
                if controller_status in {
                    "stopped",
                    "terminated",
                    "completed",
                    "failed",
                }:
                    details = controller.get("performance")
                    stopped_positions = (
                        details.get("positions_summary")
                        if isinstance(details, dict)
                        else None
                    )
                    if isinstance(stopped_positions, list):
                        non_current_rows.extend(
                            (p, f"{bot_name}/{controller_name}", bot_name, timestamp)
                            for p in stopped_positions
                            if isinstance(p, dict)
                        )
                    continue
                if controller_status in {"starting", "stopping"}:
                    partial = True
                    details = controller.get("performance")
                    transitional_positions = (
                        details.get("positions_summary")
                        if isinstance(details, dict)
                        else None
                    )
                    if isinstance(transitional_positions, list):
                        non_current_rows.extend(
                            (p, f"{bot_name}/{controller_name}", bot_name, timestamp)
                            for p in transitional_positions
                            if isinstance(p, dict)
                        )
                    continue
                partial = True
                details = controller.get("performance")
                unknown_positions = (
                    details.get("positions_summary")
                    if isinstance(details, dict)
                    else None
                )
                if isinstance(unknown_positions, list):
                    non_current_rows.extend(
                        (p, f"{bot_name}/{controller_name}", bot_name, timestamp)
                        for p in unknown_positions
                        if isinstance(p, dict)
                    )
                continue
            controller_performance = controller.get("performance")
            if not isinstance(controller_performance, dict):
                partial = True
                continue
            positions = controller_performance.get("positions_summary")
            if not isinstance(positions, list):
                partial = True
                continue
            controller_rows = {}
            duplicate_identities = set()
            for position in positions:
                if isinstance(position, dict):
                    if not _valid_position_economics(position):
                        partial = True
                    explicit_id = position.get(
                        "position_id", position.get("executor_id")
                    )
                    identity = (
                        ("id", str(explicit_id))
                        if explicit_id not in (None, "")
                        else (
                            "market",
                            str(
                                position.get(
                                    "connector_name", position.get("connector", "")
                                )
                            ),
                            str(position.get("trading_pair", "")),
                            str(
                                position.get("position_side", position.get("side", ""))
                            ).lower(),
                        )
                    )
                    if identity in controller_rows:
                        duplicate_identities.add(identity)
                        partial = True
                    else:
                        controller_rows[identity] = (
                            position,
                            f"{bot_name}/{controller_name}",
                            bot_name,
                            timestamp,
                        )
                else:
                    partial = True
            rows.extend(
                row
                for identity, row in controller_rows.items()
                if identity not in duplicate_identities
            )
    return rows, "partial" if partial else "available", non_current_rows


@router.get("/servers/{name}/positions")
async def get_consolidated_positions(
    name: str,
    user: WebUser = Depends(get_current_user),
):
    cm = get_config_manager()
    if not cm.has_server_access(user.id, name):
        raise HTTPException(status_code=403, detail="No access")

    loop = asyncio.get_running_loop()
    read_deadline = loop.time() + POSITION_READ_TIMEOUT

    def remaining_read_time() -> float:
        return max(0.0, read_deadline - loop.time())

    # Read owner executor inventory and current runtime membership independently.
    async def fetch_executor_positions():
        async def read():
            client = await cm.get_client(name)
            return await client.executors.get_positions_summary()

        try:
            result = await asyncio.wait_for(read(), timeout=remaining_read_time())
            if isinstance(result, dict):
                positions = result.get("positions")
            elif isinstance(result, list):
                positions = result
            else:
                return None, "unavailable", None
            if not isinstance(positions, list):
                return None, "unavailable", None
            partial = any(not isinstance(row, dict) for row in positions)
            positions = [row for row in positions if isinstance(row, dict)]
            partial = partial or any(
                not _valid_position_economics(row) for row in positions
            )
            timestamp = (
                result.get("timestamp", result.get("received_at"))
                if isinstance(result, dict)
                else None
            )
            return positions, "partial" if partial else "available", timestamp
        except Exception as e:
            logger.warning("Failed to fetch executor positions from '%s': %s", name, e)
            return None, "unavailable", None

    async def fetch_bot_positions():
        try:

            async def read():
                client = await cm.get_client(name)
                return await client.bot_orchestration.get_active_bots_status()

            result = await asyncio.wait_for(read(), timeout=remaining_read_time())
            return _bot_rows_and_status(result)
        except Exception as e:
            logger.warning("Failed to fetch bot positions from '%s': %s", name, e)
            return None, "unavailable", None

    (exec_raw, executor_status, executor_timestamp), (
        bot_raw,
        bot_status,
        non_current_raw,
    ) = await asyncio.gather(
        fetch_executor_positions(),
        fetch_bot_positions(),
    )

    executor_positions = (
        [
            _normalize_position(
                pos,
                "executor",
                "Executor",
                source_instance=None,
                source_timestamp=executor_timestamp,
                reporting_scope="executor_inventory",
            )
            for pos in exec_raw
            if isinstance(pos, dict)
        ]
        if exec_raw is not None
        else None
    )

    bot_positions = (
        [
            _normalize_position(
                pos,
                "bot",
                source_name,
                source_instance=instance,
                source_timestamp=timestamp,
                reporting_scope="current_runtime",
            )
            for pos, source_name, instance, timestamp in bot_raw
        ]
        if bot_raw is not None
        else None
    )

    non_current_bot_positions = [
        _normalize_position(
            pos,
            "bot",
            source_name,
            source_instance=instance,
            source_timestamp=timestamp,
            reporting_scope="non_current_runtime_observation",
        )
        for pos, source_name, instance, timestamp in (non_current_raw or [])
    ]

    # Enrich positions missing current_price (the positions_summary endpoint doesn't provide it)
    all_positions = (
        (executor_positions or []) + (bot_positions or []) + non_current_bot_positions
    )
    pairs_needing_price = {}
    for pos in all_positions:
        if (
            pos["current_price"] is None
            and pos["connector_name"]
            and pos["trading_pair"]
        ):
            key = (pos["connector_name"], pos["trading_pair"])
            pairs_needing_price[key] = None

    invalid_price_keys = set()
    if pairs_needing_price:
        try:
            client = await asyncio.wait_for(
                cm.get_client(name), timeout=remaining_read_time()
            )
            price_tasks = [
                asyncio.wait_for(
                    client.market_data.get_prices(
                        connector_name=conn, trading_pairs=pair
                    ),
                    timeout=remaining_read_time(),
                )
                for conn, pair in pairs_needing_price
            ]
            results = await asyncio.gather(*price_tasks, return_exceptions=True)
            for (conn, pair), result in zip(pairs_needing_price, results):
                if isinstance(result, dict):
                    prices = result.get("prices")
                    raw_price = prices.get(pair) if isinstance(prices, dict) else None
                    if raw_price is not None:
                        price = _finite_number({"price": raw_price}, "price")
                        if price is not None and price > 0:
                            pairs_needing_price[(conn, pair)] = price
                        else:
                            invalid_price_keys.add((conn, pair))

            for pos in all_positions:
                if pos["current_price"] is None:
                    key = (pos["connector_name"], pos["trading_pair"])
                    price = pairs_needing_price.get(key)
                    if price is not None:
                        pos["current_price"] = price
            for pos in all_positions:
                key = (pos["connector_name"], pos["trading_pair"])
                if key not in invalid_price_keys:
                    continue
                if pos["source"] == "executor":
                    executor_status = "partial"
                elif pos["reporting_scope"] == "current_runtime":
                    bot_status = "partial"
        except Exception as e:
            logger.warning("Failed to enrich positions with current prices: %s", e)

    # Missing marks are unknown exposure, including a timeout or a valid market
    # response that omits the requested pair. Do not present entry cost as live
    # notional or leave the source marked complete.
    for pos in all_positions:
        if pos["current_price"] is None:
            if pos["source"] == "executor":
                executor_status = (
                    "partial" if executor_status == "available" else executor_status
                )
            elif pos["reporting_scope"] == "current_runtime":
                bot_status = "partial" if bot_status == "available" else bot_status
            continue
        amount = pos["amount"]
        marked = abs(amount) * pos["current_price"] if amount is not None else None
        pos["notional_value"] = (
            marked if marked is not None and math.isfinite(marked) else None
        )
        if pos["notional_value"] is None:
            if pos["source"] == "executor":
                executor_status = (
                    "partial" if executor_status == "available" else executor_status
                )
            elif pos["reporting_scope"] == "current_runtime":
                bot_status = "partial" if bot_status == "available" else bot_status

    return {
        "executor_positions": executor_positions,
        "bot_positions": bot_positions,
        "executor_positions_status": executor_status,
        "bot_positions_status": bot_status,
        "non_current_bot_positions": non_current_bot_positions,
    }
