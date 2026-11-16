import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from condor.v5.paper import validate_paper_read


REPLAY = Path(__file__).parent / "fixtures/paper-api-final3/native-replay"
FIELDS = (
    "entry_gross_base", "entry_gross_quote", "exit_gross_base", "exit_gross_quote",
    "fees_quote", "remaining_owned_base", "residual_dust_base",
)


def receipt():
    return {
        "accounting_owner": "executor",
        "entry_gross_base": "0.1553500", "entry_gross_quote": "99.700523000",
        "exit_gross_base": "0.086547", "exit_gross_quote": "56.10991059",
        "fees_quote": "0.1358703289900", "remaining_owned_base": "0.0688030",
        "residual_dust_base": "0",
    }


def packet(section, value):
    payload = json.loads((REPLAY / f"{section}.json").read_text())
    row = json.loads((REPLAY / "executors.json").read_text())["data"][0]
    row["custom_info"] = {"execution_receipt": value}
    if section == "executors":
        payload["data"] = [row]
    else:
        payload["data"]["terminal_executors"] = {
            "completeness": "complete", "capabilities": ["read"],
            "data": {"delivery": "publication_pages", "records": [row], "publication_record_count": 1},
        }
    return payload, row


def validate(payload):
    return validate_paper_read(
        payload, section=payload["section"], bot=payload["bot_id"], now_ms=payload["read_at_ms"]
    )


@pytest.mark.parametrize("section", ["executors", "history"])
def test_receipt_is_preserved_exactly_and_missing_receipt_is_backward_compatible(section):
    payload, row = packet(section, receipt())
    assert validate(payload)["data"] == payload["data"]
    row["custom_info"] = {}
    assert validate(payload)["data"] == payload["data"]


@pytest.mark.parametrize("section", ["executors", "history"])
@pytest.mark.parametrize("field", FIELDS)
@pytest.mark.parametrize("invalid", [1, None, {}, [], True, "", "1" * 129])
def test_receipt_consumed_amounts_fail_closed(section, field, invalid):
    value = receipt()
    value[field] = invalid
    payload, _ = packet(section, value)
    with pytest.raises(HTTPException) as error:
        validate(payload)
    assert error.value.detail["code"] == "paper_read_schema_invalid"


@pytest.mark.parametrize("section", ["executors", "history"])
@pytest.mark.parametrize("invalid", [[], "receipt", 1, None, {}, {**receipt(), "accounting_owner": 1}])
def test_receipt_bad_shape_fails_closed(section, invalid):
    payload, _ = packet(section, invalid)
    with pytest.raises(HTTPException):
        validate(payload)


@pytest.mark.parametrize("section", ["executors", "history"])
def test_receipt_zero_denominators_remain_owner_evidence_not_available_costs(section):
    for field in ("entry_gross_base", "entry_gross_quote"):
        value = {**receipt(), field: "0"}
        payload, _ = packet(section, value)
        assert validate(payload)["data"] == payload["data"]
    value = {**receipt(), "exit_gross_base": "0", "exit_gross_quote": "0"}
    payload, _ = packet(section, value)
    assert validate(payload)["data"] == payload["data"]


@pytest.mark.parametrize("section", ["executors", "history"])
@pytest.mark.parametrize("field", [name for name in FIELDS if name != "fees_quote"])
@pytest.mark.parametrize("invalid", ["0E-9", "1e2", "-1", " 1", "1.", ".1", "1\n"])
def test_bounded_receipt_text_stays_raw_for_strict_display_qualification(section, field, invalid):
    payload, _ = packet(section, {**receipt(), field: invalid})
    assert validate(payload)["data"] == payload["data"]
