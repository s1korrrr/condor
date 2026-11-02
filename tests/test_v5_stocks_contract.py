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
    }


def catalog(state="live"):
    return {"format": "okx-stocks-v1", "now": NOW, "region": "eea", "state": state, "catalog_at": NOW - 30, "updated_at": NOW, "reason": None, "rows": [row()]}


def market():
    data = catalog()
    observation = data.pop("rows")[0]
    return {**data, **IDENTITY, "format": "okx-stock-market-v1", "latest": {**observation["latest"], "books": None}, "channels": observation["channels"], "coverage": observation["coverage"], "recent_trades": [], "book_depth": None}


def candles():
    end = NOW - 60
    buckets = [[end - (59 - index) * 60, None, None, None, None, None, 0, 0, 0, 1, 0, 0] for index in range(60)]
    return {"format": "okx-stock-candles-v1", "now": NOW, **IDENTITY, "state": "live", "reason": None, "range": "1h", "res_s": 60, "start": end - 59 * 60, "end": end, "volume_unit": "contracts", "price_basis": "trade", "adjustment": "raw", "buckets": buckets, "totals": {"final": 0, "no_trade": 0, "unrecoverable": 0, "missing": 60, "pending": 0, "corrections": 0}}


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
            payload = {**catalog(state), "rows": [], "reason": "discovery_failed" if state == "error" else "stocks_not_configured" if state == "disabled" else None}
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
