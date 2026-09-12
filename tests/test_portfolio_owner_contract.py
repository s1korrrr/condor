"""Optional cross-owner boundary check; supply the exact API source checkout."""
import importlib.util
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from condor.web.portfolio_contract import Analytics


def test_native_store_payload_validates_at_condor_boundary(tmp_path):
    source = os.environ.get('PORTFOLIO_API_SOURCE')
    if not source:
        pytest.skip('Set PORTFOLIO_API_SOURCE to the owner API checkout')
    path = Path(source) / 'services/native_portfolio.py'
    spec = importlib.util.spec_from_file_location('portfolio_owner_boundary', path)
    owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner)
    store = owner.NativePortfolioStore(tmp_path)
    identity = store.identity('fixture-key')
    now = datetime.now(timezone.utc)
    for i in range(2):
        current = owner.value_holdings(
            [{'token':'USDT','units':'100','available_units':'80'}, {'token':'BTC','units':'0.1','available_units':'0.1'}],
            {'BTC-USDT':'70000'}, (now-timedelta(seconds=60-i*30)).isoformat(),
        )
        store.record(identity,current)
    history=store.history(identity,'1W',now)
    changes=history.pop('changes')
    changes_truncated=history.pop('changes_truncated')
    result=Analytics.model_validate({
        'schema_version':1,'quote_currency':'USDT',
        'scope':{'account':'master_account','connector':'okx','market':'spot','identity':identity},
        'capture_mode':'observation-driven','current':current,'history':history,
        'changes':changes,'changes_truncated':changes_truncated,
        'performance':{'available':False,'reason':'Unreconciled account cash flows.'},
    }).model_dump(by_alias=True)
    assert result['current']['priced_total']=='7100.0'
    assert len(result['history']['points'])==2
    assert result['current']['holdings'][1]['total']=='0.1'
    assert result['scope']['identity']==identity
