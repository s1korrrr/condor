"""Native pairless portfolio bootstrap admission, using a read-only reporting capture."""

import copy
import json
from pathlib import Path

import pytest

from condor.web import fleet_summary as fs
from tests.test_fleet_summary import SERVER, FakeReaders, card, store, sync

FIXTURE = Path(__file__).parent / "fixtures" / "v3_pairless_bootstrap_20261029.json"
BOT = "meridian_v3"


def captured():
    return json.loads(FIXTURE.read_text())


def capture_time(payload):
    return fs._instant_ms(payload["runtime_status"]["updated_at"]) + 1_000


def test_native_pairless_portfolio_keeps_runtime_counts_and_capability():
    payload = captured()
    before = copy.deepcopy(payload)
    runtime = payload["runtime_status"]
    assert runtime["controllers"][0]["pair"] is None
    assert {row["pair"] for row in runtime["operations"]["pairs"]} == {
        "BNB-USDC",
        "BTC-USDC",
        "ETH-USDC",
        "SOL-USDC",
        "XRP-USDC",
    }

    view = fs.project_runtime_view(payload, BOT, capture_time(payload))

    assert view is not None
    assert view["current"] is True
    assert view["executors"] == len(runtime["active_executors"]) == 1
    assert (view["trading"]["buy"], view["trading"]["sell"]) == (
        "can_trade",
        "can_trade",
    )
    assert "held" not in view  # Holdings and portfolio totals are not re-derived.
    assert payload == before  # Never invent a single controller pair or expand totals.


def test_pairless_runtime_rejects_unbound_executor_even_with_matching_lifecycle():
    payload = captured()
    for field in ("active_executors", "lifecycle_executors"):
        payload["runtime_status"][field][0]["controller_id"] = "other-controller"
    assert fs.project_runtime_view(payload, BOT, capture_time(payload)) is None


# The proof must be complete, same-snapshot and bound to a known controller/connector.
# A malformed pair string must never become eligible through the pairless branch.


@pytest.mark.parametrize(
    "path,value",
    [
        (("operations",), None),
        (("operations", "schema_version"), 2),
        (("operations", "schema_version"), True),
        (("operations", "pairs"), None),
        (("operations", "pairs"), {}),
        (("operations", "pairs"), []),
        (("operations", "pairs"), [None]),
        (("operations", "observed_at"), None),
        (("operations", "observed_at"), "2026-10-29T12:56:56"),
        (("operations", "observed_at"), "2026-10-29T12:56:55+00:00"),
        (("operations", "observed_at"), "2026-10-29T12:56:57+00:00"),
        (("operations", "pairs", 0, "observed_at"), None),
        (("operations", "pairs", 0, "observed_at"), "2026-10-29T12:55:56+00:00"),
        (("operations", "pairs", 0, "observed_at"), "2026-10-29T12:56:57+00:00"),
        (("operations", "pairs", 0, "pair"), "bnb-usdc"),
        (("operations", "pairs", 0, "pair"), None),
        (("operations", "pairs", 0, "pair"), ["BNB-USDC"]),
        (("operations", "pairs", 0, "controller_id"), "other-controller"),
        (("operations", "pairs", 0, "controller_id"), None),
        (("operations", "pairs", 0, "controller_id"), {}),
        (("operations", "pairs", 0, "connector"), "binance"),
        (("operations", "pairs", 0, "connector"), None),
        (("controllers", 0, "controller_id"), None),
        (("controllers", 0, "controller_id"), "bad\nidentity"),
        (("controllers", 0, "connector_name"), "binance"),
        (("controllers", 0, "pair"), ""),
        (("controllers", 0, "pair"), 42),
        (("controllers", 0, "pair"), "BNBUSDC"),
        (("active_executors", 0, "pair"), "ETH-USDC"),
        (("active_executors", 0, "connector_name"), "binance"),
        (("lifecycle_executors",), []),
        (("lifecycle_executors",), None),
        (("bot_name",), "other-bot"),
    ],
)
def test_missing_malformed_or_mismatched_proof_is_rejected(path, value):
    payload = captured()
    target = payload["runtime_status"]
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    assert fs.project_runtime_view(payload, BOT, capture_time(captured())) is None


