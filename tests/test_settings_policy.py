from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.read_only import ReadOnlyWeb
from condor.web.routes import settings


def app():
    value = FastAPI()
    value.include_router(settings.router, prefix='/api/v1')
    value.dependency_overrides[get_current_user] = lambda: WebUser(id=1, username='owner', role='admin')
    return value


@pytest.mark.parametrize('account,lifecycle', [(False, False), (True, False), (False, True), (True, True)])
def test_policy_reports_actual_independent_middleware_exceptions(account, lifecycle):
    client = TestClient(ReadOnlyWeb(app(), allow_account_management=account, allow_native_lifecycle=lifecycle))
    response = client.get('/api/v1/settings/policy')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert response.json() == {'read_only': True, 'settings_mutation': False,
                               'account_management': account, 'native_lifecycle': lifecycle}


def test_full_deployment_policy_and_authenticated_read():
    application = app()
    assert TestClient(application).get('/api/v1/settings/policy').json() == {
        'read_only': False, 'settings_mutation': True, 'account_management': True, 'native_lifecycle': True}
    application.dependency_overrides.clear()
    assert TestClient(application).get('/api/v1/settings/policy').status_code == 401


@pytest.mark.parametrize('upstream', [RuntimeError('private upstream details'), None, {}, {'running': 'false'}])
def test_gateway_unobservable_is_502_not_stopped(monkeypatch, upstream):
    status = AsyncMock(side_effect=upstream) if isinstance(upstream, Exception) else AsyncMock(return_value=upstream)
    cm = SimpleNamespace(has_server_access=lambda *_: True, get_client=AsyncMock(return_value=SimpleNamespace(gateway=SimpleNamespace(get_status=status))))
    monkeypatch.setattr(settings, 'get_config_manager', lambda: cm)
    response = TestClient(app()).get('/api/v1/settings/gateway/status?server=local')
    assert response.status_code == 502
    assert 'unavailable' in response.json()['detail'].lower()
    assert 'private upstream details' not in response.text


@pytest.mark.parametrize('running', [True, False])
def test_observed_gateway_state_is_preserved(monkeypatch, running):
    cm = SimpleNamespace(has_server_access=lambda *_: True, get_client=AsyncMock(return_value=SimpleNamespace(gateway=SimpleNamespace(get_status=AsyncMock(return_value={'running': running})))) )
    monkeypatch.setattr(settings, 'get_config_manager', lambda: cm)
    response = TestClient(app()).get('/api/v1/settings/gateway/status?server=local')
    assert response.status_code == 200
    assert response.json()['running'] is running
