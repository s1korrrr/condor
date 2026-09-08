from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.routes import auth
from config_manager import UserRole


def setup(monkeypatch, peer='127.0.0.1', role=UserRole.ADMIN):
    monkeypatch.setenv('CONDOR_TAILSCALE_LOGIN', 'owner@example.test')
    monkeypatch.setenv('CONDOR_TAILSCALE_USER_ID', '1')
    monkeypatch.setenv('WEB_JWT_SECRET', 'test-only-secret')
    class Config:
        def get_user_role(self, uid):
            assert uid == 1
            return role
    monkeypatch.setattr(auth, 'get_config_manager', lambda: Config())
    app = FastAPI()
    app.include_router(auth.router)
    return TestClient(app, client=(peer, 1234))


def test_tailscale_login_binds_loopback_proxy_and_exact_owner(monkeypatch):
    response = setup(monkeypatch).post('/auth/tailscale', headers={'Tailscale-User-Login': 'owner@example.test'})
    assert response.status_code == 200
    assert response.json()['user']['id'] == 1
    assert response.headers['cache-control'] == 'no-store'


def test_tailscale_login_rejects_direct_remote_peer(monkeypatch):
    response = setup(monkeypatch, peer='192.168.1.2').post('/auth/tailscale', headers={'Tailscale-User-Login': 'owner@example.test'})
    assert response.status_code == 403


def test_tailscale_login_rejects_missing_or_other_identity(monkeypatch):
    c = setup(monkeypatch)
    assert c.post('/auth/tailscale').status_code == 403
    assert c.post('/auth/tailscale', headers={'Tailscale-User-Login': 'another@example.test'}).status_code == 403


def test_tailscale_login_disabled_without_explicit_config(monkeypatch):
    c = setup(monkeypatch)
    monkeypatch.delenv('CONDOR_TAILSCALE_LOGIN')
    assert c.post('/auth/tailscale', headers={'Tailscale-User-Login': 'owner@example.test'}).status_code == 404
