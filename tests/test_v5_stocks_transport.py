"""Real local Unix-socket tests; no exchange or application service is started."""

import json
import tempfile
import unittest
from pathlib import Path

from aiohttp import web

from condor.v5.candles import CandleOwner, OwnerUnavailable, validate_query
from test_v5_stocks_contract import IDENTITY, catalog, candles


class StockTransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="stock-uds-")
        self.path = Path(self.directory.name) / "owner.sock"
        self.payload = catalog()
        self.status = 200
        self.raw = None
        self.requests = []

        async def reply(request):
            self.requests.append({"method": request.method, "view": request.match_info["view"], "query": list(request.query.items()), "authorization": request.headers.get("Authorization"), "cookie": request.headers.get("Cookie")})
            return web.Response(status=self.status, text=self.raw if self.raw is not None else json.dumps(self.payload), content_type="application/json")

        app = web.Application()
        app.router.add_get("/api/{view}", reply)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        await web.UnixSite(self.runner, str(self.path)).start()
        self.owner = CandleOwner(str(self.path))

    async def asyncTearDown(self):
        await self.runner.cleanup()
        self.directory.cleanup()

    async def test_exact_futures_query_round_trips_over_existing_read_transport(self):
        self.payload = candles()
        query = validate_query("stock-candles", list({**IDENTITY, "range": "1h"}.items()))
        result = await self.owner.read("stock-candles", query)
        self.assertEqual(result["instId"], IDENTITY["instId"])
        self.assertEqual(dict(self.requests[0]["query"]), {**IDENTITY, "range": "1h"})
        self.assertEqual(self.requests[0]["method"], "GET")
        self.assertIsNone(self.requests[0]["authorization"])
        self.assertIsNone(self.requests[0]["cookie"])

    async def test_failed_refresh_cannot_return_an_earlier_success(self):
        result = await self.owner.read("stocks", {"region": "eea"})
        self.assertEqual(len(result["rows"]), 1)
        self.status = 503
        with self.assertRaisesRegex(OwnerUnavailable, "owner_http_error"):
            await self.owner.read("stocks", {"region": "eea"})

    async def test_wrong_region_and_duplicate_json_are_rejected(self):
        self.payload["region"] = "global"
        with self.assertRaisesRegex(OwnerUnavailable, "owner_invalid_stock_identity"):
            await self.owner.read("stocks", {"region": "eea"})
        self.raw = '{"region":"eea","region":"global"}'
        with self.assertRaisesRegex(OwnerUnavailable, "owner_invalid_json"):
            await self.owner.read("stocks", {"region": "eea"})

    async def test_old_crypto_query_contract_is_unchanged(self):
        self.assertEqual(validate_query("candles", [("lane", "okx__spot"), ("pair", "BTC-USDT")]), {"lane": "okx__spot", "pair": "BTC-USDT", "range": "24h", "res": "1m"})
        with self.assertRaises(ValueError):
            validate_query("candles", [("region", "eea"), ("instId", IDENTITY["instId"]), ("instType", "FUTURES")])


if __name__ == "__main__":
    unittest.main()
