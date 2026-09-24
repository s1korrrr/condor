# Fleet Telegram presentation qualification

## Outcome

All six existing commands use bounded HTML messages instead of JSON. Status shows
activity, source freshness, strategy PnL and reconciliation. Orders, fills and
executors show five records per page, UTC dates, shortened IDs, explicit missing
values and the number of returned records. Read-only inline buttons switch views,
refresh the existing panel and navigate pages. Help/start show the command menu.
Unknown commands return help. No order-placement or cancellation capability added.

V2 quote-currency display is configured as USDC after verifying all five native
controller pairs. This is a display label, not an accounting or risk change.
Executor close reason 10 is POSITION_HOLD in the running native engine and reads
“Position retained”; an ended executor is not presented as a sale. Unknown sides
remain unavailable. Missing PnL/fees and stale or invalid timestamps are not zeros
or healthy state. Partial HTTP reads and owner validation retain prior safeguards.

## Source and deployment

- Branch: feat/andrzej_telegram_readable_views, based on f5bcb351.
- Base image: sha256:4b9497589e485c31d5fb674135028b3095fecbbaadc57c7c29c0615c51065ef8.
- Deployed image: sha256:b5ddc38a827e37ebeb5766287de3365ff32e85f79f7851628b66c57e996ccf1c.
- Operational compose: ~/.local/share/rsibot-stack-v2/compose.v2-telegram-readable-20260924.json.
- Private receipts/native rendering samples: ~/.local/share/rsibot-stack-v2/telegram/readable-20260924/.
- Deployment command: docker compose -f COMPOSE up -d --no-deps --pull never condor-telegram.
- All 20 other V1/V2 container IDs, images, start times and restart counts unchanged.
- Worker observed healthy with zero restarts; token absent from logs; no error loop.
- Durable polling state preserved. No changes to execution owners or V1 Telegram.

## Validation

Passed: 26 focused tests locally and in the exact deployed Python 3.12/PTB 22.7
image. The local tests run from /tmp with PYTHONPATH set to the worktree to avoid
the unrelated shared conftest dependency on missing geckoterminal_py. The image
checks install pytest 8.4.2 only into an ephemeral container's /tmp/test-deps.

Commands:

```sh
PYTHONPATH=$PWD python -m pytest --confcutdir=/tmp /tmp/test_fleet_telegram_isolated.py /tmp/test_fleet_telegram_views.py -q
python -m black --check condor/fleet_telegram.py condor/fleet_telegram_views.py tests/test_fleet_telegram.py tests/test_fleet_telegram_views.py
python -m compileall -q condor/fleet_telegram.py condor/fleet_telegram_views.py
git diff --check
```

Passed: real native GET-only render smoke for start/help/status/orders/fills/executors;
second pages for all history views; HTML tags balanced and allowlisted; all generated
callback data parsed and bounded. Actual live output reviewed for units, missing
sides and retained-position labeling. No Telegram messages sent by the smoke.

Coverage includes private/group callback authorization, registered source routing,
unsupported buttons, pagination, refresh without duplicate messages, HTML escaping,
UTF-16 message limits, non-finite values, missing economics, stale/future timestamps,
owner mismatches, durable offsets, retry delays and conflict holds. Three PTB
warnings concern a future timedelta representation already handled by the worker.
Full Condor suite not run; this release changes only the fleet monitor.

## Rollback and limits

Restore the previous compose with a scoped condor-telegram up, preserving state and
token. The prior private config and image are retained beside the deployment receipt.
Do not use a full-stack down/up. Source changes are local; no push or merge.

History pages cover the records returned by the configured native endpoint (currently
up to ten), not all-time pagination. Each click reads again, so changing history can
shift page membership. Status is a snapshot; use Refresh for a new one. There are no
trading actions and no automatic trade-alert changes. Physical Telegram interaction
acceptance is recorded separately below.

## Operator acceptance

The user confirmed on their phone that the formatted responses are readable and
the Orders → Next → Status button flow works. This verifies real Telegram delivery
and navigation in addition to unit/image/native API checks.
