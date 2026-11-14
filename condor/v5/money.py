"""Money samples for the V5 dashboard Money page (read-only, paper).

No owner publishes equity or P&L over time, so the dashboard keeps its own small record: every few minutes it
reads the same validated owner sections the pages already read (V5 wallet and lifetime accounting, the Helm
runtime status) and appends one row per bot to a JSON-lines file in its own runtime state. A failed or stale read
is recorded as a gap row with its reason, never as a number. There is no backfill: the record starts when the
sampler first runs. Nothing here writes anywhere but the dashboard's own state directory.
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any

SAMPLE_INTERVAL_S = 300
MAX_ROWS = 2 * 24 * 12 * 31  # two bots, five-minute samples, about a month
DECIMAL = re.compile(r"-?\d{1,18}(?:\.\d{1,24})?")


def _decimal(value: Any) -> str | None:
    """Owner decimal text passes as text; anything else is unknown (never converted to float here)."""
    return value if isinstance(value, str) and DECIMAL.fullmatch(value) else None


def v5_row(wallet: dict | None, accounting: dict | None, now_ms: int) -> dict[str, Any]:
    """One V5 row from validated wallet and accounting reads (as returned by the paper read bridge)."""
    row: dict[str, Any] = {"bot": "v5", "at_ms": now_ms}
    usable = lambda read: isinstance(read, dict) and read.get("state") == "available" and isinstance(read.get("data"), dict)  # noqa: E731
    if not usable(wallet) or not usable(accounting):
        reasons = [
            f"{name}: {read.get('state') if isinstance(read, dict) else 'unavailable'}"
            for name, read in (("wallet", wallet), ("accounting", accounting))
            if not usable(read)
        ]
        return {**row, "gap": "; ".join(reasons)[:200]}
    data, totals = wallet["data"], accounting["data"]
    program = totals.get("program") if isinstance(totals.get("program"), dict) else {}
    coins = {}
    controllers = totals.get("controllers") if isinstance(totals.get("controllers"), dict) else {}
    for controller, values in list(controllers.items())[:16]:
        coin = controller.rsplit("_", 1)[-1].upper()
        if isinstance(values, dict) and re.fullmatch(r"[A-Z0-9]{2,10}", coin):
            coins[coin] = {"realized": _decimal(values.get("realized_pnl_quote")), "unrealized": _decimal(values.get("unrealized_pnl_quote"))}
    return {
        **row,
        "snapshot_at_ms": wallet.get("generated_at_ms") if type(wallet.get("generated_at_ms")) is int else None,
        "unit": data.get("unit") if isinstance(data.get("unit"), str) and len(data["unit"]) <= 12 else None,
        "equity": _decimal(data.get("equity_quote")),
        "initial_funding": _decimal(data.get("initial_funding_quote")),
        "external_flows": _decimal(data.get("external_cash_flows_quote")),
        "realized": _decimal(program.get("realized_pnl_quote")),
        "unrealized": _decimal(program.get("unrealized_pnl_quote")),
        "fees": _decimal(program.get("fees_paid_quote")),
        "coins": coins,
    }


def helm_row(helm: dict | None, now_ms: int) -> dict[str, Any]:
    """One Helm row from the Helm status projection; no published money is a gap, not zero."""
    row: dict[str, Any] = {"bot": "helm", "at_ms": now_ms}
    if not isinstance(helm, dict) or helm.get("state") != "FRESH" or not isinstance(helm.get("status"), dict):
        state = helm.get("reason") if isinstance(helm, dict) else "unavailable"
        return {**row, "gap": str(state)[:200]}
    money = helm["status"].get("money")
    if not isinstance(money, dict) or money.get("realized") is None and money.get("unrealized") is None:
        return {**row, "gap": "HELM_MONEY_NOT_PUBLISHED"}
    return {**row, "unit": "USDC", "realized": money.get("realized"), "unrealized": money.get("unrealized")}


class MoneyLedger:
    """Append-only JSON-lines record in the dashboard's runtime state, trimmed to MAX_ROWS."""

    def __init__(self, root: Path):
        self.dir = root / "money"
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.dir.is_symlink():
            raise ValueError("money state directory may not be a symlink")
        self.path = self.dir / "samples.jsonl"
        self._lock = threading.Lock()

    def append(self, rows: list[dict[str, Any]]) -> None:
        with self._lock:
            with open(self.path, "a", encoding="utf-8") as handle:
                for row in rows:
                    handle.write(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n")
            if self.path.stat().st_size > MAX_ROWS * 600:
                kept = self._lines()[-MAX_ROWS:]
                temporary = self.path.with_suffix(".tmp")
                temporary.write_text("".join(line + "\n" for line in kept), encoding="utf-8")
                os.replace(temporary, self.path)

    def _lines(self) -> list[str]:
        try:
            return [line for line in self.path.read_text(encoding="utf-8").splitlines() if line.strip()]
        except FileNotFoundError:
            return []

    def read(self, since_ms: int) -> list[dict[str, Any]]:
        rows = []
        with self._lock:
            lines = self._lines()
        for line in lines:
            try:
                row = json.loads(line)
            except ValueError:
                continue  # a torn last line from a crash is skipped, never repaired into a value
            if isinstance(row, dict) and type(row.get("at_ms")) is int and row["at_ms"] >= since_ms:
                rows.append(row)
        return rows
