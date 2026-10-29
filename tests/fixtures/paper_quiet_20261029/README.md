# Dated paper PnL fixtures

These are bounded candidate reporting projections of the full runtime-status captures in
rsibot `dashboard/hummingbot-reporting/tests/fixtures/paper_quiet_20261029/`.
They retain every input read by Condor's paper PnL parser. They are not responses read from
the deployed reporting service. `_fixture_source` binds each projection to its decompressed
runtime fixture hash and capture timestamp. No secrets or live database data are included.

Both source statuses were read directly at 2026-10-29T12:31:54.50175Z (V4) and
2026-10-29T12:31:54.501816Z (D2h). BNB was quiet for 5.3 seconds. The engine published
four native reports and one retained report per bot. Both retained marks are dated
2026-10-29T12:31:49.201Z. The candidate reporting projection sums all five reports and
sets `pnl_basis: "retained_marks"` and `pnl_observed_at` to that earlier time. It leaves
`ready` and `native_reports_complete` false.

`tests/test_paper_retained_performance.py` verifies both bots, timestamp validation,
legacy compatibility and duplicate-time history behavior. A retained valuation with
missing, invalid, stale or future observation time must not use the fresh heartbeat.
