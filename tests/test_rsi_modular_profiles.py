from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from condor.rsi_controllers import load_controller_template, validate_controller_config_for_write


@pytest.mark.asyncio
@pytest.mark.parametrize('profile', ['ok_rsi', 'rsi_v5'])
async def test_selected_profile_uses_authenticated_template_transport(profile):
    transport = AsyncMock(return_value={'profile': {'required': True}})
    legacy = AsyncMock()
    client = SimpleNamespace(controllers=SimpleNamespace(_get=transport, get_controller_config_template=legacy))
    assert await load_controller_template(client, 'generic', 'rsi_modular', profile) == {'profile': {'required': True}}
    transport.assert_awaited_once_with('/controllers/generic/rsi_modular/config/template', params={'profile': profile})
    legacy.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('profile', [None, '', 'OK_RSI', 'unknown', {'name': 'ok_rsi'}])
async def test_missing_or_unknown_profile_rejects_before_transport(profile):
    transport = AsyncMock()
    client = SimpleNamespace(controllers=SimpleNamespace(_get=transport, validate_controller_config=transport))
    with pytest.raises(ValueError, match='explicit'):
        await load_controller_template(client, 'generic', 'rsi_modular', profile)
    with pytest.raises(ValueError, match='explicit'):
        await validate_controller_config_for_write(client, {'controller_type': 'generic', 'controller_name': 'rsi_modular', 'profile': profile})
    transport.assert_not_awaited()


@pytest.mark.parametrize('profile', ['ok_rsi', 'rsi_v5', None])
def test_telegram_config_display_keeps_profile_visible(profile):
    from handlers.bots.controller_handlers import _format_config_line, _get_controller_type_display
    assert _get_controller_type_display('rsi_modular')[0] == 'RSI Modular'
    rendered = _format_config_line({'controller_name': 'rsi_modular', 'profile': profile, 'connector_name': 'okx', 'trading_pair': 'BNB-USDC'}, 1)
    assert f'RSI Modular / {profile or "UNAVAILABLE"}' in rendered
