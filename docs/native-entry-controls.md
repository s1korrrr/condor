# Native entry controls

Condor keeps native lifecycle start/stop separate from new-entry pause/resume. For a registered live `rsi_modular` owner, the new controls forward authenticated requests to the restricted Hummingbot API. Native controllers remain the policy authority; Condor does not calculate loss limits or change controller configuration.

Deployment must explicitly set `ReadOnlyWeb(..., allow_native_entry=True)` in its launcher. The default is false and is independent of `allow_native_lifecycle`. All entry reads and commands require administrator status, access to the selected server, and current native health advertising that exact owner's `entry_controls` capability. Paper owners, unregistered names and unsupported actions are rejected.

Routes under `/api/v1/servers/{server}/bots/{bot}/native/entries`:

- `GET /status`: current native operator state, with local capability-validation time and deployment permission.
- `POST /pause`: pause new entries for this owner.
- `POST /resume`: request ordinary new-entry resumption.
- `POST /acknowledge-daily-loss`: request the native owner's explicit daily-loss acknowledgement after UTC rollover.

POST bodies contain only a unique `command_id`. Controller overrides and arbitrary operations are rejected. Condor supplies the authenticated requesting user as an audit label. The restricted API binds the alias to its MQTT instance, validates current lifecycle/profile/controller evidence and enforces the daily acknowledgement preflight; native runtime rechecks and persists the effective decision.

The UI requires confirmation, preserves pending commands by server/owner in the authenticated query session, and disables additional commands while a submitted outcome is unknown. HTTP 202 is publication evidence only. The UI changes its message only when current native operator state carries the matching command ID, expected pause value and a subsequent update time for every returned controller. The API must reject incomplete registered-controller operator state. A same-day loss acknowledgement remains a rejection, not a restart or an implicit resume.

## Validation

Backend: `PYTHONPATH=.:tests /Users/s1kor/dev/trading/rsibot/condor/.venv/bin/python -m pytest tests/test_native_entry_controls.py tests/test_web_native_lifecycle.py tests/test_web_read_only.py tests/test_native_bots_truth.py -q --tb=short`: 81 passed.

Frontend: `node --test test/native-*.test.mjs`: 23 passed. Scoped ESLint and `npm run build` passed.

A real Chrome browser exercised the actual component using isolated simulated transport: confirmation, pending publication with all actions disabled, matching pause observation, same-day rejection retaining pause, and matching resume observation. This was a component flow smoke, not an authenticated deployed-stack or exchange test. All fetches in the harness were intercepted; unexpected routes were rejected. Browser extensions emitted unrelated warnings; no application error was observed.

No live service, exchange, account or credential changed. Rollback is reverting this commit or disabling the deployment flag; existing lifecycle controls retain their prior contract.
