# Daily simulated-money report

Owner: Kestrel. Scope: Condor's existing V5/Helm paper money record, its read
route, Money page and offline export. This is simulated spot reporting only.
No sampler, schedule, service, execution configuration or trading authority is
added. Base: `feat/andrzej_v5_r2_release_20261102` at `6110ed66`.

The existing sampler writes `V5_RUNTIME_ROOT/money/samples.jsonl`. Read
`condor/v5/money.py` for the source schema. `daily_money.daily_report` is a pure
projection shared by `GET /api/v5/money` (`daily_report`) and the export CLI.
The legacy `daily` response retains its nullable schema; unsupported realized
changes and equity deltas without consistent units are null. Daily rows use the
whole retained record, independently of the chart's 24h/7d filter.

Each retained UTC day has one V5 row and one Helm row, including days with no
samples. Without any record the API returns today's two unavailable rows. The
CLI exports a requested date, defaulting to yesterday UTC.

## Accounting and quality

- Start: first recorded sample at or after 00:00Z inside the day. End: last
  recorded sample before the next 00:00Z. Gap endpoints are not replaced.
- Equity change covers that first-to-last sample window. One sample cannot
  establish a change and produces `UNAVAILABLE`. A nonempty, identical unit
  must appear in every sample, including gap samples, before an equity delta
  or percentage can be calculated. Missing, blank or differing units withhold
  all monetary deltas, with an explicit quality note.
- Daily realized PnL and fees are always `UNAVAILABLE` with the current owner
  contract. At engine pin `ee8ca6ad`, `paper_session.py:507` computes
  `accounting_since_ms` as the minimum retained fill timestamp. A recorder
  restore can preserve that timestamp, drop later profit, and replace trades
  until cumulative fees catch up. Equal timestamps and nondecreasing fees
  therefore cannot establish accounting continuity. Historical timestamp
  fields in the record are ignored; the sampler does not add this field.
- Future engine field required: `accounting.program.accounting_lineage_id`
  in the engine observation (Condor accounting-read path:
  `data.program.accounting_lineage_id`). Type: JSON `string | null`; a string
  must be a nonempty opaque accounting-generation token, while null means the
  owner cannot prove continuity. Publisher: the program accounting projection
  in `hummingbot/strategy_v2/paper_session.py::_observation_lifetime`.
- Required semantics: a non-null token binds the complete retained native-fill
  history and its exact realized-PnL/fee counters to one recorder/program scope
  and quote unit, in the same consistent owner observation. It remains stable
  for ordinary append-only fills and restarts that preserve that history. It
  must change before the first accounting publication after every restore,
  reset, truncation, history replacement or counter-scope/unit change, even if
  the oldest fill timestamp survives and cumulative fees catch up. A token
  copied back from a restored database is not continuity proof; the owner must
  prevent generation reuse across restores or publish null. Condor must not
  mint this token or derive it from timestamps/counter values.
- This field and its restore-safe generation/validation are a **separate future
  engine change**, followed by explicit bridge/sampler integration. It is not
  exported at `ee8ca6ad`, and this PR neither invents nor accepts it. A separately
  specified authoritative interval-totals contract with bounds, unit and full
  coverage could be an alternative. Until an owner contract is implemented and
  integrated, daily realized PnL and fees remain `UNAVAILABLE` for every record.
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
- The source does not record cash, held value or BUY/SELL/fill counts. Both
  bots get `UNAVAILABLE` for those fields. Helm also lacks equity, fees and a
  quote-unit field. Missing money is never inferred from PnL or sample counts.
- The table uses the existing adaptive DataTable. Amounts use exact decimal
  sorting and text filters to retain every decimal digit in cells and CSV exports.

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
  decimals, no-data behavior, missing/changed units and all prior continuity
  cases covered by Node tests that invoke the real Python function/CLI. A
  Python regression projects a restore counterexample through the real sampler.
- [x] Exact Daily values rendered through the actual DataTable in a fixture.
- [x] API test confirms daily rows do not depend on chart range.
- [x] Mac V5 typecheck and focused tests; command receipts in the draft PR.
- [ ] Independent owner review, install approval, deployed/browser observation.

Install: goes in a dashboard install set (owner-approved set or card).
Rollback before install: omit/revert this commit. No source record migration
or sampler configuration changes are needed. No deployment is performed by this task.
