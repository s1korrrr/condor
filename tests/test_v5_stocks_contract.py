"""Executable with stdlib unittest; fixtures are synthetic public observations."""

import copy
import unittest

from condor.v5.stocks import (
    StockPayloadError,
    validate_stock_payload,
    validate_stock_query,
)


NOW = 1_793_620_800
IDENTITY = {"region": "eea", "instId": "EXAMPLE-USDT-270101", "instType": "FUTURES"}
DATASETS = ("ticker", "mark_price", "index_price", "funding", "open_interest")


def event(dataset="ticker", **changes):
    return {
        **IDENTITY,
        "dataset": dataset,
        "event_time_ms": NOW * 1000 - 1000,
        "received_at_ms": NOW * 1000,
        "source": "ws",
        "data": {"last": "123.456789012345678901", "ts": str(NOW * 1000 - 1000)},
        **changes,
    }


def row():
    return {
        "instrument": {"instId": IDENTITY["instId"], "instType": "FUTURES", "instCategory": "3", "state": "live", "ruleType": "xperp", "quoteCcy": "USDT", "ctVal": "0.001"},
        "latest": {name: event() if name == "ticker" else None for name in DATASETS},
        "channels": {"ticker": {"state": "live", "event_time_ms": NOW * 1000 - 1000, "received_at_ms": NOW * 1000, "age_s": 0, "reason": None}},
        "coverage": {"capture_started_at": NOW - 3600, "candle_start": NOW - 3600, "candle_end": NOW - 60, "historical_trades": False, "historical_books": False},
        "captured": True,
    }


def listed_only(instrument_id="LISTED-USDT-SWAP", instrument_type="SWAP"):
    return {
        "instrument": {"instId": instrument_id, "instType": instrument_type, "instCategory": "3", "state": "live", "quoteCcy": "USDT", "settleCcy": "USDT"},
        "latest": dict.fromkeys(DATASETS),
        "channels": {},
        "coverage": {"capture_started_at": None, "candle_start": None, "candle_end": None, "historical_trades": False, "historical_books": False},
        "captured": False,
    }


def catalog(state="live"):
    return {"format": "okx-stocks-v1", "now": NOW, "region": "eea", "state": state, "catalog_at": NOW - 30, "updated_at": NOW, "reason": None, "rows": [row()], "capture": [{"instType": "FUTURES", "instId": IDENTITY["instId"], "listed": True}]}


def market():
    data = catalog()
    data.pop("capture")
    observation = data.pop("rows")[0]
    return {**data, **IDENTITY, "format": "okx-stock-market-v1", "latest": {**observation["latest"], "books": None}, "channels": observation["channels"], "coverage": observation["coverage"], "recent_trades": [], "book_depth": None, "captured": True}


def candles():
    end = NOW - 60
    buckets = [[end - (59 - index) * 60, None, None, None, None, None, 0, 0, 0, 1, 0, 0] for index in range(60)]
    return {"format": "okx-stock-candles-v1", "now": NOW, **IDENTITY, "state": "live", "reason": None, "range": "1h", "res_s": 60, "start": end - 59 * 60, "end": end, "volume_unit": "contracts", "price_basis": "trade", "adjustment": "raw", "buckets": buckets, "totals": {"final": 0, "no_trade": 0, "unrecoverable": 0, "missing": 60, "pending": 0, "corrections": 0}, "captured": True}


