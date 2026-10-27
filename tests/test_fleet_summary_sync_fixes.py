"""App/dashboard sync repairs: restriction join keys, held wallet/trading, controller net rules, incident order."""

import copy

from condor.web import fleet_summary as fs
from test_fleet_summary import (
    INCIDENTS,
    NOW_MS,
    SERVER,
    FakeReaders,
    _capability,
    _observed,
    account_analytics,
    card,
    iso,
    store,  # noqa: F401  (pytest fixture)
    sync,
)

# ── item 2: a restriction and its host incident carry the same join keys ──


def test_restrictions_keep_controller_and_source_for_the_incident_join():
    restriction = {
        "pair": "ETH-USDC",
        "side": "buy",
        "state": "restricted",
        "reason_code": "native_buy_create_refused",
        "alert": True,
        "controller_id": "modular_spot_v2_eth",
        "source": "native_buy_admission",
    }
    trading = fs.project_runtime_view(
        _observed(
            _capability(restrictions=[restriction], observed_at=iso(NOW_MS - 1_000))
        ),
        "bot",
        NOW_MS,
    )["trading"]
    [row] = trading["restrictions"]
    assert (row["controller_id"], row["source"]) == (
        "modular_spot_v2_eth",
        "native_buy_admission",
    )
    assert trading["observed_ms"] == NOW_MS - 1_000
    assert (trading["held"], trading["reason"]) == (False, None)


def test_malformed_join_keys_are_nulled_without_dropping_the_capability():
    restriction = {
        "pair": None,
        "side": "buy",
        "state": "restricted",
        "reason_code": "x",
        "alert": True,
        "controller_id": "c" * 101,
        "source": "Not A Source",
    }
    trading = fs.project_runtime_view(
        _observed(_capability(restrictions=[restriction])), "bot", NOW_MS
    )["trading"]
    assert trading is not None
    assert (
        trading["restrictions"][0]["controller_id"],
        trading["restrictions"][0]["source"],
    ) == (None, None)


ADMISSION_INCIDENT = {
    "id": "execution-v2-rsi:buy_admission_issue:2026-10-27T09:30:00+00:00:0123456789abcdef01234567",
    "service": "execution-v2-rsi",
    "code": "buy_admission_issue",
    "severity": "critical",
    "state": "open",
    "title": "Unresolved BUY admission fault",
    "first_seen_at": iso(NOW_MS - 60_000),
    "last_seen_at": iso(NOW_MS - 5_000),
    "bot": "rsi_modular_v2",
    "subject": {
        "controller_id": "modular_spot_v2_eth",
        "pair": "ETH-USDC",
        "reason_code": "native_buy_create_refused",
    },
}


def test_incident_items_carry_structured_bot_and_subject():
    payload = copy.deepcopy(INCIDENTS)
    payload["incident_store"]["incidents"] = [copy.deepcopy(ADMISSION_INCIDENT)]
    [item] = fs.project_incidents(payload, NOW_MS)["items"]
    assert item["bot"] == "rsi_modular_v2"
    assert item["subject"] == {
        "controller_id": "modular_spot_v2_eth",
        "pair": "ETH-USDC",
        "reason_code": "native_buy_create_refused",
    }


def test_malformed_incident_link_is_dropped_and_flagged_but_the_incident_stays():
    payload = copy.deepcopy(INCIDENTS)
    bad = copy.deepcopy(ADMISSION_INCIDENT)
    bad["subject"]["reason_code"] = "Not-Normalised"
    payload["incident_store"]["incidents"] = [bad]
    projected = fs.project_incidents(payload, NOW_MS)
    [item] = projected["items"]
    assert (item["bot"], item["subject"]) == ("rsi_modular_v2", None)
    assert projected["items_truncated"] is True
    assert projected["open"] == 1


# ── item 3: a failed owner runtime read keeps the last known capability ──


