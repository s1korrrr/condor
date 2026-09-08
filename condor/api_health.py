"""Capability-aware liveness for native and existing full API profiles."""

from aiohttp import ClientResponseError


async def verify_api_connection(client) -> dict:
    # The installed API client has no health router. Use its existing base GET
    # transport so credentials, session lifetime and timeout stay identical.
    get = getattr(client.accounts, '_get', None)
    if get is not None:
        try:
            health = await get('/health')
        except ClientResponseError as error:
            if error.status != 404:
                raise
        else:
            if isinstance(health, dict) and health.get('profile') == 'native':
                if health.get('status') != 'ok':
                    raise ValueError('Native API is not healthy')
                return health
    await client.accounts.list_accounts()
    return {'status': 'ok', 'profile': 'full'}
