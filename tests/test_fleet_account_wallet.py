"""The fleet wallet must describe the account owner's whole inventory, not a bot subset."""

import asyncio
import copy
from datetime import datetime, timezone

import pytest
from test_fleet_summary import NOW_MS, SERVER, FakeReaders, client_for, store, sync

from condor.web import fleet_summary as fs
from condor.web.routes import fleet_summary as routes


def account_current(*, total="900", complete=False, unpriced=("PLN",), age_ms=1000):
    from test_fleet_summary import iso

    return {
        "schema_version": 1,
        "quote_currency": "USDT",
        "scope": {
            "account": "master_account",
            "connector": "okx",
            "market": "spot",
            "identity": "account-revision-1",
        },
        "capture_mode": "observation-driven",
        "current": {
            "observed_at": iso(NOW_MS - age_ms),
            "priced_total": total,
            "valuation_complete": complete,
            "unpriced_assets": list(unpriced),
            "holdings": [],
        },
        "history": None,
        "changes": [],
        "performance": {"available": False, "reason": "Cash flows not reconciled"},
    }


class AccountReaders(FakeReaders):
    def __init__(self, store, account=None):
        super().__init__(store)
        self.account_payload = account if account is not None else account_current()

    async def account(self, server, user_id):
        assert server == SERVER and user_id == 7
        return fs.OwnerRead(copy.deepcopy(self.account_payload))


@sync
async def test_partial_account_cannot_be_promoted_from_complete_bot_wallet(store):
    body = await fs.build_fleet_summary(
        SERVER, "full", AccountReaders(store), NOW_MS, is_admin=True, user_id=7
    )
    assert body["wallet"] == {
        "equity": "900",
        "unit": "USDT",
        "observed_at_ms": NOW_MS - 1000,
        "source_bot": None,
        "source": "native_account_portfolio",
        "account_scope": {
            "account": "master_account",
            "connector": "okx",
            "market": "spot",
            "identity": "account-revision-1",
        },
        "valuation_complete": False,
        "unpriced_assets": ["PLN"],
        "unpriced_count": 1,
        "stale": False,
    }
    assert body["sections"]["wallet"]["status"] == "partial"
    assert {"section": "wallet", "reason": fs.PARTIAL_COVERAGE} in body["missing"]
    assert body["pnl"]["day"]["total"] is not None


@sync
async def test_account_complete_and_absent_scope_are_distinct(store):
    complete = account_current(total="1000", complete=True, unpriced=())
    good = await fs.build_fleet_summary(
        SERVER,
        "glance",
        AccountReaders(store, complete),
        NOW_MS,
        is_admin=True,
        user_id=7,
    )
    assert good["wallet"]["valuation_complete"] is True
    assert good["wallet"]["source_bot"] is None
    assert good["sections"]["wallet"]["status"] == "ok"
    absent = copy.deepcopy(complete)
    absent["scope"] = None
    missing = await fs.build_fleet_summary(
        SERVER,
        "glance",
        AccountReaders(store, absent),
        NOW_MS,
        is_admin=True,
        user_id=7,
    )
    assert missing["wallet"] is None
    assert missing["sections"]["wallet"]["status"] == "missing"


@sync
async def test_account_observed_during_await_uses_publication_clock(store):
    # No sleeps: status/network work moved time past the old entry clock before
    # the owner published the account observation.
    observed = NOW_MS + 6_000
    clocks = iter((observed, observed + 1_000))
    payload = account_current(total="1000", complete=True, unpriced=(), age_ms=-6_000)
    body = await fs.build_fleet_summary(
        SERVER,
        "glance",
        AccountReaders(store, payload),
        NOW_MS,
        is_admin=True,
        user_id=7,
        clock_ms=lambda: next(clocks),
    )
    assert body["generated_at_ms"] == observed + 1_000
    assert body["wallet"]["observed_at_ms"] == observed
    assert body["wallet"]["stale"] is False
    assert body["sections"]["wallet"]["status"] == "ok"


@pytest.mark.parametrize("bad", ["1e1000000", "9" * 39, "1\n", "NaN"])
def test_unencodable_account_amount_never_borrows_bot_wallet(bad):
    payload = account_current(total=bad, complete=True, unpriced=())
    missing = []
    wallet, section = fs._wallet_section(fs.OwnerRead(payload), NOW_MS, missing)
    assert wallet is None
    assert section["status"] == "missing"
    assert missing == [{"section": "wallet", "reason": fs.INVALID}]


@pytest.mark.parametrize(
    "scope",
    [
        None,
        {},
        {
            "account": "master_account",
            "connector": "okx",
            "market": "spot",
            "identity": "",
        },
        {
            "account": "master_account",
            "connector": "okx",
            "market": "spot",
            "identity": "   ",
        },
    ],
)
def test_account_scope_must_be_bound(scope):
    payload = account_current(total="1000", complete=True, unpriced=())
    payload["scope"] = scope
    wallet, section = fs._wallet_section(fs.OwnerRead(payload), NOW_MS, [])
    assert wallet is None and section["status"] == "missing"