class RuntimeReaders(FakeReaders):
    """FakeReaders whose live bots publish a runtime observation with a trading capability."""

    def __init__(self, *args, runtime_ok=True, observed_ms=NOW_MS - 1_000, **kwargs):
        super().__init__(*args, **kwargs)
        self.runtime_ok, self.observed_ms = runtime_ok, observed_ms

    async def owner(self, bot, path, params):
        if path == "bootstrap" and bot != "ok_rsi_paper":
            self.calls.append((bot, path))
            if not self.runtime_ok:
                return fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)
            body = _observed(_capability(), self.observed_ms)
            body["runtime_status"]["bot_name"] = body["monitoring"]["bot_name"] = bot
            body["runtime_status"]["trading_capability"]["observed_at"] = iso(
                self.observed_ms
            )
            return fs.OwnerRead(body)
        return await super().owner(bot, path, params)


async def summary(store, readers, now_ms, last_known, view="full"):
    return await fs.build_fleet_summary(
        SERVER, view, readers, now_ms, is_admin=True, user_id=7, last_known=last_known
    )


@sync
async def test_failed_runtime_read_keeps_last_known_trading_with_its_own_time(store):
    last_known = fs.LastKnown()
    first = await summary(store, RuntimeReaders(store), NOW_MS, last_known)
    assert card(first, "ok_rsi")["trading"]["buy"] == "restricted"
    later = NOW_MS + 15_000
    second = await summary(
        store, RuntimeReaders(store, runtime_ok=False), later, last_known
    )
    trading = card(second, "ok_rsi")["trading"]
    assert trading is not None, "one failed owner read must not blank the capability"
    assert (trading["buy"], trading["sell"]) == ("unverified", "unverified")
    assert (trading["held"], trading["reason"]) == (True, fs.SOURCE_UNAVAILABLE)
    assert trading["observed_ms"] == NOW_MS - 1_000
    assert trading["restrictions"][0]["reason_code"] == "entry_decision_unavailable"
    assert not [g for g in card(second, "ok_rsi")["missing"] if g["field"] == "trading"]
    glance = await summary(
        store, RuntimeReaders(store, runtime_ok=False), later, last_known, "glance"
    )
    assert (
        next(b for b in glance["bots"] if b["bot"] == "ok_rsi")["trading"]
        == "restricted"
    )


@sync
async def test_held_trading_expires_and_a_null_capability_names_its_reason(store):
    last_known = fs.LastKnown()
    await summary(store, RuntimeReaders(store), NOW_MS, last_known)
    expired = NOW_MS - 1_000 + fs.TRADING_HOLD_MS + 1
    body = await summary(
        store, RuntimeReaders(store, runtime_ok=False), expired, last_known
    )
    ok = card(body, "ok_rsi")
    assert ok["trading"] is None
    assert {"field": "trading", "reason": fs.SOURCE_UNAVAILABLE} in ok["missing"]
    assert {
        "section": "bots",
        "bot": "ok_rsi",
        "field": "trading",
        "reason": fs.SOURCE_UNAVAILABLE,
    } in body["missing"]
    # A paper twin publishes no capability by design: no gap.
    assert not [
        g for g in card(body, "ok_rsi_paper")["missing"] if g["field"] == "trading"
    ]


# ── item 4: a transient account read failure does not blank the wallet ──


class WalletReaders(FakeReaders):
    def __init__(self, *args, account=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.account_read = account

    async def account(self, server, user_id):
        return (
            self.account_read
            if self.account_read is not None
            else await super().account(server, user_id)
        )


@sync
async def test_failed_account_read_holds_the_last_wallet_within_its_stale_window(store):
    last_known = fs.LastKnown()
    first = await summary(store, WalletReaders(store), NOW_MS, last_known)
    assert (
        first["wallet"]["held"] is False
        and first["sections"]["wallet"]["status"] == "ok"
    )
    failed = WalletReaders(store, account=fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE))
    later = NOW_MS + 15_000  # the observation is now 45 s old: inside the 120 s window
    body = await summary(store, failed, later, last_known)
    assert body["wallet"] is not None, "one slow account read must not blank the wallet"
    assert body["wallet"]["held"] is True
    assert body["wallet"]["observed_at_ms"] == NOW_MS - 30_000
    assert body["wallet"]["equity"] == "1000" and body["wallet"]["stale"] is False
    assert body["sections"]["wallet"]["observed_at_ms"] == NOW_MS - 30_000
    assert not [m for m in body["missing"] if m.get("section") == "wallet"]
    glance = await summary(store, failed, later, last_known, "glance")
    assert glance["wallet"]["held"] is True


