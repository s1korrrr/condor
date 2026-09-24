# Readable fleet Telegram commands

## Contract
Upgrade all six fleet commands and read-only navigation. Condor owns this change;
branch feat/andrzej_telegram_readable_views, based on f5bcb351. Authority is
live-adjacent monitoring deployment under the existing new-bot authorization.
No trading commands, execution restart, risk change, V1 notifier change, push or
merge. Existing containers and persistent Telegram cursor must be preserved.

## Design
Pure HTML presentation module; worker retains native read/identity validation.
Status separates activity, strategy PnL and source freshness. History uses five
records per page, exact returned-page scope, UTC times, explicit missing values,
short identifiers and source labels. Buttons navigate registered views, refresh
in place and paginate returned records. Callback queries must pass the same exact
private-user authorization as commands. Unsupported or expired buttons cannot
poison the durable update cursor. All dynamic content is escaped; splitting
preserves balanced HTML and Telegram message limits.

## Validation and rollback
Focused view/worker tests, malformed values and callback authorization/error cases;
exact-image Python/PTB tests; read-only native API rendering/HTML/button smoke for
all commands and second pages; operator Telegram interaction. Snapshot existing
containers before scoped condor-telegram replacement. Keep prior image and compose;
roll back only that service, preserving state and token. Quote currency label is
USDC, verified from all five current native controller pairs; no accounting changes.

## Progress
- Existing Condor CEX UI inspected; it includes trading/cancel behavior and status
  inference unsuitable for this monitor. Reused the established Telegram library
  and navigation pattern without importing those handlers.
- Native CloseType enum inspected in running engine; POSITION_HOLD=10 is rendered
  as position retained, not a sale.
- 26 focused tests passed locally and in the exact deployed image.
- All six native views, history second pages, HTML and callback-data smoke passed.
- Scoped worker replacement healthy with zero restarts; 20 other containers unchanged.
- User confirmed readable responses and Orders → Next → Status buttons on phone.
- Qualification and rollback: docs/reports/2026-09-24-fleet-telegram-presentation.md.
- Authorized task complete. No push or merge.
