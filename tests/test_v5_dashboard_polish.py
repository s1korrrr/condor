import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from condor.v5.paper import validate_paper_read


def fill_read():
    return json.loads((Path(__file__).parent / 'fixtures/paper-api-final3/native-replay/fills.json').read_text())


@pytest.mark.parametrize('field', ['reason', 'read_at_ms', 'observed_at_ms', 'source_at_ms', 'capabilities', 'source'])
def test_required_owner_fields(field):
    read = fill_read()
    now_ms = read['read_at_ms']
    validate_paper_read(read, section='fills', bot=read['bot_id'], now_ms=now_ms)
    del read[field]
    with pytest.raises(HTTPException):
        validate_paper_read(read, section='fills', bot=read['bot_id'], now_ms=now_ms)


@pytest.mark.parametrize('value', [{}, []])
def test_fee_quote_is_not_a_container(value):
    read = fill_read()
    read['data'][0]['fee_quote'] = value
    with pytest.raises(HTTPException):
        validate_paper_read(read, section='fills', bot=read['bot_id'], now_ms=read['read_at_ms'])


def test_blank_capability_remains_accepted():
    read = fill_read()
    read['capabilities'] = ['']
    validate_paper_read(read, section='fills', bot=read['bot_id'], now_ms=read['read_at_ms'])


@pytest.mark.parametrize('section', ['status', 'wallet', 'risk', 'decisions', 'history', 'accounting', 'operations'])
@pytest.mark.parametrize('value', [{}, []])
def test_non_list_financial_container_parity(section, value):
    read = json.loads((Path(__file__).parent / f'fixtures/paper-api-final3/native-replay/{section}.json').read_text())
    validate_paper_read(read, section=section, bot=read['bot_id'], now_ms=read['read_at_ms'])
    read['data']['fee_quote'] = value
    with pytest.raises(HTTPException) as failure:
        validate_paper_read(read, section=section, bot=read['bot_id'], now_ms=read['read_at_ms'])
    assert failure.value.status_code == 502
    assert failure.value.detail['code'] == 'paper_read_schema_invalid'
