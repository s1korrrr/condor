import json
from dataclasses import replace

from fastapi.testclient import TestClient

from condor.v5.app import create_app
from condor.v5.helm import _money
from condor.v5.money import MAX_ROWS, MoneyLedger, daily, helm_row, seconds_to_next_slot, v5_row
from test_v5_dashboard_bridge import ORIGIN, TOKEN, make_settings
from test_v5_paper_binding import NOW, status, write_status
from test_v5_paper_read_contract import envelope
from test_v5_helm_status import helm_status, write as write_helm

NOW_MS = int(NOW * 1000)
WALLET = {"equity_quote": "199318.98", "initial_funding_quote": "200000", "external_cash_flows_quote": "0", "unit": "USDC", "quote_asset": "USDC", "valuation_policy": "midpoint_fresh_book_only", "assets": []}
PROGRAM = {**envelope("accounting")["data"]["program"], "realized_pnl_quote": "114.13", "unrealized_pnl_quote": "-795.15", "fees_paid_quote": "23.11"}
ACCOUNTING = {**envelope("accounting")["data"], "program": PROGRAM, "controllers": {"modular_spot_meridian_v5_paper_bnb": {**PROGRAM, "realized_pnl_quote": "14.80", "unrealized_pnl_quote": "-77.86"}}}


def read(section, data, **changes):
    return {**envelope(section), "data": data, **changes}


def test_v5_row_keeps_owner_decimals_and_records_gaps():
    row = v5_row(read("wallet", WALLET), read("accounting", ACCOUNTING), NOW_MS)
    assert row["equity"] == "199318.98" and row["initial_funding"] == "200000"
    assert (row["realized"], row["unrealized"], row["fees"]) == ("114.13", "-795.15", "23.11")
    assert row["coins"] == {"BNB": {"realized": "14.80", "unrealized": "-77.86"}}
    gap = v5_row(read("wallet", WALLET, state="stale"), read("accounting", ACCOUNTING), NOW_MS)
    assert gap == {"bot": "v5", "at_ms": NOW_MS, "gap": "wallet: stale"}
    assert "equity" not in v5_row(None, None, NOW_MS)
    # A non-decimal owner value is unknown, never coerced.
    assert v5_row(read("wallet", {**WALLET, "equity_quote": "1e9"}), read("accounting", ACCOUNTING), NOW_MS)["equity"] is None


def test_helm_rows_say_why_there_is_no_money():
    assert helm_row({"state": "UNAVAILABLE", "reason": "HELM_STATUS_MISSING", "status": None}, NOW_MS)["gap"] == "HELM_STATUS_MISSING"
    assert helm_row({"state": "FRESH", "status": {"money": None}}, NOW_MS)["gap"] == "HELM_MONEY_NOT_PUBLISHED"
    row = helm_row({"state": "FRESH", "status": {"money": {"realized": "1.5", "unrealized": "-2"}}}, NOW_MS)
    assert (row["realized"], row["unrealized"], "gap" in row) == ("1.5", "-2", False)


def test_helm_money_sums_every_controller_or_is_unknown():
    ok = lambda realized, unrealized: {"performance": {"pnl_available": True, "realized_pnl_quote": realized, "unrealized_pnl_quote": unrealized}}  # noqa: E731
    reports = {"a": ok("0.1", "-1.25"), "b": ok("0.2", "0")}
    assert _money({"native_reports": reports}) == {"realized": "0.30000000", "unrealized": "-1.25000000"}
    reports["b"]["performance"]["unrealized_pnl_quote"] = "nan"
    assert _money({"native_reports": reports}) == {"realized": "0.30000000", "unrealized": None}
    # A partial set of controllers is never Helm's total.
    assert _money({"native_reports": {"a": ok("0.1", "-1")}, "unavailable_controller_ids": ["b"]}) is None
    unavailable = {"a": {"performance": {"pnl_available": False, "realized_pnl_quote": "0.1", "unrealized_pnl_quote": "-1"}}}
    assert _money({"native_reports": unavailable}) == {"realized": None, "unrealized": None}
    assert _money({"native_reports": {str(i): ok("1", "1") for i in range(17)}}) is None
    assert _money({"native_reports": {}}) is None and _money({}) is None


