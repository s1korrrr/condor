"""Authenticated projection of the native API's atomic account observation."""

from datetime import datetime
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from config_manager import get_config_manager

router = APIRouter(tags=['portfolio'])


def _amount(value):
    if isinstance(value, bool) or value is None:
        raise ValueError('Missing account amount')
    try:
        amount = Decimal(str(value))
    except InvalidOperation as error:
        raise ValueError('Invalid account amount') from error
    if not amount.is_finite():
        raise ValueError('Non-finite account amount')
    return str(amount)


def project_account_snapshot(server, payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('state'), dict) or not isinstance(payload.get('accounts'), dict):
        raise ValueError('Account observation unavailable')
    accounts = []
    for account, statuses in payload['accounts'].items():
        if not isinstance(account, str) or not isinstance(statuses, dict):
            raise ValueError('Invalid account identity')
        state = payload['state'].get(account)
        if not isinstance(state, dict) or set(state) != set(statuses):
            raise ValueError('Account state and observation identities differ')
        for connector, observation in statuses.items():
            if not isinstance(connector, str) or not isinstance(observation, dict):
                raise ValueError('Invalid connector observation')
            status = observation.get('status')
            if status not in {'fresh', 'stale', 'missing'}:
                raise ValueError('Unknown account freshness')
            observed = observation.get('observed_at')
            if observed is not None:
                timestamp = datetime.fromisoformat(observed.replace('Z', '+00:00'))
                if timestamp.tzinfo is None:
                    raise ValueError('Account observation timezone unavailable')
            elif status == 'fresh':
                raise ValueError('Fresh account timestamp unavailable')
            rows = state[connector]
            if not isinstance(rows, list):
                raise ValueError('Invalid account balances')
            balances = []
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get('token'), str) or not row['token']:
                    raise ValueError('Invalid asset identity')
                balances.append({
                    'token': row['token'], 'total': _amount(row.get('units')),
                    'available': _amount(row.get('available_units')),
                    'value': None if row.get('value') is None else _amount(row['value']),
                })
            accounts.append({
                'account': account, 'connector': connector, 'status': status, 'observed_at': observed,
                'valuation_available': observation.get('valuation_available') is True and all(row['value'] is not None for row in balances),
                'balances': balances,
            })
    if set(payload['state']) != set(payload['accounts']):
        raise ValueError('Account state identities differ')
    return {'server': server, 'accounts': accounts}


@router.get('/servers/{name}/account-balances')
async def account_balances(name: str, refresh: bool = Query(False), user: WebUser = Depends(get_current_user)):
    cm = get_config_manager()
    if not cm.has_server_access(user.id, name):
        raise HTTPException(status_code=404, detail='Server not found')
    try:
        client = await cm.get_client(name)
        payload = await client.portfolio._get('portfolio/snapshot', params={'refresh': str(refresh).lower()})
        result = project_account_snapshot(name, payload)
    except Exception:
        raise HTTPException(status_code=502, detail='Account balances could not be refreshed. Check the connection in Settings and retry.') from None
    return JSONResponse(result, headers={'Cache-Control': 'no-store'})
