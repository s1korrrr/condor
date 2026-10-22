"""Plain words for a trading restriction, shared by push alerts and the fleet summary.

One wording source: the phone shows the summary's text verbatim, and alerts use the same words.
"""

from __future__ import annotations

SIDES = {"buy": "buying", "sell": "selling", "both": "trading"}

REASONS = {
    "connector_not_ready": "exchange connection not ready",
    "restart_hold": "held after an unattended restart",
    "admission_not_ready": "new entries not admitted",
    "controller_reports_invalid": "controller reports invalid",
    "persistence_fault": "trade storage fault",
    "daily_loss_pause": "daily-loss limit reached",
    "recovery_preflight_failed": "position recovery failed",
    "ownership_transfer_pending": "position handover pending",
    "recovery_unfinished": "position recovery unfinished",
    "operator_pause": "paused by operator",
    "manual_kill_switch": "kill switch on",
    "execution_disabled": "execution disabled",
    "exposure_unavailable": "exposure unknown",
    "trade_mode_sell_only": "sell-only mode",
    "balance_low": "not enough USDC",
    "base_balance_low": "not enough of the coin to sell",
    "inventory_unavailable": "holdings unknown",
    "price_unavailable": "no price",
    "price_stale": "price out of date",
    "data_unavailable": "market data unavailable",
    "symbol_fault": "symbol fault",
    "entry_decision_unavailable": "buy decision could not be stored",
}


def known(reason: str) -> bool:
    return reason in REASONS


def describe(side: str, pair: str | None, reason: str) -> tuple[str, str]:
    """(subject, why): ``("ETH-USDC buying", "not enough USDC")`` or ``("Trading", "kill switch on")``."""
    verb = SIDES.get(side, "trading")
    subject = f"{pair} {verb}" if pair else verb.capitalize()
    return subject, REASONS.get(reason, reason.replace("_", " "))