def test_ledger_appends_skips_torn_lines_and_trims(tmp_path):
    ledger = MoneyLedger(tmp_path)
    ledger.append([{"bot": "v5", "at_ms": 1}, {"bot": "helm", "at_ms": 2}])
    with open(ledger.path, "a") as handle:
        handle.write('{"bot": "v5", "at_')  # torn tail from a crash
    assert [row["at_ms"] for row in ledger.read(0)] == [1, 2]
    ledger.append([{"bot": "v5", "at_ms": 3}])  # the next row starts on its own line, not inside the torn one
    assert [row["at_ms"] for row in ledger.read(0)] == [1, 2, 3]
    assert [row["at_ms"] for row in ledger.read(2)] == [2, 3]
    ledger.path.write_text("".join(json.dumps({"bot": "v5", "at_ms": i, "pad": "x" * 600}) + "\n" for i in range(MAX_ROWS + 5)))
    ledger.append([{"bot": "v5", "at_ms": MAX_ROWS + 5}])
    rows = ledger.read(0)
    assert len(rows) == MAX_ROWS and rows[-1]["at_ms"] == MAX_ROWS + 5


HOUR = 3_600_000


def test_daily_counts_distinct_slots_from_every_sample():
    day = NOW_MS // 86_400_000 * 86_400_000
    rows = [
        {"bot": "v5", "at_ms": day + 8 * HOUR, "equity": "100", "realized": "1"},
        {"bot": "v5", "at_ms": day + 8 * HOUR + 300_000, "gap": "wallet: stale"},
        {"bot": "v5", "at_ms": day + 8 * HOUR + 55 * 60_000, "equity": "110", "realized": "3"},
        {"bot": "helm", "at_ms": day + 8 * HOUR, "gap": "HELM_STATUS_MISSING"},
    ]
    [entry] = daily(rows)
    assert (entry["equity_change"], entry["realized_change"], entry["samples"], entry["gaps"], entry["valid"]) == ("10", "2", 3, 1, 2)
    assert daily([{"bot": "v5", "at_ms": day, "gap": "x"}])[0]["equity_change"] is None
    # 288 slots, slot 7 missing, a restart sampling slot 3 twice: 288 samples but 287 slots with values.
    full = [{"bot": "v5", "at_ms": day + s * 300_000 + 1_000, "equity": "1"} for s in range(288) if s != 7]
    full.append({"bot": "v5", "at_ms": day + 3 * 300_000 + 60_000, "equity": "1"})
    [entry] = daily(full)
    assert (entry["samples"], entry["valid"]) == (288, 287)


def test_sampler_sleeps_to_the_next_slot_boundary():
    day = NOW_MS // 86_400_000 * 86_400_000
    assert seconds_to_next_slot(day + 2_000) == 298
    assert seconds_to_next_slot(day) == 300


class PaperUpstream:
    async def observation(self, path):
        section = path.split("?")[0].rsplit("/", 1)[-1]
        return read(section, WALLET if section == "wallet" else ACCOUNTING)


