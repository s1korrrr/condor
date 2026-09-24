import time

import pytest

from condor import fleet_telegram_views as view


def status_payload():
    return {
        "execution_mode": "live",
        "runtime_status": {
            "updated_at": time.time() - 5,
            "active_orders_count": 0,
            "summary": {
                "controller_count": 5,
                "active_executor_count": 2,
                "positions_held_count": 2,
                "pnl_available": True,
                "net_pnl_quote": -1.343149,
                "realized_pnl_quote": 0.051446,
                "unrealized_pnl_quote": -1.289451,
                "fees_quote": 0.105144,
            },
        },
        "runtime_parity": {"runtime_status_available": True, "mismatches": []},
    }


def test_status_is_readable_and_honest_about_freshness_and_pnl():
    payload = status_payload()
    text = view.status(payload, "USDC")
    assert "Live trading" in text and "5s ago" in text
    assert "Active orders: <b>0</b>" in text
    assert "-1.34 USDC" in text and "+0.05 USDC" in text
    assert "No reported mismatches" in text
    assert "net_pnl_quote" not in text and "{" not in text
    payload["runtime_status"]["summary"]["pnl_available"] = False
    payload["runtime_status"]["updated_at"] -= 600
    text = view.status(payload, "USDC")
    assert "Stale" in text and "PnL unavailable" in text and "-1.34" not in text


def test_status_unknown_and_future_are_not_healthy():
    payload = status_payload()
    payload["runtime_status"]["updated_at"] = time.time() + 90
    payload["runtime_parity"] = {}
    text = view.status(payload)
    assert "Clock mismatch" in text and "Reconciliation unavailable" in text
    payload["runtime_status"]["updated_at"] = float("nan")
    with pytest.raises(ValueError):
        view.status(payload)


def test_orders_do_not_guess_missing_side_or_execution_value():
    rows = [
        {
            "pair": "BNB-USDC",
            "side": None,
            "normalized_status": "canceled",
            "amount_base": 0.070059,
            "price_quote": 769.1,
            "order_id": "abc12345",
            "created_at": "2026-09-23T14:15:02+00:00",
        }
    ]
    result = view.records("orders", rows)
    assert "Canceled" in result.text and "Side unavailable" in result.text
    assert "0.070059 BNB" in result.text and "769.1 USDC" in result.text
    assert "23 Sep 14:15 UTC" in result.text
    assert "BUY" not in result.text and "null" not in result.text


def test_pagination_is_bounded_and_does_not_truncate_records():
    rows = [
        {"order_id": f"order-{i}", "pair": "BTC-USDC", "side": "buy"} for i in range(10)
    ]
    first, second = view.records("orders", rows), view.records("orders", rows, 1)
    assert first.pages == 2 and second.page == 1
    assert "1–5 of 10" in first.text and "6–10 of 10" in second.text
    assert "order-0" in first.text and "order-5" not in first.text
    assert "order-5" in second.text and "order-0" not in second.text
    assert view.records("orders", [], 1).pages == 1
    assert "No order history returned" in view.records("orders", []).text


def test_fills_and_executors_preserve_missing_economics():
    fill = view.records(
        "fills",
        [
            {
                "pair": "SOL-USDC",
                "side": "buy",
                "amount_base": 0.50445,
                "price_quote": 117.16,
                "economics_available": False,
                "fee_quote": 0,
            }
        ],
    ).text
    assert "Fill" in fill and "Fee unavailable" in fill
    executor = view.records(
        "executors",
        [
            {
                "pair": "ETH-USDC",
                "normalized_status": "running",
                "pnl_available": False,
                "net_pnl_quote": 0,
                "trailing_state": "armed",
            }
        ],
    ).text
    assert "PnL unavailable" in executor and "Trailing: armed" in executor


def test_html_escapes_untrusted_fields_and_numbers_reject_nonfinite():
    text = view.records(
        "orders",
        [
            {
                "pair": "<b>BAD</b>-USDC",
                "side": "<script>",
                "order_id": "<bad>&x",
                "normalized_status": "<bad>",
                "price_quote": float("inf"),
            }
        ],
    ).text
    assert "<script>" not in text and "&lt;b&gt;" in text and "&amp;" in text
    assert view.number(float("nan")) == "—" and view.number(None) == "—"
    assert view.number(0.000000019) != "0"


def test_message_chunks_keep_balanced_html_and_unicode_budget():
    text = "\n".join(["<b>📊 " + view.escape("<&" * 50) + "</b>"] * 60)
    chunks = view.chunks(text)
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk.encode("utf-16-le")) // 2 <= 3900
        assert chunk.count("<b>") == chunk.count("</b>")


def test_callback_payload_is_allowlisted_and_bounded():
    assert view.parse_callback("fleet:v2:orders:1") == ("orders", "v2", 1)
    for invalid in [
        "fleet:v2:buy:0",
        "fleet:../../:orders:0",
        "fleet:v2:orders:-1",
        "fleet:v2:orders:999999",
        "oops",
    ]:
        assert view.parse_callback(invalid) is None


def test_retained_position_is_not_presented_as_a_sale():
    text = view.records(
        "executors",
        [
            {
                "pair": "BNB-USDC",
                "normalized_status": "closed",
                "close_type": 10,
                "trailing_state": "waiting",
            }
        ],
    ).text
    assert "Executor ended" in text and "Position retained" in text
    assert "Last trailing state" in text and "Close reason: 10" not in text
