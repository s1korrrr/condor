import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from condor.v5.paper import validate_paper_read


FIXTURES = Path(__file__).parent / "fixtures"
ORDER = {"boot_epoch": 2, "previous_boot_id": "native-boot_1.0", "boot_started_at_ms": 0}


def envelope(section):
    if section == "candles":
        return json.loads((FIXTURES / "paper-api-7b12d1c2/envelopes.json").read_text())[section]
    return json.loads((FIXTURES / f"paper-api-final3/{section}.json").read_text())


def validate(value):
    return validate_paper_read(value, section=value["section"], bot=value["bot_id"], now_ms=value["read_at_ms"])


@pytest.mark.parametrize("section", ["risk", "candles"])
@pytest.mark.parametrize("previous", [None, "native-boot_1.0"])
@pytest.mark.parametrize("epoch,started", [(1, 0), (1025, 2**53 - 1)])
def test_accepts_and_preserves_boot_order(section, previous, epoch, started):
    value = envelope(section)
    value["source"].update(ORDER, previous_boot_id=previous, boot_epoch=epoch, boot_started_at_ms=started)
    if section == "candles":
        value["source"]["companion_sha256"] = "a" * 64
    assert validate(value)["source"] == value["source"]


@pytest.mark.parametrize("section", ["risk", "candles"])
def test_legacy_source_remains_valid(section):
    value = envelope(section)
    result = validate(value)
    assert result["source"] == value["source"]
    assert not ORDER.keys() & result["source"].keys()


@pytest.mark.parametrize("section", ["risk", "candles"])
@pytest.mark.parametrize("field,invalid", [
    *[("boot_epoch", value) for value in [None, True, False, 0, -1, 1.5, "2", 1026, 2**53]],
    *[("previous_boot_id", value) for value in [True, 1, [], {}, "", "bad boot", "boot:1", "a" * 129]],
    *[("boot_started_at_ms", value) for value in [None, True, False, -1, 1.5, "0", 2**53]],
])
def test_rejects_invalid_boot_order(section, field, invalid):
    value = envelope(section)
    value["source"].update(ORDER)
    value["source"][field] = invalid
    with pytest.raises(HTTPException) as error:
        validate(value)
    assert error.value.status_code == 502
    assert error.value.detail["code"] == "paper_read_schema_invalid"


@pytest.mark.parametrize("field", ORDER)
def test_unbound_envelopes_cannot_claim_boot_order(field):
    value = json.loads((FIXTURES / "paper-api-7b12d1c2/envelopes.json").read_text())["collecting"]
    value["source"][field] = ORDER[field]
    with pytest.raises(HTTPException):
        validate(value)


@pytest.mark.parametrize("invalid", [True, 1, [], {}, "", "not-a-sha256"])
def test_candle_companion_hash_remains_strict(invalid):
    value = envelope("candles")
    value["source"].update(ORDER, companion_sha256=invalid)
    with pytest.raises(HTTPException):
        validate(value)