def signed_in(client):
    assert client.post("/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}).status_code == 200


def test_sampler_records_on_start_and_route_serves_rows(tmp_path):
    settings = replace(make_settings(tmp_path), paper_status_file=write_status(tmp_path, status()), helm_status_file=tmp_path / "helm" / "helm_v5_paper.status.json", money_sampler=True)
    app = create_app(settings=settings, upstream=PaperUpstream(), static_dir=tmp_path / "dist", clock=lambda: NOW_MS)
    with TestClient(app) as client:
        assert client.get("/api/v5/money").status_code == 401
        signed_in(client)
        body = None
        for _ in range(50):
            body = client.get("/api/v5/money", params={"range": "24h"}).json()
            if len(body["rows"]) >= 2:
                break
        assert body["sampler"] is True and body["started_at_ms"] == NOW_MS and "step_ms" not in body
        v5 = next(row for row in body["rows"] if row["bot"] == "v5")
        helm = next(row for row in body["rows"] if row["bot"] == "helm")
        assert v5["equity"] == "199318.98" and helm["gap"] == "HELM_STATUS_MISSING"
        assert client.get("/api/v5/money", params={"range": "1y"}).status_code == 422
        assert client.get("/api/v5/money", params={"range": "30d"}).status_code == 422
        assert client.post("/api/v5/money", headers={"Origin": ORIGIN}).status_code == 405


def test_sampler_is_off_by_default_and_daily_does_not_depend_on_range(tmp_path):
    settings = make_settings(tmp_path)
    ledger = MoneyLedger(settings.runtime_root)
    yesterday = NOW_MS // 86_400_000 * 86_400_000 - 86_400_000
    ledger.append([{"bot": "v5", "at_ms": at, "equity": "100"} for at in range(yesterday, NOW_MS + 1, 300_000)])
    app = create_app(settings=settings, static_dir=tmp_path / "dist", clock=lambda: NOW_MS)
    with TestClient(app) as client:
        signed_in(client)
        short, week = (client.get("/api/v5/money", params={"range": span}).json() for span in ("24h", "7d"))
        assert short["sampler"] is False
        assert short["daily"] == week["daily"]
        assert week["daily"][-1]["valid"] == 288  # yesterday, in full, whatever the range
        assert len(week["rows"]) > len(short["rows"]) and all(row["at_ms"] >= NOW_MS - 86_400_000 for row in short["rows"])


def test_recorder_failure_is_counted_and_never_stops_the_app(tmp_path, monkeypatch):
    settings = replace(make_settings(tmp_path), paper_status_file=write_status(tmp_path, status()), money_sampler=True)
    app = create_app(settings=settings, upstream=PaperUpstream(), static_dir=tmp_path / "dist", clock=lambda: NOW_MS)

    def full_disk(self, rows):
        raise OSError("no space left")

    monkeypatch.setattr(MoneyLedger, "append", full_disk)
    with TestClient(app) as client:
        signed_in(client)
        body = None
        for _ in range(50):
            body = client.get("/api/v5/money").json()
            if body["recorder_errors"]["count"]:
                break
        assert body["recorder_errors"]["last"] == "OSError" and body["rows"] == []
    # Leaving the client ran the shutdown; reaching here means cleanup did not raise.


def test_v5_row_keeps_the_owners_long_exact_decimals():
    # Live 15:20Z: realized/unrealized carry 25 fraction digits; a 24-digit limit recorded them as unknown.
    long = {**PROGRAM, "realized_pnl_quote": "114.1396691483993272381433853", "unrealized_pnl_quote": "-924.5333730858411272381433853"}
    controllers = {"modular_spot_meridian_v5_paper_btc": {**long, "realized_pnl_quote": "19.44857363037838614196480000", "unrealized_pnl_quote": "-139.1412407036821861419648000"}}
    row = v5_row(read("wallet", WALLET), read("accounting", {**ACCOUNTING, "program": long, "controllers": controllers}), NOW_MS)
    assert (row["realized"], row["unrealized"]) == ("114.1396691483993272381433853", "-924.5333730858411272381433853")
    assert row["coins"] == {"BTC": {"realized": "19.44857363037838614196480000", "unrealized": "-139.1412407036821861419648000"}}


def test_sampler_judges_helm_against_the_time_it_reads_the_file(tmp_path):
    # Live 15:20Z the Helm row read HELM_STATUS_CLOCK_SKEW: the slot time was taken before the paper reads, which
    # take seconds, while Helm rewrites its status every second. Here each paper read takes 10 s of clock time.
    clock = {"ms": NOW_MS}

    class SlowUpstream(PaperUpstream):
        async def observation(self, path):
            clock["ms"] += 10_000
            return await super().observation(path)

    helm_dir = tmp_path / "helm"
    helm_dir.mkdir()
    value = helm_status()
    value["generated_at"] = NOW + 8  # written while the paper reads ran
    helm_file = write_helm(helm_dir, value)
    settings = replace(make_settings(tmp_path), paper_status_file=write_status(tmp_path, status()), helm_status_file=helm_file, money_sampler=True)
    app = create_app(settings=settings, upstream=SlowUpstream(), static_dir=tmp_path / "dist", clock=lambda: clock["ms"])
    with TestClient(app) as client:
        signed_in(client)
        body = None
        for _ in range(50):
            body = client.get("/api/v5/money").json()
            if any(row["bot"] == "helm" for row in body["rows"]):
                break
        helm = next(row for row in body["rows"] if row["bot"] == "helm")
        assert helm.get("gap") != "HELM_STATUS_CLOCK_SKEW", helm
