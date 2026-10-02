"""Seed older hourly bars into a copy of the okx-candle-service Market Picture history cache.

Why: the market-observation worker builds its 90-day hourly correlations from the candle service's
1h history. The service derives that history from its own 1m rows, which it keeps for about eight
days (11 521 minutes, so roughly 188 hourly bars), so a 2 160-return window cannot fill for months.
The service does accept up to 3 001 hourly bars from its persisted cache (`bars_1h`,
schema `market-picture.history-cache.v1`), so older hours can be seeded there.

This tool never touches the live cache. `plan` makes no network call. `build --fetch` reads the
live cache directory, fetches only the missing older hours from OKX's public market-data endpoint
(no credentials, `GET /api/v5/market/history-candles?bar=1H`) and writes new cache files into a
separate scratch directory. Existing bars always win over fetched ones, so nothing the service
recorded is rewritten; the lead decides whether and when to copy the result into place.

    python -m utils.okx_hour_cache_backfill plan  --cache-dir <live cache-rsi/market-picture>
    python -m utils.okx_hour_cache_backfill build --cache-dir <live ...> --out-dir <scratch> --fetch
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Sequence
from decimal import Decimal, InvalidOperation
from pathlib import Path

HOUR_MS = 3_600_000
HOUR_ROWS = 3_001  # service capacity per pair (okx-candle-service market_picture.rs)
DEFAULT_HOURS = 2_880  # 120 days: the 90-day window plus the 30 daily trend steps
OKX_HISTORY_URL = "https://www.okx.com/api/v5/market/history-candles"
PAGE_LIMIT = 100  # OKX maximum rows per history-candles page
REQUEST_PACING_S = 0.25  # public limit is 20 requests / 2 s per IP; stay well inside it
SCHEMA = "market-picture.history-cache.v1"
PROVIDER = "okx-candle-service"

Fetch = Callable[[str], dict]


class BackfillError(RuntimeError):
    pass


def canonical_decimal(text: str) -> str:
    """The service's canonical decimal text: plain digits, no exponent, no trailing zeros."""
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise BackfillError(f"not a decimal: {text!r}") from exc
    if not value.is_finite() or value < 0:
        raise BackfillError(f"decimal out of range: {text!r}")
    rendered = format(value.normalize(), "f")
    return "0" if Decimal(rendered) == 0 else rendered


def body_digest(body: dict) -> str:
    """SHA256 over the compact JSON of `body` in service field order (verified against a live file)."""
    return hashlib.sha256(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def read_cache(path: Path) -> dict:
    record = json.loads(path.read_text())
    body = record["body"]
    if body.get("schema_version") != SCHEMA or body.get("provider_id") != PROVIDER:
        raise BackfillError(f"{path.name}: not a market-picture history cache")
    if body_digest(body) != record["sha256"]:
        raise BackfillError(f"{path.name}: checksum does not match, refusing to build on it")
    return body


def missing_range(hour_bars: Sequence[dict], now_ms: int, hours: int) -> tuple[int, int] | None:
    """Open-time range [start, end) of hourly bars to fetch, older than the earliest cached hour."""
    latest_closed_open = now_ms // HOUR_MS * HOUR_MS - HOUR_MS
    start = latest_closed_open - (min(hours, HOUR_ROWS) - 1) * HOUR_MS
    end = hour_bars[0]["open_time_ms"] if hour_bars else latest_closed_open + HOUR_MS
    return (start, end) if start < end else None


def expected_requests(start_ms: int, end_ms: int) -> int:
    return math.ceil((end_ms - start_ms) / HOUR_MS / PAGE_LIMIT) + 1


def page_url(pair: str, after_ms: int) -> str:
    query = urllib.parse.urlencode({"instId": pair, "bar": "1H", "after": after_ms, "limit": PAGE_LIMIT})
    return f"{OKX_HISTORY_URL}?{query}"


def http_fetch(url: str) -> dict:  # pragma: no cover - the only network call, exercised by the lead
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "condor-hour-backfill/1"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 - fixed https host
                return json.loads(response.read(1_000_000))
        except OSError:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)
    raise AssertionError("unreachable")


def fetch_rows(fetch: Fetch, pair: str, start_ms: int, end_ms: int, sleep: Callable[[float], None] = time.sleep) -> list[list[str]]:
    """Walk backwards from `end_ms` (exclusive) to `start_ms`; OKX returns newest first."""
    rows: dict[int, list[str]] = {}
    after = end_ms
    for _ in range(expected_requests(start_ms, end_ms) + 2):
        payload = fetch(page_url(pair, after))
        if payload.get("code") != "0":
            raise BackfillError(f"{pair}: OKX error {payload.get('code')} {payload.get('msg')}")
        page = payload.get("data") or []
        if not page:
            break
        for row in page:
            rows[int(row[0])] = row
        oldest = min(int(row[0]) for row in page)
        if oldest >= after:
            raise BackfillError(f"{pair}: pagination did not move backwards")
        after = oldest
        if oldest <= start_ms:
            break
        sleep(REQUEST_PACING_S)
    return [rows[t] for t in sorted(rows) if start_ms <= t < end_ms]


