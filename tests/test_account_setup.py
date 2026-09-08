from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from config_manager import ServerPermission
from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.read_only import ReadOnlyWeb
from condor.web.routes import settings


@pytest.fixture
def setup_client(monkeypatch):
    accounts = SimpleNamespace(add_credential=AsyncMock(return_value={'accidental_echo': 'NEVER-RETURN-SECRET'}),
                               delete_credential=AsyncMock(return_value={'deleted': True}))
    cm = SimpleNamespace(has_server_access=lambda *_: True,
                         get_server_permission=lambda *_: ServerPermission.OWNER,
                         is_admin=lambda *_: False,
                         get_client=AsyncMock(return_value=SimpleNamespace(accounts=accounts)))
    monkeypatch.setattr(settings, 'get_config_manager', lambda: cm)
    invalidated = []
    import condor.server_data_service as sds
    monkeypatch.setattr(sds, 'get_server_data_service', lambda: SimpleNamespace(invalidate=lambda *args: invalidated.append(args)))
    app = FastAPI()
    app.include_router(settings.router, prefix='/api/v1')
    app.dependency_overrides[get_current_user] = lambda: WebUser(id=1, username='owner', role='admin')
    return TestClient(ReadOnlyWeb(app, allow_account_management=True)), cm, accounts, invalidated


def test_account_setup_requires_owner_not_only_shared_server_access(setup_client):
    client, cm, accounts, _ = setup_client
    cm.get_server_permission = lambda *_: ServerPermission.TRADER
    response = client.post('/api/v1/settings/credentials?server=local', json={'connector_name':'okx','credentials':{}})
    assert response.status_code == 403
    assert client.delete('/api/v1/settings/credentials/okx?server=local').status_code == 403
    assert not accounts.add_credential.called
    assert not accounts.delete_credential.called


def test_credential_success_never_echoes_upstream_payload_and_invalidates_balances(setup_client):
    client, _, _, invalidated = setup_client
    response = client.post('/api/v1/settings/credentials?server=local', json={'connector_name':'okx','credentials':{'okx_api_key':'local-fixture'}})
    assert response.status_code == 200
    assert response.json() == {'added': True}
    assert 'NEVER-RETURN-SECRET' not in response.text
    from condor.server_data_service import ServerDataType
    assert ('local', ServerDataType.CONNECTORS) in invalidated
    assert ('local', ServerDataType.PORTFOLIO) in invalidated


def test_credential_failure_returns_actionable_error_without_secret_or_false_success(setup_client):
    client, _, accounts, invalidated = setup_client
    accounts.add_credential.side_effect = ValueError('invalid input includes SECRET-DO-NOT-ECHO')
    response = client.post('/api/v1/settings/credentials?server=local', json={'connector_name':'okx','credentials':{'okx_passphrase':'SECRET-DO-NOT-ECHO'}})
    assert response.status_code == 502
    assert 'SECRET-DO-NOT-ECHO' not in response.text
    assert 'not confirm' in response.json()['detail']
    assert invalidated == []


def test_delete_failure_is_not_reported_as_deleted_or_echoed(setup_client):
    client, _, accounts, invalidated = setup_client
    accounts.delete_credential.side_effect = ValueError('upstream SECRET-DO-NOT-ECHO')
    response = client.delete('/api/v1/settings/credentials/okx?server=local')
    assert response.status_code == 502
    assert 'SECRET-DO-NOT-ECHO' not in response.text
    assert invalidated == []


def test_invalid_credential_body_does_not_echo_secret_in_validation_response():
    from condor.web.app import create_app

    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: WebUser(id=1, username='owner', role='admin')
    response = TestClient(app).post('/api/v1/settings/credentials?server=local', json={
        'credentials': {'okx_passphrase': 'SECRET-IN-INVALID-BODY'},
    })
    assert response.status_code == 422
    assert 'SECRET-IN-INVALID-BODY' not in response.text
