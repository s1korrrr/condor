"""The summary's verdict reads the same stored history the dashboard Market Pulse reads.

The dashboard asks the owner for the canonical six-hour state projection (one row per stored
minute, ``frontend/src/features/market-picture/source.ts``). A thinned history page yields a
different smoothing window and hold state, so the app and the dashboard would show different
verdicts for the same frame.
"""

import asyncio
from types import SimpleNamespace

from condor.web.routes import fleet_summary as route


def test_market_history_reads_the_canonical_state_projection(monkeypatch):
    calls = []

    class Upstream:
        status = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class Session:
        def get(self, url, params=None, **kwargs):
            calls.append((url.rsplit("/", 1)[1], dict(params or {})))
            return Upstream()

    transport = SimpleNamespace(session=Session(), base_url="http://owner")

    class Manager:
        async def get_client(self, server):
            return SimpleNamespace(bot_orchestration=transport)

    async def body(upstream, limit):
        return {}

    monkeypatch.setattr(route, "get_config_manager", lambda: Manager())
    monkeypatch.setattr(route.market_picture, "_body", body)
    monkeypatch.setattr(
        route,
        "validate_response",
        lambda path, raw: {"snapshot_id": "s" * 64, "items": []},
    )

    read = asyncio.run(route.LiveReaders().market("rsibot-stack-v2", 1))

    assert read.frame is not None
    history = [params for path, params in calls if path == "history"]
    assert history == [
        {
            "snapshot_id": "s" * 64,
            "window": "6h",
            "limit": "1500",
            "resolution": "1m",
            "projection": "canonical_state",
        }
    ]


def test_a_bot_day_carries_the_fleet_window_flags():
    from decimal import Decimal

    from condor.web import fleet_pnl
    from condor.web.fleet_summary import bot_day_pnl

    def window(**changes):
        base = dict(
            bot="ok_rsi",
            quote="USDC",
            change=Decimal("1.5"),
            realized=None,
            unrealized=None,
            first_at=0.0,
            last_at=1.0,
            samples=1400,
            restarts=0,
            full=True,
            stale=False,
        )
        base.update(changes)
        return fleet_pnl.BotWindow(**base)

    plain = bot_day_pnl(window())
    assert plain["partial"] is False and plain["uncovered_ms"] == 0
    # Same flags as the fleet window: `partial` only for a late history start; unrecorded
    # time is carried separately (contract fields `partial` and `uncovered_ms`).
    gapped = bot_day_pnl(window(uncovered_ms=360_000))
    assert gapped["partial"] is False and gapped["uncovered_ms"] == 360_000
    assert bot_day_pnl(window(full=False))["partial"] is True
    assert bot_day_pnl(window(), simulated=True)["simulated"] is True
