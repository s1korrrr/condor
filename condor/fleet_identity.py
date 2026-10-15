"""Bot identity read from the registered bot id: nickname, generation and paper flag.

One definition shared by the fleet summary, the fleet fills feed and the push worker, so a bot
is paper (or a given generation) in every surface or in none. Nothing here is guessed: an id
without a known token has no generation.
"""

from __future__ import annotations

import re
from typing import Optional

V1_DISPLAY = {
    "ok_rsi": "V1 · ok_rsi",
    "ok_rsi_sui_sell_only": "SUI · Sell only",
    "rsi_v5": "RSI v5",
}
PAPER_TOKEN = re.compile(r"(?:^|[_-])paper(?:[_-]|$)", re.IGNORECASE)
GENERATIONS = {
    "V2": re.compile(r"(?:^|[_-])v2(?:[_-]|$)", re.IGNORECASE),
    "V3": re.compile(r"(?:^|[_-])v3(?:[_-]|$)", re.IGNORECASE),
    "V4": re.compile(r"(?:^|[_-])v4(?:[_-]|$)", re.IGNORECASE),
}


def display_name(bot: str) -> str:
    """Same nicknames as ``displayBotName`` in the frontend (V1 nicknames stay; other ids show as themselves)."""
    return V1_DISPLAY.get(bot, bot)


def generation(bot: str) -> Optional[str]:
    """'V1' for the known V1 bots, 'V2'/'V3'/'V4' when the id carries that token, otherwise ``None``."""
    if bot in V1_DISPLAY:
        return "V1"
    for name, pattern in GENERATIONS.items():
        if pattern.search(bot):
            return name
    return None


def is_paper(bot: str) -> bool:
    """A bot whose id carries a ``paper`` token. Paper bots never count as live capital."""
    return bool(PAPER_TOKEN.search(bot))
