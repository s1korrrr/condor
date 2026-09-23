from condor.fetchers.bots import extract_fleet_items
from condor.fetchers.fleet import adapt_fleet_records, catalogue_from_api_payload
from condor.fleet_projection import fleet_page, select_default, to_fleet_row


def test_same_display_name_keeps_separate_query_keys():
    left = to_fleet_row({
        "bot_key": "a",
        "identity": {"authority_id": "v1-api", "stack_id": "rsibot-stack", "bot_instance_id": "00000000-0000-4000-8000-000000000001"},
        "display_name": "RSI",
        "execution_mode": "live",
        "stack_generation": "legacy_v1",
        "catalogue_revision": "sha256:" + "a" * 64,
        "identity_verified": False,
    })
    right = to_fleet_row({
        "bot_key": "b",
        "identity": {"authority_id": "rsibot-api-v2", "stack_id": "rsibot-stack-v2", "bot_instance_id": "00000000-0000-4000-8000-000000000001"},
        "display_name": "RSI",
        "execution_mode": "live",
        "stack_generation": "modular_v2",
        "catalogue_revision": "sha256:" + "b" * 64,
        "identity_verified": False,
    })
    assert left["query_key"] != right["query_key"]
    assert left["stack_id"] == "rsibot-stack"
    assert right["stack_id"] == "rsibot-stack-v2"


def test_v2_rows_are_listed_before_legacy():
    rows = select_default([
        {"stack_generation": "legacy_v1", "display_name": "ok_rsi"},
        {"stack_generation": "modular_v2", "display_name": "rsi_modular_v2"},
    ])
    assert [row["display_name"] for row in rows] == ["rsi_modular_v2", "ok_rsi"]


def test_unavailable_is_not_converted_to_permissions():
    row = to_fleet_row({"identity": {}, "identity_verified": False, "reason_code": "owner_unobserved"})
    assert "permission" not in row
    assert row["identity_verified"] is False


def test_fleet_page_never_sums_overlapping_bots():
    page = adapt_fleet_records([
        {"identity": {"authority_id": "v1", "stack_id": "rsibot-stack", "bot_instance_id": "00000000-0000-4000-8000-000000000001"}, "stack_generation": "legacy_v1", "display_name": "ok_rsi"},
        {"identity": {"authority_id": "v2", "stack_id": "rsibot-stack-v2", "bot_instance_id": "00000000-0000-4000-8000-000000000001"}, "stack_generation": "modular_v2", "display_name": "rsi_modular_v2"},
    ])
    assert page["aggregated_pnl"] is None
    assert page["command_available"] is False
    assert fleet_page([])["bots"] == []


def test_fleet_page_never_sums_pnl():
    page = fleet_page(
        [
            {"identity": {"authority_id": "a", "stack_id": "rsibot-stack-v2", "bot_instance_id": "1"}, "stack_generation": "modular_v2", "display_name": "rsi_modular_v2"},
            {"identity": {"authority_id": "b", "stack_id": "rsibot-stack", "bot_instance_id": "2"}, "stack_generation": "legacy_v1", "display_name": "ok_rsi"},
        ]
    )
    assert page["aggregated_pnl"] is None
    assert page["command_available"] is False
    assert [row["display_name"] for row in page["bots"]] == ["rsi_modular_v2", "ok_rsi"]


def test_config_sources_keep_v2_separate_and_never_sum_pnl():
    from condor.fleet_projection import catalogue_from_sources

    page = catalogue_from_sources(
        {
            "ok_rsi": {"server": "v1", "url": "http://127.0.0.1:5011/api/v1"},
            "rsi_modular_v2": {"server": "v2", "url": "http://127.0.0.1:5111/api/v1", "execution_mode": "live"},
        }
    )
    assert page["aggregated_pnl"] is None
    assert [row["display_name"] for row in page["bots"]] == ["rsi_modular_v2", "ok_rsi"]
    assert page["bots"][0]["stack_id"] == "rsibot-stack-v2"
    assert page["bots"][1]["stack_id"] == "rsibot-stack"


def test_fleet_extractor_is_opt_in():
    payload = {"items": [{"bot_key": "a"}]}
    assert extract_fleet_items(payload) == []
    assert extract_fleet_items(payload, enabled=True) == [{"bot_key": "a"}]


def test_missing_api_catalogue_stays_empty():
    page = catalogue_from_api_payload(None)
    assert page["bots"] == []
    assert page["aggregated_pnl"] is None
    assert page["reason_code"] == "catalogue_unavailable"
