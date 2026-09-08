from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import account_balances


def snapshot(rows=None):
    return {
        'state': {'master_account': {'okx': rows if rows is not None else [{
            'token':'SUI','units':'3.123456789012345678','available_units':'2.1','price':None,'value':None,
        }]}},
        'accounts': {'master_account': {'okx': {
            'status':'fresh','observed_at':'2026-09-08T20:00:00+00:00','age_seconds':2,'valuation_available':False,
        }}},
    }


def test_projection_retains_exact_amounts_null_valuation_and_empty_fresh_accounts():
    result = account_balances.project_account_snapshot('local', snapshot())
    assert result['accounts'][0]['balances'][0] == {
        'token':'SUI','total':'3.123456789012345678','available':'2.1','value':None,
    }
    assert result['accounts'][0]['status'] == 'fresh'
    assert result['accounts'][0]['valuation_available'] is False
    empty = account_balances.project_account_snapshot('local', snapshot([]))
    assert empty['accounts'][0]['balances'] == []
    assert empty['accounts'][0]['observed_at'] is not None
    assert account_balances.project_account_snapshot('local', {'state':{'master_account':{}},'accounts':{'master_account':{}}})['accounts'] == []


@pytest.mark.parametrize('field,value', [('units','NaN'),('units',True),('available_units',None),('value','Infinity')])
def test_invalid_balance_never_turns_into_zero(field, value):
    payload = snapshot()
    payload['state']['master_account']['okx'][0][field] = value
    with pytest.raises(ValueError):
        account_balances.project_account_snapshot('local', payload)


def test_account_route_requires_access_and_does_not_expose_arbitrary_upstream_data(monkeypatch):
    payload = snapshot()
    payload['secret'] = 'NEVER-RETURN-SECRET'
    upstream = AsyncMock(return_value=payload)
    cm = SimpleNamespace(has_server_access=lambda *_: True,
                         get_client=AsyncMock(return_value=SimpleNamespace(portfolio=SimpleNamespace(_get=upstream))))
    monkeypatch.setattr(account_balances, 'get_config_manager', lambda: cm)
    app = FastAPI()
    app.include_router(account_balances.router, prefix='/api/v1')
    app.dependency_overrides[get_current_user] = lambda: WebUser(id=1, username='owner',role='admin')
    client = TestClient(app)
    response = client.get('/api/v1/servers/local/account-balances')
    assert response.status_code == 200
    assert 'NEVER-RETURN-SECRET' not in response.text
    cm.has_server_access = lambda *_: False
    assert client.get('/api/v1/servers/local/account-balances').status_code == 404
    assert upstream.await_count == 1


def test_account_route_does_not_return_cached_success_on_upstream_failure(monkeypatch):
    cm = SimpleNamespace(has_server_access=lambda *_: True,
                         get_client=AsyncMock(side_effect=ValueError('SECRET-DO-NOT-ECHO')))
    monkeypatch.setattr(account_balances, 'get_config_manager', lambda: cm)
    app = FastAPI()
    app.include_router(account_balances.router, prefix='/api/v1')
    app.dependency_overrides[get_current_user] = lambda: WebUser(id=1,username='owner',role='admin')
    response = TestClient(app).get('/api/v1/servers/local/account-balances')
    assert response.status_code == 502
    assert 'SECRET-DO-NOT-ECHO' not in response.text
