import json
import urllib.parse
from pathlib import Path

import pytest

from utils import okx_hour_cache_backfill as bf

HOUR = bf.HOUR_MS
NOW = 1_790_920_000_000  # 2026-10-02 05:46 UTC
LATEST_CLOSED_OPEN = NOW // HOUR * HOUR - HOUR


def cached_bar(open_ms, close="100"):
    return {
        "open_time_ms": open_ms, "close_time_ms": open_ms + HOUR, "open": "100", "high": "101", "low": "99", "close": close,
        "volume": "1", "quote_volume": "100", "confirmed": True, "available_at_ms": open_ms + HOUR + 5,
        "source_epoch": "live-epoch", "source_sequence": 7,
    }


def cache_file(directory: Path, pair="BTC-USDC", cached_hours=10):
    first = LATEST_CLOSED_OPEN - (cached_hours - 1) * HOUR
    body = {
        "schema_version": bf.SCHEMA, "provider_id": bf.PROVIDER, "pair": pair, "saved_at_ms": NOW - 1000,
        "bars_1m": [], "bars_1h": [cached_bar(first + i * HOUR) for i in range(cached_hours)], "bars_1d": [],
    }
    path = directory / f"{pair}.json"
    path.write_text(json.dumps(bf.sealed(body), separators=(",", ":")))
    return path, body


class FakeOkx:
    """Serves hourly rows newest first, ending just before `after`, like history-candles."""

    def __init__(self, oldest_open, confirm_latest=True):
        self.oldest, self.urls = oldest_open, []

    def __call__(self, url):
        self.urls.append(url)
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
        assert query["bar"] == "1H" and query["limit"] == "100"
        after = int(query["after"])
        times = [t for t in range(after - HOUR, self.oldest - 1, -HOUR)][:100]
        rows = [[str(t), "10.50", "11", "10", "10.5000", "2.0", "2.0", "21.0", "1"] for t in times]
        return {"code": "0", "msg": "", "data": rows}


def test_digest_matches_the_service_scheme_and_a_tampered_cache_is_refused(tmp_path):
    path, body = cache_file(tmp_path)
    assert bf.read_cache(path)["pair"] == "BTC-USDC"
    record = json.loads(path.read_text())
    record["body"]["bars_1h"][0]["close"] = "101"
    path.write_text(json.dumps(record))
    with pytest.raises(bf.BackfillError, match="checksum"):
        bf.read_cache(path)


def test_plan_counts_bars_and_requests_without_any_network(tmp_path):
    cache_file(tmp_path, cached_hours=10)
    (report,) = bf.plan(tmp_path, NOW, hours=1000)
    assert report["bars_to_fetch"] == 990
    assert report["requests"] == 11  # ceil(990 / 100) + 1
    assert report["cached"]["missing_hours"] == 0


def test_build_fills_older_hours_without_rewriting_recorded_bars(tmp_path):
    live, scratch = tmp_path / "live", tmp_path / "scratch"
    live.mkdir()
    path, body = cache_file(live, cached_hours=10)
    first_cached = body["bars_1h"][0]["open_time_ms"]
    fake = FakeOkx(oldest_open=LATEST_CLOSED_OPEN - 999 * HOUR)
    (report,) = bf.build(live, scratch, NOW, hours=1000, fetch=fake, sleep=lambda _: None)
    assert report["fetched"] == 990
    merged = bf.read_cache(scratch / "BTC-USDC.json")
    hours = merged["bars_1h"]
    assert len(hours) == 1000
    times = [b["open_time_ms"] for b in hours]
    assert times == sorted(set(times)) and bf.coverage(hours)["missing_hours"] == 0
    assert hours[-10:] == body["bars_1h"], "the service's own bars are untouched"
    old = hours[0]
    assert old["close"] == "10.5" and old["quote_volume"] == "21", "canonical decimal text"
    assert old["available_at_ms"] >= old["close_time_ms"] and old["source_epoch"].startswith("okx-public-history-")
    assert merged["saved_at_ms"] >= max(b["available_at_ms"] for b in hours)
    assert times[9] < first_cached and len(fake.urls) <= 12
    assert path.read_text() == json.dumps(json.loads(path.read_text()), separators=(",", ":")), "live file is not modified"
    assert (scratch / "BTC-USDC.json").stat().st_mode & 0o777 == 0o600


def test_forming_and_malformed_rows_are_not_admitted():
    forming = [str(LATEST_CLOSED_OPEN), "1", "2", "1", "2", "1", "1", "1", "0"]
    assert bf.source_bar(forming, NOW, "e") is None
    bad_high = [str(LATEST_CLOSED_OPEN), "1", "0.5", "1", "1", "1", "1", "1", "1"]
    with pytest.raises(bf.BackfillError, match="OHLC"):
        bf.source_bar(bad_high, NOW, "e")
    with pytest.raises(bf.BackfillError, match="hour boundary"):
        bf.source_bar([str(LATEST_CLOSED_OPEN + 1), "1", "1", "1", "1", "1", "1", "1", "1"], NOW, "e")


def test_pagination_must_move_backwards_and_okx_errors_surface(tmp_path):
    with pytest.raises(bf.BackfillError, match="OKX error 50011"):
        bf.fetch_rows(lambda url: {"code": "50011", "msg": "rate limit", "data": []}, "BTC-USDC", 0, 10 * HOUR, lambda _: None)
    stuck = lambda url: {"code": "0", "data": [[str(10 * HOUR), "1", "1", "1", "1", "1", "1", "1", "1"]]}  # noqa: E731
    with pytest.raises(bf.BackfillError, match="backwards"):
        bf.fetch_rows(stuck, "BTC-USDC", 0, 10 * HOUR, lambda _: None)


def test_the_live_cache_directory_and_rsibot_data_roots_are_never_a_target(tmp_path, monkeypatch):
    live = tmp_path / "live"
    live.mkdir()
    cache_file(live)
    for target in (live, live / "sub"):
        with pytest.raises(bf.BackfillError, match="scratch"):
            bf.build(live, target, NOW, 100, fetch=lambda url: {"code": "0", "data": []})
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    with pytest.raises(bf.BackfillError, match="scratch"):
        bf.build(live, tmp_path / ".local" / "share" / "rsibot-stack-v2" / "x", NOW, 100, fetch=lambda url: {"code": "0", "data": []})