@sync
async def test_held_wallet_ends_at_its_stale_window_and_never_masks_a_real_answer(
    store,
):
    last_known = fs.LastKnown()
    await summary(store, WalletReaders(store), NOW_MS, last_known)
    failed = WalletReaders(store, account=fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE))
    too_old = NOW_MS - 30_000 + fs.STALE_AFTER_MS["wallet"] + 1
    body = await summary(store, failed, too_old, last_known)
    assert (
        body["wallet"] is None
        and body["sections"]["wallet"]["reason"] == fs.SOURCE_UNAVAILABLE
    )
    for answer in (fs.OwnerRead(None, fs.FORBIDDEN), fs.OwnerRead({"scope": {}}, None)):
        body = await summary(
            store, WalletReaders(store, account=answer), NOW_MS + 1_000, last_known
        )
        assert body["wallet"] is None, answer
    # A held value is never renewed: only a new valid read replaces it.
    newer = fs.OwnerRead(account_analytics(NOW_MS - 1_000, amount="1200"))
    await summary(store, WalletReaders(store, account=newer), NOW_MS, last_known)
    body = await summary(store, failed, NOW_MS + 30_000, last_known)
    assert (body["wallet"]["equity"], body["wallet"]["held"]) == ("1200", True)


# ── item 5: net_now applies the dashboard's projectControllerPnl rules ──


def native_page(now_ms=NOW_MS, **bot_overrides):
    observed = now_ms / 1000 - 2
    bot = {
        "bot_name": "bot",
        "status": "running",
        "num_controllers": 2,
        "controller_count_current": True,
        "performance_received_at": observed,
        "performance_stale_after_seconds": 30.0,
        "status_received_at": observed,
        "status_stale_after_seconds": 30.0,
    }
    bot.update(bot_overrides)
    controllers = [
        {
            "bot_name": "bot",
            "controller_id": "eth",
            "trading_pair": "ETH-USDC",
            "realized_pnl_quote": 1.0,
            "unrealized_pnl_quote": 0.5,
            "global_pnl_quote": 1.5,
            "custom_info": {},
        },
        {
            "bot_name": "bot",
            "controller_id": "btc",
            "trading_pair": "BTC-USDC",
            "realized_pnl_quote": -0.25,
            "unrealized_pnl_quote": 0.0,
            "global_pnl_quote": -0.25,
            "custom_info": {},
        },
    ]
    return {"bots": [bot], "controllers": controllers}


def test_controller_net_is_the_sum_of_a_current_complete_native_page():
    assert fs._controller_net(native_page(), "bot", NOW_MS) == (
        fs.Decimal("1.25"),
        "USDC",
    )


