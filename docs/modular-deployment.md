# Native modular deployment boundary

The MCP deployment tool and both Telegram deployment handlers share
`condor.rsi_controllers.deploy_controller_bot`. They resolve the selected API
configuration filenames, then forward an extended request through the installed
SDK's existing authenticated transport. No trading policy runs in Condor.

For `modular_spot`, `modular_ok_rsi`, and `modular_rsi_v5`, every selected
configuration must carry the same valid `recipe_binding.source_sha256`. Mixing
editable controllers or different native source seals is rejected. The selected
image must be an immutable local `sha256:` image ID or repository digest; a
version tag is insufficient. Global and per-controller drawdown limits must be
finite and positive, with the per-controller limit no greater than the global
limit. The API independently checks effective configuration bytes, installed
source, script limits and image identity before creating a container.

The Hummingbot API client version pinned by this repository does not expose the
native seal in its convenience deployment method. The native path therefore
uses that router's authenticated `_post` method with the additive field. It
fails if that transport is unavailable. Ordinary controllers retain the SDK
convenience method. Managed legacy `ok_rsi` and `hl_rsi` now also receive the
existing pinned-image and loss-limit checks.

The Telegram custom-image input accepts immutable image IDs/digests; source
identity comes from the selected saved configuration rather than user-entered
text. A successful API publication is not evidence of operator action execution
or live readiness. Read the native owner's subsequent state and command receipt.

Validation uses synthetic clients and Telegram messages only. Tests execute the
real two handler functions and shared tool with bounded fake authenticated
transport; they assert source-seal propagation and rejection before the API call.
No Telegram message, bot, container, credential or live stack was changed.

This boundary does not establish account isolation, capital authority, economic
merit, alert delivery, or a paper-to-live inventory transition. A deployment still
requires a qualified immutable native engine/API pair and an explicit operator
mandate. Rollback is reverting this companion change; no existing instance is
restarted by a repository update.

## Native performance previews

Telegram bot/controller previews preserve missing, invalid and stale native
metrics as `UNAVAILABLE`. A genuine reported zero stays zero. Missing controller
contributions cannot produce a complete aggregate, and malformed position data
is disclosed. Native numeric TradeType values 1/2 render as BUY/SELL; unknown
sides remain neutral instead of appearing short. These changes affect display,
not trading or operator command authority.

The root `deploy/modular-validation/native_consumer_smoke.py` exercises genuine
paper fill/fee/recovery reports through actual API and Condor/Telegram consumer
functions with captured local transports. It does not prove production broker
ACLs, command acknowledgement or Telegram delivery. See rsibot #188 for its
source-bound receipts and the selected shared-account qualification.
