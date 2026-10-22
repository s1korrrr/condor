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
    # Native BUY admission issue codes (hummingbot v2_with_controllers native admission).
    "native_buy_outcome_unavailable": "last buy result unknown",
    "native_buy_create_refused": "buy order refused",
    "risk_reconciliation_unavailable": "risk state unknown",
    "native_recovery_fault": "position recovery fault",
    "controller_fault": "controller fault",
    "portfolio_identity_unavailable": "portfolio identity unknown",
    "symbol_runtime_fault": "symbol fault",
    "durable_buy_authorization_unresolved": "earlier buy not reconciled",
    "native_funding_reconciliation_required": "not enough USDC allocated",
}


def known(reason: str) -> bool:
    return reason in REASONS


def short_pair(pair: str) -> str:
    """``ETH-USDC`` → ``ETH``; a bot-wide row reads ``all pairs``."""
    return pair.split("-")[0] if pair else "all pairs"


def side_title(pairs) -> str:
    """``Buying``/``Selling``/``Trading`` for a set of (pair, side) rows."""
    sides = {side for _, side in pairs}
    return SIDES[sides.pop()].capitalize() if len(sides) == 1 else "Trading"


def describe(side: str, pair: str | None, reason: str) -> tuple[str, str]:
    """(subject, why): ``("ETH-USDC buying", "not enough USDC")`` or ``("Trading", "kill switch on")``."""
    verb = SIDES.get(side, "trading")
    subject = f"{pair} {verb}" if pair else verb.capitalize()
    return subject, REASONS.get(reason, reason.replace("_", " "))