def source_bar(row: Sequence[str], available_at_ms: int, epoch: str) -> dict | None:
    """One OKX row `[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]` as a service SourceBar."""
    if len(row) < 9:
        raise BackfillError("unexpected OKX row shape")
    if row[8] != "1":
        return None  # a forming bar
    open_ms = int(row[0])
    if open_ms % HOUR_MS:
        raise BackfillError(f"bar {open_ms} is not on an hour boundary")
    o, h, low, c, volume, quote = (canonical_decimal(row[i]) for i in (1, 2, 3, 4, 5, 7))
    values = [Decimal(x) for x in (o, h, low, c)]
    if min(values) <= 0 or Decimal(h) < max(values) or Decimal(low) > min(values):
        raise BackfillError(f"bar {open_ms} violates OHLC bounds")
    return {
        "open_time_ms": open_ms,
        "close_time_ms": open_ms + HOUR_MS,
        "open": o,
        "high": h,
        "low": low,
        "close": c,
        "volume": volume,
        "quote_volume": quote,
        "confirmed": True,
        "available_at_ms": max(available_at_ms, open_ms + HOUR_MS),
        "source_epoch": epoch,
        "source_sequence": 1,
    }


def merge_hours(existing: Sequence[dict], fetched: Iterable[dict]) -> list[dict]:
    """Existing bars win on overlap; the result is ordered, unique and bounded to the service capacity."""
    merged = {bar["open_time_ms"]: bar for bar in fetched}
    merged.update({bar["open_time_ms"]: bar for bar in existing})
    return [merged[t] for t in sorted(merged)][-HOUR_ROWS:]


def coverage(hour_bars: Sequence[dict]) -> dict:
    times = [bar["open_time_ms"] for bar in hour_bars]
    gaps = sum(b - a - HOUR_MS for a, b in zip(times, times[1:])) // HOUR_MS
    return {"bars": len(times), "first_open_ms": times[0] if times else None, "last_open_ms": times[-1] if times else None, "missing_hours": gaps}


def sealed(body: dict) -> dict:
    return {"body": body, "sha256": body_digest(body)}


def build_pair(body: dict, fetched: Sequence[dict], now_ms: int) -> dict:
    merged = merge_hours(body["bars_1h"], fetched)
    new_body = dict(body)
    new_body["saved_at_ms"] = max(body["saved_at_ms"], now_ms)
    new_body["bars_1h"] = merged
    return new_body


def _refuse_live_target(out_dir: Path, cache_dir: Path) -> None:
    out, cache = out_dir.resolve(), cache_dir.resolve()
    live_root = Path.home() / ".local" / "share"
    if out == cache or cache in out.parents or any(p.name.startswith("rsibot-") for p in (out, *out.parents) if p.parent == live_root):
        raise BackfillError("--out-dir must be a scratch directory outside the live cache and the rsibot data roots")


def plan(cache_dir: Path, now_ms: int, hours: int) -> list[dict]:
    report = []
    for path in sorted(cache_dir.glob("*-*.json")):
        body = read_cache(path)
        span = missing_range(body["bars_1h"], now_ms, hours)
        report.append(
            {
                "pair": body["pair"],
                "cached": coverage(body["bars_1h"]),
                "fetch_open_range_ms": list(span) if span else None,
                "bars_to_fetch": (span[1] - span[0]) // HOUR_MS if span else 0,
                "requests": expected_requests(*span) if span else 0,
            }
        )
    return report


def build(cache_dir: Path, out_dir: Path, now_ms: int, hours: int, fetch: Fetch, sleep: Callable[[float], None] = time.sleep) -> list[dict]:
    _refuse_live_target(out_dir, cache_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    epoch = "okx-public-history-" + time.strftime("%Y%m%d", time.gmtime(now_ms / 1000))
    report = []
    for path in sorted(cache_dir.glob("*-*.json")):
        body = read_cache(path)
        span = missing_range(body["bars_1h"], now_ms, hours)
        fetched = []
        if span:
            rows = fetch_rows(fetch, body["pair"], span[0], span[1], sleep)
            fetched = [bar for row in rows if (bar := source_bar(row, now_ms, epoch))]
        new_body = build_pair(body, fetched, now_ms)
        target = out_dir / path.name
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(sealed(new_body), handle, separators=(",", ":"), ensure_ascii=False)
        report.append({"pair": body["pair"], "fetched": len(fetched), "after": coverage(new_body["bars_1h"]), "file": str(target)})
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("plan", "build"))
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path)
    parser.add_argument("--hours", type=int, default=DEFAULT_HOURS)
    parser.add_argument("--fetch", action="store_true", help="allow the public OKX requests; without it `build` only plans")
    args = parser.parse_args(argv)
    now_ms = int(time.time() * 1000)
    if not 24 <= args.hours <= HOUR_ROWS:
        parser.error(f"--hours must be within 24..{HOUR_ROWS}")
    if args.command == "plan" or not args.fetch:
        print(json.dumps(plan(args.cache_dir, now_ms, args.hours), indent=2))
        if args.command == "build":
            print("dry run: pass --fetch to download and write", file=sys.stderr)
        return 0
    if args.out_dir is None:
        parser.error("build --fetch needs --out-dir (a scratch directory)")
    print(json.dumps(build(args.cache_dir, args.out_dir, now_ms, args.hours, http_fetch), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
