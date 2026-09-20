# Isolated RSI Modular form acceptance

Run Vite with `RSI_MODULAR_SCHEMA_FIXTURE` pointing to a JSON object containing
`ok_rsi` and `rsi_v5` field schemas emitted by the candidate API's `_field_schema`
over the genuine engine `CONFIG_PROFILES` classes:

```sh
RSI_MODULAR_SCHEMA_FIXTURE=/absolute/path/native-api-schemas.json \
  node_modules/.bin/vite --config test/browser/rsi-modular/vite.config.mjs
```

Open `http://127.0.0.1:18213/test/browser/rsi-modular/index.html`. The actual
`NewConfigDialog` must keep submission disabled until a profile is selected.
Select and save each profile; switch profiles in the same form and save again.
`/__fixture/requests` contains the profile query and exact submitted payload.
Validate those payloads with genuine native `get_config_class(profile)` and
compare the switched profile with a fresh profile's defaults.

The middleware has no proxy and rejects all unconfigured API routes. Saves are
in memory only. It does not start an API, a bot, a poller or an exchange session.
A successful fixture is browser/schema evidence, not real deployment or Telegram
delivery evidence. The separate API native contract tests validate source seals.