def test_partial_account_staleness_is_independent_of_coverage():
    wallet, section = fs._wallet_section(
        fs.OwnerRead(account_current(age_ms=200_000)), NOW_MS, []
    )
    assert wallet["valuation_complete"] is False and wallet["stale"] is True
    assert section["status"] == "partial" and section["reason"] == fs.PARTIAL_COVERAGE
    assert section["observed_at_ms"] == NOW_MS - 200_000


def test_many_unpriced_assets_report_count_without_expanding_glance():
    assets = [f"TOKEN{i}" for i in range(30)]
    wallet, _ = fs._wallet_section(
        fs.OwnerRead(account_current(unpriced=assets)), NOW_MS, []
    )
    assert wallet["unpriced_count"] == 30
    assert wallet["unpriced_assets"] == assets[: fs.GLANCE_MAX_BOTS]


def test_actual_account_reader_uses_same_native_adapter_and_access_guard(monkeypatch):
    calls = []

    class Portfolio:
        async def _get(self, path, *, params):
            calls.append((path, params))
            payload = account_current(total="1000", complete=True, unpriced=())
            payload["current"]["observed_at"] = datetime.now(timezone.utc).isoformat()
            return payload

    class Config:
        def has_server_access(self, user_id, name):
            return user_id == 7 and name == SERVER

        async def get_client(self, name):
            assert name == SERVER
            return type("Client", (), {"portfolio": Portfolio()})()

    monkeypatch.setattr(routes, "get_config_manager", Config)
    reader = routes.LiveReaders()
    denied = asyncio.run(reader.account(SERVER, 8))
    assert denied.payload is None and denied.reason == fs.FORBIDDEN and not calls
    accepted = asyncio.run(reader.account(SERVER, 7))
    assert (
        accepted.reason is None
        and accepted.payload["scope"]["identity"] == "account-revision-1"
    )
    assert calls == [("portfolio/analytics", {"range": "1D", "refresh": "false"})]


def test_http_legacy_withholds_partial_wallet_until_explicit_native_claims(
    monkeypatch, store
):
    client = client_for(monkeypatch, store, readers=AccountReaders(store))
    for view in ("full", "glance"):
        path = f"/api/v1/servers/{SERVER}/fleet/summary?view={view}"
        legacy = client.get(path)
        assert legacy.status_code == 200
        assert legacy.json()["wallet"] is None
        assert legacy.json()["sections"]["wallet"]["status"] == "partial"
        assert "X-RSIBOT-Wallet-Claims" in legacy.headers["Vary"]
        opted = client.get(
            path, headers={"X-RSIBOT-Wallet-Claims": "native-account-v1"}
        )
        assert opted.status_code == 200
        body = opted.json()
        assert body["wallet"]["source"] == "native_account_portfolio"
        assert body["wallet"]["valuation_complete"] is False
        assert body["wallet"]["source_bot"] is None
        assert body["sections"]["wallet"] == legacy.json()["sections"]["wallet"]
        assert body["pnl"] == legacy.json()["pnl"]
        assert opted.headers["ETag"] != legacy.headers["ETag"]
        assert (
            client.get(
                path, headers={"If-None-Match": legacy.headers["ETag"]}
            ).status_code
            == 304
        )
        assert (
            client.get(
                path,
                headers={
                    "If-None-Match": opted.headers["ETag"],
                    "X-RSIBOT-Wallet-Claims": "native-account-v1",
                },
            ).status_code
            == 304
        )
        assert (
            client.get(
                path,
                headers={
                    "If-None-Match": legacy.headers["ETag"],
                    "X-RSIBOT-Wallet-Claims": "native-account-v1",
                },
            ).status_code
            == 200
        )
        assert (
            client.get(
                path, headers={"If-None-Match": opted.headers["ETag"]}
            ).status_code
            == 200
        )


def test_http_complete_wallet_remains_visible_to_legacy_clients(monkeypatch, store):
    complete = account_current(total="1000", complete=True, unpriced=())
    client = client_for(monkeypatch, store, readers=AccountReaders(store, complete))
    for view in ("full", "glance"):
        path = f"/api/v1/servers/{SERVER}/fleet/summary?view={view}"
        response = client.get(path)
        assert response.status_code == 200
        assert response.json()["wallet"]["equity"] == "1000"
        assert response.json()["wallet"]["valuation_complete"] is True


def test_http_legacy_projection_does_not_mutate_canonical_micro_cache(
    monkeypatch, store
):
    readers = AccountReaders(store)
    client = client_for(monkeypatch, store, readers=readers)
    monkeypatch.setattr(routes, "CACHE_TTL_SECONDS", 60)
    path = f"/api/v1/servers/{SERVER}/fleet/summary"
    legacy = client.get(path)
    assert legacy.status_code == 200 and legacy.json()["wallet"] is None
    owner_calls = list(readers.calls)
    opted = client.get(path, headers={"X-RSIBOT-Wallet-Claims": "native-account-v1"})
    assert opted.status_code == 200
    assert opted.json()["wallet"]["equity"] == "900"
    assert readers.calls == owner_calls
    assert routes._cache[(SERVER, True)]["full"][1]["wallet"]["equity"] == "900"
    glance = client.get(
        path + "?view=glance",
        headers={"X-RSIBOT-Wallet-Claims": "native-account-v1"},
    )
    assert glance.json()["wallet"]["equity"] == "900"
    assert readers.calls == owner_calls
