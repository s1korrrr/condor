# Daily simulated-money report

Owner: Kestrel. Scope: Condor's existing V5/Helm paper money record, its read
route, Money page and offline export. This is simulated spot reporting only.
No sampler, schedule, service, execution configuration or trading authority is
added. Base: `feat/andrzej_v5_r2_release_20261102` at `6110ed66`.

The existing sampler writes `V5_RUNTIME_ROOT/money/samples.jsonl`. Read
`condor/v5/money.py` for the source schema. `daily_money.daily_report` is a pure
projection shared by `GET /api/v5/money` (`daily_report`) and the export CLI.
The legacy `daily` response remains compatible. Daily rows use the whole
retained record, independently of the chart's 24h/7d filter.

Each retained UTC day has one V5 row and one Helm row, including days with no
samples. Without any record the API returns today's two unavailable rows. The
CLI exports a requested date, defaulting to yesterday UTC.

## Accounting and quality

- Start: first recorded sample at or after 00:00Z inside the day. End: last
  recorded sample before the next 00:00Z. Gap endpoints are not replaced.
- Equity change, realized PnL and fees cover that first-to-last sample window.
  Realized PnL and fees are differences of the recorded lifetime counters.
  One sample cannot establish a change and produces `UNAVAILABLE`.
- Equity change includes external cash flows. It must not be called trading
  profit. Unrealized PnL is the last sample's owner value.
- Money is exact decimal text, calculated with Decimal precision 120 for the
  source's maximum 18 integer and 30 fractional digits. Percent change uses a
  positive starting equity and rounds half-even to 12 fractional digits.
- There are 288 expected five-minute slots per day. Quality records sample
  count, distinct slots present, slots with any money values, missing slots,
  explicit gap samples and repeated-slot samples. A slot with PnL alone does
  not imply equity is available. Endpoint timestamps are exported and shown.
- A day is partial while it is ongoing or lacks its first/last slot. Missing
  interior slots and gap samples remain visible even if both boundaries exist.
- A decrease in the cumulative fee counter withholds daily realized PnL and
  fees as a possible owner reset. The record lacks owner-run IDs, so resets
  without a detectable counter decrease cannot be established.
- The source does not record cash, held value or BUY/SELL/fill counts. Both
  bots get `UNAVAILABLE` for those fields. Helm also lacks equity, fees and a
  quote-unit field. Missing money is never inferred from PnL or sample counts.
- The table uses the existing adaptive DataTable. Amounts use text sorting and
  text filters to retain every decimal digit in cells and CSV exports.

## Offline export

Run from the Condor repository with a Python interpreter (standard library
only). Provide the existing record or an owner-provided copy:

```sh
python3 -m condor.v5.daily_money_report \
  --input /path/to/existing/runtime/money/samples.jsonl \
  --day 2026-11-14 \
  --output-dir /path/to/new/report-directory
```

Writes `daily-money-2026-11-14.json` with all daily fields and provenance, and
`daily-money-2026-11-14.md` with a short summary. The JSON rows are identical
to the pure API projection for the same record, day and observation time.
Exports use exclusive creation; use a new output directory for a rerun.
An absent source produces explicit unavailable rows and a source-state note;
it never creates sampler state. Other read failures fail the command. Torn or
malformed lines are counted in the export, and cannot become money values.

## Acceptance and rollback

- [x] One shared pure projection; no second sampler.
- [x] UTC boundaries, missing days, gaps, sampler restart duplicates, exact
  decimals, no-data behavior and owner counter decrease covered by Node tests
  that invoke the real Python function/CLI.
- [x] Exact Daily values rendered through the actual DataTable in a fixture.
- [x] API test confirms daily rows do not depend on chart range.
- [x] Mac V5 typecheck and focused tests; command receipts in the draft PR.
- [ ] Independent owner review, install approval, deployed/browser observation.

Install: goes in a dashboard install set (owner-approved set or card).
Rollback before install: omit/revert this commit. No source record migration
or sampler changes are needed. No deployment is performed by this task.