class StockContractTests(unittest.TestCase):
    def test_exact_id_queries_keep_futures_suffix_and_region(self):
        query = validate_stock_query("stock-candles", list(IDENTITY.items()))
        self.assertEqual(query, {**IDENTITY, "range": "24h"})
        self.assertNotIn("res", query)
        self.assertEqual(validate_stock_query("stocks", [("region", "global")]), {"region": "global"})
        dotted = {**IDENTITY, "instId": "XBRK.B-USDT"}
        self.assertEqual(validate_stock_query("stock-market", list(dotted.items())), dotted)

    def test_query_rejects_ambiguous_or_unsafe_identity(self):
        invalid = [
            [("region", "eea"), ("region", "global")],
            [("region", "auto")],
            [("region", "eea"), ("url", "https://example.invalid")],
        ]
        for items in invalid:
            with self.subTest(items=items), self.assertRaises(ValueError):
                validate_stock_query("stocks", items)
        for value in ("../secrets", "A/B", "https://host/x", "A..B-USDT", "A-" + "B" * 79):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_stock_query("stock-market", list({**IDENTITY, "instId": value}.items()))
        for field, value in (("instType", "MARGIN"), ("range", "30d"), ("res", "5m")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_stock_query("stock-candles", list({**IDENTITY, field: value}.items()))

    def test_decimal_strings_metadata_and_empty_states_are_preserved(self):
        payload = catalog()
        metadata = payload["rows"][0]["instrument"]
        metadata.update(instIdCode=1000000, tradeQuoteCcyList=["USDT", "USDC"], upcChg=[{"param": "tickSz", "newValue": "0.0001", "effTime": str(NOW * 1000 + 86400000)}])
        result = validate_stock_payload("stocks", payload, {"region": "eea"})
        self.assertEqual(result["rows"][0]["instrument"], metadata)
        self.assertEqual(result["rows"][0]["latest"]["ticker"]["data"]["last"], "123.456789012345678901")
        self.assertEqual(result["rows"][0]["instrument"]["ctVal"], "0.001")
        for state in ("disabled", "starting", "empty", "error"):
            payload = {**catalog(state), "rows": [], "capture": [], "reason": "discovery_failed" if state == "error" else "stocks_not_configured" if state == "disabled" else None}
            if state in ("disabled", "starting", "error"):
                payload["catalog_at"] = None
            with self.subTest(state=state):
                self.assertEqual(validate_stock_payload("stocks", payload, {"region": "eea"})["rows"], [])

    def test_partial_discovery_preserves_observed_counts_without_claiming_complete_catalog(self):
        payload = catalog("error")
        payload["reason"] = "catalog_incomplete"
        payload["discovery"] = {"complete": False, "families": {"FUTURES": {"total": 2, "classified": 1, "unclassified": 1, "stocks": 1}}, "warnings": ["One instrument is unclassified"]}
        self.assertFalse(validate_stock_payload("stocks", payload, {"region": "eea"})["discovery"]["complete"])
        payload["discovery"]["complete"] = True
        with self.assertRaises(StockPayloadError):
            validate_stock_payload("stocks", payload, {"region": "eea"})

    def test_bad_classification_duplicate_rows_and_event_identity_fail_closed(self):
        for mutate in (
            lambda p: p["rows"][0]["instrument"].update(instCategory="1"),
            lambda p: p["rows"].append(copy.deepcopy(p["rows"][0])),
            lambda p: p["rows"][0]["latest"]["ticker"].update(region="global"),
            lambda p: p["rows"][0]["latest"]["ticker"].update(instId="OTHER-USDT"),
            lambda p: p["rows"][0]["latest"]["ticker"].update(dataset="mark_price"),
            lambda p: p["rows"][0]["latest"]["ticker"].update(source="private"),
        ):
            payload = catalog()
            mutate(payload)
            with self.assertRaises(StockPayloadError):
                validate_stock_payload("stocks", payload, {"region": "eea"})

    def test_hostile_json_values_and_non_nullable_contract_fields_fail(self):
        for mutate in (
            lambda p: p.update(now=True),
            lambda p: p.update(now=float("inf")),
            lambda p: p.update(state=[]),
            lambda p: p.update(catalog_at=NOW + 3600),
            lambda p: p["rows"][0]["instrument"].update(state="\ud800"),
            lambda p: p["rows"][0]["channels"]["ticker"].update(age_s=-1),
            lambda p: p["rows"][0]["coverage"].update(historical_books=True),
        ):
            payload = catalog()
            mutate(payload)
            with self.assertRaises(StockPayloadError):
                validate_stock_payload("stocks", payload, {"region": "eea"})

    def test_market_matches_requested_identity_and_bounded_public_book(self):
        payload = market()
        self.assertEqual(validate_stock_payload("stock-market", payload, IDENTITY)["instId"], IDENTITY["instId"])
        with self.assertRaises(StockPayloadError):
            validate_stock_payload("stock-market", payload, {**IDENTITY, "instType": "SWAP"})
        payload["latest"]["books"] = event("books", data={"bids": [["100", "2", "0", "1"]], "asks": [["101", "3", "0", "2"]]})
        payload["book_depth"] = {"bids": 1, "asks": 1}
        validate_stock_payload("stock-market", payload, IDENTITY)
        payload["book_depth"]["asks"] = 2
        with self.assertRaises(StockPayloadError):
            validate_stock_payload("stock-market", payload, IDENTITY)
        payload = market()
        payload["recent_trades"] = [event("trades")] * 51
        with self.assertRaises(StockPayloadError):
            validate_stock_payload("stock-market", payload, IDENTITY)

    def test_capture_allowlist_and_listed_only_rows_are_preserved(self):
        payload = catalog()
        payload["rows"].append(listed_only())
        payload["capture"].append({"instType": "SWAP", "instId": "MISSING-USDT-SWAP", "listed": False})
        result = validate_stock_payload("stocks", payload, {"region": "eea"})
        self.assertEqual([item["captured"] for item in result["rows"]], [True, False])
        self.assertEqual(result["rows"][1]["channels"], {})
        self.assertEqual(result["capture"][1], {"instType": "SWAP", "instId": "MISSING-USDT-SWAP", "listed": False})
        discovery_only = catalog()
        discovery_only["rows"] = [listed_only(), listed_only("OTHER-USDT-SWAP")]
        discovery_only["capture"] = []
        self.assertEqual(validate_stock_payload("stocks", discovery_only, {"region": "eea"})["capture"], [])
        allowlisted = [{"instType": "SWAP", "instId": f"S{index:03d}-USDT-SWAP", "listed": False} for index in range(64)]
        self.assertEqual(len(validate_stock_payload("stocks", {**catalog("empty"), "rows": [], "capture": allowlisted}, {"region": "eea"})["capture"]), 64)
        for market_captured in (True, False):
            for view, fixture, query in (("stock-market", market, IDENTITY), ("stock-candles", candles, {**IDENTITY, "range": "1h"})):
                with self.subTest(view=view, captured=market_captured):
                    self.assertIs(validate_stock_payload(view, {**fixture(), "captured": market_captured}, query)["captured"], market_captured)

    def test_catalog_accepts_owner_maximum_of_1024_rows(self):
        payload = catalog()
        payload["rows"] += [listed_only(f"R{index:04d}-USDT-SWAP") for index in range(1023)]
        self.assertEqual(len(validate_stock_payload("stocks", payload, {"region": "eea"})["rows"]), 1024)
        payload["rows"].append(listed_only("OVER-USDT-SWAP"))
        with self.assertRaisesRegex(StockPayloadError, "owner_invalid_stock_rows"):
            validate_stock_payload("stocks", payload, {"region": "eea"})

    def test_malformed_capture_contract_fails_closed(self):
        extra = {"instType": "SWAP", "instId": "MISSING-USDT-SWAP", "listed": False}
        for name, mutate in (
            ("missing capture", lambda p: p.pop("capture")),
            ("capture not list", lambda p: p.update(capture={})),
            ("capture entry extra key", lambda p: p["capture"][0].update(region="eea")),
            ("capture entry missing key", lambda p: p["capture"][0].pop("listed")),
            ("listed not bool", lambda p: p["capture"][0].update(listed=1)),
            ("listed null", lambda p: p["capture"][0].update(listed=None)),
            ("bad instType", lambda p: p["capture"][0].update(instType="MARGIN")),
            ("bad instId", lambda p: p["capture"][0].update(instId="A/B-USDT")),
            ("unsorted", lambda p: p["capture"].insert(0, dict(extra))),
            ("duplicate", lambda p: p["capture"].append(dict(p["capture"][0]))),
            ("over 64", lambda p: p.update(capture=[{"instType": "SWAP", "instId": f"S{index:03d}-USDT-SWAP", "listed": False} for index in range(65)])),
            ("listed but absent", lambda p: p["capture"].append({**extra, "listed": True})),
            ("unlisted but present", lambda p: p["capture"][0].update(listed=False)),
            ("captured row not allowlisted", lambda p: p.update(capture=[])),
            ("allowlisted row not captured", lambda p: p["rows"][0].update(captured=False, latest=dict.fromkeys(DATASETS), channels={})),
            ("disabled with capture", lambda p: p.update(state="disabled", reason="stocks_not_configured", rows=[], capture=[extra])),
            ("missing row flag", lambda p: p["rows"][0].pop("captured")),
            ("row flag not bool", lambda p: p["rows"][0].update(captured="true")),
            ("not captured with value", lambda p: p["rows"].append({**listed_only(), "latest": {**dict.fromkeys(DATASETS), "ticker": event(instId="LISTED-USDT-SWAP", instType="SWAP")}})),
            ("not captured with channels", lambda p: p["rows"].append({**listed_only(), "channels": {"ticker": {"state": "waiting", "event_time_ms": None, "received_at_ms": None, "age_s": None, "reason": None}}})),
        ):
            payload = catalog()
            mutate(payload)
            with self.subTest(name), self.assertRaises(StockPayloadError):
                validate_stock_payload("stocks", payload, {"region": "eea"})
        for view, fixture, query in (("stock-market", market, IDENTITY), ("stock-candles", candles, {**IDENTITY, "range": "1h"})):
            for flag in (None, 1, "true", "missing"):
                payload = fixture()
                if flag == "missing":
                    payload.pop("captured")
                else:
                    payload["captured"] = flag
                with self.subTest(view=view, flag=flag), self.assertRaises(StockPayloadError):
                    validate_stock_payload(view, payload, query)
            with self.subTest(view=view, extra="capture"), self.assertRaises(StockPayloadError):
                validate_stock_payload(view, {**fixture(), "capture": []}, query)

    def test_chart_preserves_gaps_nullable_volume_and_separate_price_bases(self):
        payload = candles()
        payload["buckets"][0][1:7] = [100, 102, 99, 101, None, 1]
        payload["buckets"][0][9] = 0
        payload["totals"].update(final=1, missing=59)
        result = validate_stock_payload("stock-candles", payload, {**IDENTITY, "range": "1h"})
        self.assertIsNone(result["buckets"][0][5])
        self.assertIsNone(result["buckets"][1][1])
        for mutate in (
            lambda p: p.update(price_basis="mark"),
            lambda p: p.update(adjustment="forward"),
            lambda p: p.update(instId="OTHER-USDT-SWAP"),
            lambda p: p["buckets"][1].__setitem__(1, 101),
            lambda p: p["totals"].update(final=4),
            lambda p: p.update(end=NOW),
            lambda p: p["buckets"][0].__setitem__(6, True),
        ):
            broken = copy.deepcopy(payload)
            mutate(broken)
            with self.assertRaises(StockPayloadError):
                validate_stock_payload("stock-candles", broken, {**IDENTITY, "range": "1h"})


if __name__ == "__main__":
    unittest.main()