def test_controller_net_rejects_what_the_dashboard_rejects():
    stale = native_page(performance_received_at=NOW_MS / 1000 - 31)
    assert (
        fs._controller_net(stale, "bot", NOW_MS) is None
    ), "performance older than 30 s"
    old_status = native_page(status_received_at=NOW_MS / 1000 - 40)
    assert (
        fs._controller_net(old_status, "bot", NOW_MS) is None
    ), "status older than 30 s"
    future = native_page(performance_received_at=NOW_MS / 1000 + 6)
    assert (
        fs._controller_net(future, "bot", NOW_MS) is None
    ), "more than 5 s in the future"
    assert (
        fs._controller_net(native_page(controller_count_current=False), "bot", NOW_MS)
        is None
    )
    assert (
        fs._controller_net(native_page(num_controllers=3), "bot", NOW_MS) is None
    ), "incomplete page"
    non_native = native_page()
    for key in ("performance_received_at", "status_received_at"):
        del non_native["bots"][0][key]
    assert (
        fs._controller_net(non_native, "bot", NOW_MS) is None
    ), "no native observation time"
    unreconciled = native_page()
    unreconciled["controllers"][0]["global_pnl_quote"] = 1.6
    assert (
        fs._controller_net(unreconciled, "bot", NOW_MS) is None
    ), "total != realized + unrealized"
    missing_total = native_page()
    missing_total["controllers"][1]["global_pnl_quote"] = None
    assert fs._controller_net(missing_total, "bot", NOW_MS) is None
    duplicate = native_page()
    duplicate["controllers"][1]["controller_id"] = "eth"
    assert fs._controller_net(duplicate, "bot", NOW_MS) is None
    mixed = native_page()
    mixed["controllers"][1]["trading_pair"] = "BTC-USDT"
    assert fs._controller_net(mixed, "bot", NOW_MS) is None, "two quotes"
    textual = native_page()
    textual["controllers"][1]["global_pnl_quote"] = "-0.25"
    assert (
        fs._controller_net(textual, "bot", NOW_MS) is None
    ), "only finite JSON numbers count"


def test_multi_symbol_controller_counts_its_aggregate_once():
    page = native_page(num_controllers=1)
    page["controllers"] = [
        {
            "bot_name": "bot",
            "controller_id": "unified",
            "trading_pair": "",
            "custom_info": {"symbols": {"ETH-USDC": {}, "BTC-USDC": {}}},
            "realized_pnl_quote": 2.0,
            "unrealized_pnl_quote": -1.0,
            "global_pnl_quote": 1.0,
        },
    ]
    assert fs._controller_net(page, "bot", NOW_MS) == (fs.Decimal("1.0"), "USDC")
    page["controllers"][0]["custom_info"]["symbols"]["ETH-USDT"] = {}
    assert fs._controller_net(page, "bot", NOW_MS) is None


# ── item 6: the incident detail order is explicit ──


def test_incident_order_fallbacks_and_tie_break():
    payload = copy.deepcopy(INCIDENTS)
    payload["incident_store"]["incidents"] = [
        {
            "id": "b-open",
            "severity": "warning",
            "state": "open",
            "first_seen_at": iso(NOW_MS - 3_000),
        },
        {
            "id": "a-open",
            "severity": "warning",
            "state": "open",
            "first_seen_at": iso(NOW_MS - 9_000),
            "last_seen_at": iso(NOW_MS - 3_000),
        },
        {
            "id": "crit-old",
            "severity": "critical",
            "state": "open",
            "first_seen_at": iso(NOW_MS - 90_000),
            "last_seen_at": iso(NOW_MS - 80_000),
        },
        {
            "id": "resolved-late",
            "severity": "warning",
            "state": "resolved",
            "first_seen_at": iso(NOW_MS - 9_000),
            "last_seen_at": iso(NOW_MS - 8_000),
            "resolved_at": iso(NOW_MS - 1_000),
        },
        {
            "id": "resolved-seen-late",
            "severity": "critical",
            "state": "resolved",
            "first_seen_at": iso(NOW_MS - 9_000),
            "last_seen_at": iso(NOW_MS - 2_000),
            "resolved_at": iso(NOW_MS - 2_000),
        },
    ]
    order = [item["id"] for item in fs.project_incidents(payload, NOW_MS)["items"]]
    # open critical > open warning (newest last_seen, else first_seen; ties by id) > resolved by resolved_at.
    assert order == [
        "crit-old",
        "a-open",
        "b-open",
        "resolved-late",
        "resolved-seen-late",
    ]
