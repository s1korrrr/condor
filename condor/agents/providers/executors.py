"""Core data provider: active executors with PnL and volume.

Delegates number-crunching to ``condor.agents.performance`` so that
live ticks and the web API always agree.
"""

from __future__ import annotations

from typing import Any

from . import register_provider
from .base import BaseProvider, ProviderResult


class ExecutorsProvider(BaseProvider):
    name = "executors"
    is_core = True

    async def execute(
        self,
        client: Any,
        config: dict,
        agent_id: str = "",
        bot_names: list[str] | None = None,
        since: float = 0.0,
    ) -> ProviderResult:
        from condor.agents.performance import fetch_agent_performance

        if not agent_id:
            return ProviderResult(
                name=self.name,
                data={
                    "executors": None,
                    "total_pnl": None,
                    "total_volume": 0,
                    "total_exposure": None,
                    "current_book_status": "unavailable",
                },
                summary="Active Executors: current inventory unavailable (no agent_id)",
            )

        # The ledger's bases are what this session actually owns — several, if it
        # deployed several. Without one (executor mode, tests) fall back to the
        # configured name, which is what the session would deploy under anyway.
        bases = list(bot_names or []) or [config.get("bot_name", "")]

        try:
            # ``since`` slices an adopted bot's history to this session's window,
            # so what the agent is told it earned is what the dashboard attributes
            # to it — inherited PnL is not reported as its own.
            perf = await fetch_agent_performance(
                client, agent_id, bot_names=bases, since=since
            )
        except Exception as e:
            return ProviderResult(
                name=self.name,
                data={
                    "error": str(e),
                    "executors": None,
                    "total_exposure": None,
                    "current_book_status": "unavailable",
                },
                summary=f"Active Executors: failed to fetch ({e})",
            )

        book_available = perf.current_book_status == "available"
        running = (
            [e for e in (perf.executors or []) if e["status"] == "RUNNING"]
            if book_available
            else []
        )
        lines = [
            (
                f"Active Executors: unavailable (agent: {agent_id})"
                if not book_available
                else (
                    f"Active Executors ({len(running)}) [agent: {agent_id}]:"
                    if running
                    else f"Active Executors: none running (agent: {agent_id})"
                )
            )
        ]
        if not book_available:
            lines.append(
                "  ⚠️ Current position inventory is unavailable; exposure is unknown. "
                "Do not treat an empty executor list as a flat account."
            )
        for r in running:
            side = r.get("side") or ""
            lines.append(
                f"  {r['pair']} {side} ${r['pnl']:+.2f} (V:${r['volume']:,.0f})"
            )
        if perf.bot_names:
            lines.append(f"  Bots operated: {', '.join(perf.bot_names)}")
        if book_available:
            lines.append(
                f"  Realized: ${perf.realized_pnl:+.2f} | "
                f"Unrealized: ${perf.unrealized_pnl:+.2f} | "
                f"Total PnL: ${perf.total_pnl:+.2f} | "
                f"Volume: ${perf.volume:,.0f}"
            )
        else:
            lines.append(
                f"  Realized: ${perf.realized_pnl:+.2f} | "
                f"Unrealized: UNKNOWN | Total PnL: UNKNOWN | "
                f"Volume: ${perf.volume:,.0f}"
            )
        # Say so rather than letting a missing bot read as a flat one. The figures
        # above are then a floor, and an agent told a floor can go look; an agent
        # told "$0.00" has no reason to.
        if perf.unresolved_bases:
            lines.append(
                "  ⚠️ No live or archived instance found for: "
                f"{', '.join(perf.unresolved_bases)} — the PnL above EXCLUDES "
                "them and is incomplete, not flat. Verify with manage_bots before "
                "concluding this session is break-even."
            )

        total_exposure = (
            sum(r.get("amount", 0) for r in running) if book_available else None
        )

        return ProviderResult(
            name=self.name,
            data={
                "executors": running if book_available else None,
                "all_executors": perf.executors if book_available else None,
                "total_pnl": perf.total_pnl if book_available else None,
                "realized_pnl": perf.realized_pnl,
                "unrealized_pnl": perf.unrealized_pnl if book_available else None,
                "total_volume": perf.volume,
                "total_fees": perf.fees,
                "total_exposure": total_exposure,
                "open_count": perf.open_count if book_available else None,
                "closed_count": perf.closed_count,
                "win_rate": perf.win_rate,
                # Provenance travels with the figures. Everything downstream —
                # get_info(), the session report, the journal snapshot — reads
                # this dict, so a consumer that shows a total can show what the
                # total is made of and whether any of it is missing.
                "bot_names": perf.bot_names,
                "bot_instances": perf.bot_instances,
                "unresolved_bases": perf.unresolved_bases,
                "controllers": perf.controllers,
                "close_type_counts": perf.close_type_counts,
                "fees_known": perf.fees_known,
                "current_book_status": perf.current_book_status,
            },
            summary="\n".join(lines),
        )


register_provider(ExecutorsProvider())