@pytest.mark.parametrize(
    "age_ms,admitted",
    [
        (29_999, True),
        (30_000, False),
        (180_000, False),
        (-5_000, True),
        (-5_001, False),
    ],
)
def test_portfolio_proof_obeys_native_freshness_cap(age_ms, admitted):
    payload = captured()
    observed = fs._instant_ms(payload["runtime_status"]["updated_at"])
    view = fs.project_runtime_view(payload, BOT, observed + age_ms)
    assert (view is not None) is admitted


def test_shorter_monitoring_threshold_also_expires_portfolio_proof():
    payload = captured()
    payload["monitoring"]["stale_threshold_seconds"] = 1
    assert fs.project_runtime_view(payload, BOT, capture_time(payload)) is None


@pytest.mark.parametrize(
    "kind",
    [
        "missing-operations",
        "missing-pair",
        "duplicate",
        "single-pair",
        "executor-outside-scope",
        "second-pairless",
        "wrong-monitor",
    ],
)
def test_incomplete_or_ambiguous_scope_is_rejected(kind):
    payload = captured()
    runtime = payload["runtime_status"]
    pairs = runtime["operations"]["pairs"]
    if kind == "missing-operations":
        del runtime["operations"]
    elif kind == "missing-pair":
        del runtime["controllers"][0]["pair"]
    elif kind == "duplicate":
        pairs.append(copy.deepcopy(pairs[0]))
    elif kind == "single-pair":
        runtime["operations"]["pairs"] = pairs[:1]
    elif kind == "executor-outside-scope":
        runtime["operations"]["pairs"] = [
            row for row in pairs if row["pair"] != "BTC-USDC"
        ]
    elif kind == "second-pairless":
        runtime["controllers"].append(
            dict(runtime["controllers"][0], controller_id="unproven")
        )
    elif kind == "wrong-monitor":
        payload["monitoring"]["bot_name"] = "other-bot"
    assert fs.project_runtime_view(payload, BOT, capture_time(payload)) is None


def test_second_portfolio_needs_its_own_proof_and_is_not_double_counted():
    payload = captured()
    runtime = payload["runtime_status"]
    runtime["controllers"].append(
        dict(runtime["controllers"][0], controller_id="second")
    )
    runtime["operations"]["pairs"].extend(
        dict(row, controller_id="second")
        for row in list(runtime["operations"]["pairs"])
    )
    view = fs.project_runtime_view(payload, BOT, capture_time(payload))
    assert view is not None
    assert view["executors"] == 1


@sync
async def test_pairless_bootstrap_reaches_fleet_card_when_quant_is_unavailable(store):
    payload = captured()

    class Readers(FakeReaders):
        async def owner(self, bot, path, params):
            self.calls.append((bot, path))
            if path == "bootstrap":
                return fs.OwnerRead(copy.deepcopy(payload))
            return fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)

    body = await fs.build_fleet_summary(
        SERVER,
        "full",
        Readers(store, registry=[BOT]),
        capture_time(payload),
        is_admin=False,
        user_id=7,
    )
    v3 = card(body, BOT)
    assert (v3["executors"], v3["executors_basis"]) == (1, "runtime_active_executors")
    assert v3["report_stale"] is False
    assert v3["report_at_ms"] == fs._instant_ms(payload["runtime_status"]["updated_at"])
    assert (v3["trading"]["buy"], v3["trading"]["sell"]) == ("can_trade", "can_trade")
    assert v3["positions"] is None
    assert v3["net_now"] is None
    assert not [
        gap
        for gap in v3["missing"]
        if gap["field"] in ("executors", "trading", "report_at_ms")
    ]


def test_malformed_duplicate_controller_scope_is_rejected_without_raising():
    payload = captured()
    runtime = payload["runtime_status"]
    runtime["controllers"].append(dict(runtime["controllers"][0], pair={"bad": "pair"}))
    assert fs.project_runtime_view(payload, BOT, capture_time(payload)) is None
