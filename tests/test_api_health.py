import pytest
from aiohttp import ClientResponseError


@pytest.mark.asyncio
async def test_native_health_does_not_probe_unavailable_accounts():
    from condor.api_health import verify_api_connection
    class Accounts:
        async def _get(self, path):
            assert path == '/health'
            return {'status': 'ok', 'profile': 'native', 'capabilities': {'accounts': False}}
        async def list_accounts(self):
            raise AssertionError('native profile must not initialize/probe accounts')
    class Client:
        accounts = Accounts()
    assert (await verify_api_connection(Client()))['profile'] == 'native'


@pytest.mark.asyncio
async def test_legacy_api_health_retains_account_liveness():
    from condor.api_health import verify_api_connection
    class Accounts:
        async def _get(self, path):
            raise ClientResponseError(None, (), status=404)
        async def list_accounts(self):
            return []
    class Client:
        accounts = Accounts()
    assert (await verify_api_connection(Client()))['status'] == 'ok'


@pytest.mark.asyncio
async def test_auth_failure_is_not_a_legacy_fallback():
    from condor.api_health import verify_api_connection
    class Accounts:
        async def _get(self, path):
            raise ClientResponseError(None, (), status=401)
        async def list_accounts(self):
            raise AssertionError('auth failure must propagate')
    class Client:
        accounts = Accounts()
    with pytest.raises(ClientResponseError):
        await verify_api_connection(Client())
