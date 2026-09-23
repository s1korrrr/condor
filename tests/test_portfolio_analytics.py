from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import account_balances


def payload():
    return {'schema_version':1,'quote_currency':'USDT','capture_mode':'observation-driven',
      'scope':{'account':'master_account','connector':'okx','market':'spot','identity':'scope-1'},
      'current':None,'history':{'points':[],'first_observed_at':None,'range_start':'2026-09-09T00:00:00Z','range_end':'2026-09-10T00:00:00Z','truncated':False,'gaps':[]},
      'changes':[],'performance':{'available':False,'reason':'Cash flows are not reconciled.'},'secret':'DO-NOT-RETURN'}


def client(monkeypatch, data=None):
    upstream=AsyncMock(return_value=payload() if data is None else data)
    cm=SimpleNamespace(has_server_access=lambda *_:True,get_client=AsyncMock(return_value=SimpleNamespace(portfolio=SimpleNamespace(_get=upstream))))
    monkeypatch.setattr(account_balances,'get_config_manager',lambda:cm)
    app=FastAPI(); app.include_router(account_balances.router,prefix='/api/v1')
    app.dependency_overrides[get_current_user]=lambda:WebUser(id=1,username='owner',role='admin')
    return TestClient(app),cm,upstream


def test_analytics_read_preserves_scope_and_filters_unknown_fields(monkeypatch):
    c,_,upstream=client(monkeypatch)
    r=c.get('/api/v1/servers/local/portfolio/analytics?range=1D')
    assert r.status_code==200
    assert r.json()['scope']['identity']=='scope-1'
    assert 'DO-NOT-RETURN' not in r.text
    assert r.headers['cache-control']=='no-store'
    assert upstream.call_args.args==('portfolio/analytics',)


def test_denied_scope_and_invalid_range_do_not_call_owner(monkeypatch):
    c,cm,upstream=client(monkeypatch)
    cm.has_server_access=lambda *_:False
    assert c.get('/api/v1/servers/foreign/portfolio/analytics').status_code==404
    assert c.get('/api/v1/servers/local/portfolio/analytics?range=BAD').status_code==422
    assert upstream.await_count==0


def test_owner_failure_is_sanitized(monkeypatch):
    c,_,upstream=client(monkeypatch)
    upstream.side_effect=RuntimeError('DO-NOT-RETURN')
    r=c.get('/api/v1/servers/local/portfolio/analytics')
    assert r.status_code==502
    assert 'DO-NOT-RETURN' not in r.text


@pytest.mark.parametrize('mutate',[
 lambda d:d.update(quote_currency='USD'),
 lambda d:d['history']['points'].append({'observed_at':'invalid','priced_total':'NaN','valuation_complete':True,'unpriced_assets':[]}),
 lambda d:d['performance'].update(available=True),
])
def test_malformed_owner_contract_fails_closed(monkeypatch,mutate):
    d=payload(); mutate(d)
    c,_,_=client(monkeypatch,d)
    assert c.get('/api/v1/servers/local/portfolio/analytics').status_code==502


def test_disconnected_owner_shape_remains_an_empty_connection_not_an_error(monkeypatch):
    d=payload();d.update(scope=None,history=None,current=None)
    c,_,_=client(monkeypatch,d)
    r=c.get('/api/v1/servers/local/portfolio/analytics')
    assert r.status_code==200
    assert r.json()['current'] is None


def capital_payload():
    return {
        'schema_version': 'rsibot.native_capital.v1',
        'generated_at': '2026-09-22T08:00:55+00:00',
        'execution_authorized': False,
        'range_rewritten': False,
        'equity': {'value': '1000', 'complete': True, 'unpriced_count': 0, 'unit': 'USDT'},
        'available_quote': {'value': '100', 'unit': 'USDC', 'v2_budget': None, 'v2_budget_reason': 'V2 budget not assigned'},
        'deployed': {'value': '702', 'reason': 'Non-cash account exposure. Not V2-owned capital.'},
        'period_pnl': {'value': None, 'availability': 'unavailable', 'reason_code': 'FLOW_COVERAGE_INCOMPLETE'},
        'today_pnl': {'value': None, 'availability': 'unavailable', 'reason_code': 'NO_MIDNIGHT_SNAPSHOT'},
        'classified_flow_count': 0,
        'observed_change_count': 0,
        'sharpe': '250.998',
        'secret': 'DO-NOT-RETURN',
    }


def test_capital_dashboard_rejects_30d_and_does_not_authorize_execution(monkeypatch):
    c, _, upstream = client(monkeypatch, capital_payload())
    assert c.get('/api/v1/servers/local/portfolio/capital-dashboard?range=30D').status_code == 422
    assert upstream.await_count == 0
    r = c.get('/api/v1/servers/local/portfolio/capital-dashboard?range=1W')
    assert r.status_code == 200
    body = r.json()
    assert body['execution_authorized'] is False
    assert body['period_pnl']['value'] is None
    assert body['equity']['value'] == '1000'
    assert body['available_quote']['value'] == '100'
    assert body['deployed']['value'] == '702'
    assert body['risk_statistics_available'] is False
    assert 'sharpe' not in body
    assert 'DO-NOT-RETURN' not in r.text
    assert upstream.call_args.args == ('portfolio/capital-dashboard',)


def test_capital_proxy_rejects_invalid_value_or_unit(monkeypatch):
    for change in ({'deployed': {'value': 'NaN', 'reason': 'bad'}},
                   {'equity': {'value': '1000', 'complete': True, 'unpriced_count': 0, 'unit': 'USD'}}):
        data = capital_payload()
        data.update(change)
        c, _, _ = client(monkeypatch, data)
        assert c.get('/api/v1/servers/local/portfolio/capital-dashboard').status_code == 502
