# FINAL3 F17/F18: real owner records and bounded API paging

F17 and F18 are repaired in Condor. This is a read-only consumer repair, not a
deployment, activation, qualification PASS or change to C1. Parent commit
`8af1b1c37cd39b8202d7daec59fa74bd58d52f94`, including blank string capabilities,
is preserved. Root dashboard code and protected projects are unchanged.

## Source and real-data provenance

- Producer: hummingbot `d13fb9b1ab72d3d167a6edc71f1ef363789cc553`.
- API: hummingbot-api `7b12d1c210cfde14af4f75071850187bd38f3089`.
- Workspace UI: parent's FINAL3 source `f3dcee938f3c`, fetched/extracted before
  this repair. No stale previous worker workspace is used.
- `tests/fixtures/paper-api-final3/*.json` contains the retained authenticated
  HTTP-200 FINAL3 responses. The original wrappers live under
  `/home/rsi/dev/rsibot/.workspace/scratch/v5-wp14/final3-20261030/api/`.
  Each response body is parsed and indented, not financially rewritten.
  `provenance.json` binds the original wrapper, body and vendored file hashes.
  Native JSON exports receive a trailing newline in Git; both hashes are kept.
- FINAL3 retained no accounting HTTP response. For coherent visual evidence,
  `native-replay/` contains another authenticated run of the **unchanged real
  API73 `create_app`** over a byte-for-byte private copy of FINAL3's actual
  native runtime export and its immutable companions. This is not the synthetic
  C1 fixture. Its private trust directory and watermarks belong only to this
  disposable replay. `export-native-api.py` and `export-native-pages.py`
  record the exact procedure. Accounting, all read sections and both fill pages
  come from one owner snapshot. The owner publishes 344 retained fill records:
  the API returns 200, then 144. No missing page is fabricated.
- API73 has **no orders route**. The native export's orders section is checked
  directly, not represented as a fictional HTTP-200 `/orders` response. That
  retained native orders list is empty; it is not non-empty order coverage.
- API authentication headers and production credentials are not vendored.
  The replay uses only a deterministic, disposable test token.

## Owner field rules

References use the exact revisions above, not moving branch heads.

| Record field or structure | Owner rule and source | Condor Python / TS |
| --- | --- | --- |
| `pnl_scope` | Non-empty identifier text; producer `hummingbot/strategy_v2/paper_session.py:562` emits `native_executor_fee_inclusive`; API `paper_observation.py:251` exempts accounting metadata from decimal checks | Metadata string, not a financial scalar |
| `count_basis`, `fee_quote_valuation_basis`, `target_basis` | Non-empty finite text, max 4096; target basis is an identifier. API `paper_observation.py:251` | Same metadata handling; existing C1 target schema remains enforced |
| `quantity`, `price`, remaining quantity/basis, fees, realized/unrealized PnL, target/limit prices | Finite decimal text or owner-permitted null; producer `scripts/meridian_v5_paper_observation.py:244` and `:267`; native executor amounts at `paper_session.py:557`; positions at producer `:588` | Decimal validation remains on financial values. Metadata exemptions do not admit numbers or booleans as money |
| `fee` | Object, exactly `fee_type`, `percent`, `percent_token`, `flat_fees`. API `paper_observation.py:108` | Structured validation; no scalar decimal check on the container |
| `fee.fee_type` | `AddedToCost` or `DeductedFromReturns`; native `hummingbot/core/data_type/trade_fee.py:134` and `:144`; API `paper_observation.py:112` | Enum string, not a decimal |
| `fee.percent`, `flat_fees[].amount` | Decimal text; currency/token string or permitted null; max 32 flat fees. API `paper_observation.py:108` | Typed structured fields and bounded arrays |
| `fees[]` | `{amount: decimal text, currency: currency string}`, max 32. API `paper_observation.py:122` | Structured array, not scalar money |
| `fees_paid` | Currency-keyed decimal map, max 32. Producer `paper_session.py:525`; API `paper_observation.py:273` | Validated map, not scalar money |
| `custom_info.close_quantity` | Structured owner projection, nullable decimal components, bounded exponent form and scale; API `paper_observation.py:126` | Structured validation; the C1 schema and ordinary decimal checks are retained |
| IDs, states, side, reason, unit and currency metadata | Producer passes native metadata through, rather than converting arbitrary labels to decimals: producer `:278`; API `paper_observation.py:251` and `:285` | String/container checks and C1 record schema remain; no invented enum where the owner defines none |
| `protected_exit`, `terminal`, `protected_exit_order` | Native protected-exit projection and C1 `schema.json` `$defs.protectedExitProjection` | Existing exact booleans, protected-exit shape, freshness, completeness, epoch and executor-ID rules remain |

The API's structured financial schemas, not a newly invented UI accounting
model, define the structured validations. The public boundary still rejects
malformed records with section-specific `502 / paper_read_schema_invalid`.

## Envelope field audit

The owner model is API73 `paper_observation.py:216` (`PaperEnvelope`). The
producer's section factory is `meridian_v5_paper_observation.py:315`.

| Field | Owner type | Condor Python / TS type |
| --- | --- | --- |
| `schema` | Fixed read-schema string | Same literal |
| `state` | available / collecting / not_applicable / degraded / stale | Same enum |
| `section` | String, selected from fixed route names | Exact requested section |
| `bot_id` | string or null | Bound bot string; null only for unbound collecting/degraded |
| `execution_mode` | literal `paper` | Same literal |
| `simulated` | literal true | Exact boolean true |
| `snapshot_id` | string or null | Non-empty string for bound reads; nullable only when unbound |
| `generated_at_ms` | int or null | Non-negative safe integer; null when unbound |
| `observed_at_ms` | int or null | Optional nullable safe integer, retained |
| `source_at_ms` | int or null | Optional nullable safe integer, retained |
| `read_at_ms` | int | Optional safe integer for older local projections; owner value retained |
| `completeness` | string, C1 complete / partial / collecting / unavailable | Same values; required on every list section in every state |
| `reason` | string or null | Same nullable string in every state |
| `stale_reason` | C1 nullable string; API conveys stale diagnosis in `reason` | Optional nullable string; no inference from missing text |
| `capabilities` | list of strings, including empty list and blank members | `list[str]` / `string[]`; parent behavior preserved |
| `data` | Any at envelope layer; C1 section model validates actual record/container shape | Section-shaped object/list/null plus C1 and native structured fields |
| `next_cursor` | string or null | Optional nullable non-empty string; opaque to projection |
| `source` | string-keyed object | Object, not a list; retained allowed source metadata |

No dashboard PROFILE capabilities dict was changed.

## Every paper request parameter

Canonical route signature: API73 `services/strategies/v5_advisory/app.py:158`.
The exact signature is vendored as `api73-paper-route.py.txt`; the regression
extracts its limit instead of asserting a detached consumer constant.
Reader semantics: API73 `paper_observation.py:1098` and `:1139`.

| Parameter | Owner constraint | Condor request behavior |
| --- | --- | --- |
| Section path | status, wallet, fills, positions, executors, risk, decisions, history, operations, accounting, candles | Fixed read-only aliases forward the first ten. No arbitrary section, orders, bot, host or URL is forwarded |
| `limit` | Integer, default 100, minimum 1, maximum **200** | Legacy requests up to 1000 are capped at 200. Direct transport rejects >200. Bots requests 200 per pageable read |
| `cursor` | Optional string, max 512; reader binds section, snapshot, range and offset | Bounded base64url transport; same snapshot and cursor sent to next page; duplicate cursor fails closed |
| `snapshot_id` | Optional string, max 160; mismatch gives 409 | Native identity string, max 160, pinned after status; each returned epoch is checked |
| `start_ms`, `end_ms` | Optional non-negative integers; both required together, ordered, end no later than owner clock, span <=31 days | Local paired/order/31-day checks; safe transport bound <=10^14. Owner retains final clock and record event-time authority |
| `pair` | Optional string max 41; only candles accepts it, then validates configured pair | Not forwarded by these ten read aliases; Candle store is a separate owner route. No accidental pair filter on wallet/risk/history |
| `interval` | No API73 paper parameter | Compatibility-only history enum 1m/5m/1h/1d, consumed locally |
| `bot` | No API73 paper parameter | Exact bound bot is checked locally and consumed |
| Other filters, duplicate keys, arbitrary URL/host or write routes | Not part of the read contract | Rejected, never forwarded |

Alias inventory: fleet holdings -> positions; fleet fills -> fills; fleet
summary/account-balances -> wallet; fleet accounting -> accounting;
controller-performance/history -> history; bound native status/quant summary
and bound trading-visuals quant summary -> status; bound executors/risk -> their
sections; bound decisions/decision-journal -> decisions; operations/workspace
-> host monitor when configured, otherwise owner operations. Chart-series
returns the existing collecting boundary, not an oversized API candle request.

The shared pager covers list sections and history segments. It uses at most
five pages (1000 rows at 200 per page), preserves an outstanding cursor at the
bound, and never upgrades partial data or mixes sections, states, completeness
or snapshots. Unconsumed cursors still prevent derived counts and totals.
Current C1 caps (fills 500, positions/executors 640, history segments 128) fit
inside this bound. Retained windows are never called lifetime totals.

## Fail-before and pass-after

`reproduce-before.py` reconstructs only the two original functions from
`8af1b1c3` in memory. It does not reset or overwrite the worktree. Plugin
autoload is disabled for this synchronous reproduction, because importing
Condor before pytest triggers the copied async plugin's metadata error.

- Before: **3 failed, 7 passed**. Real executors and fills return 502, and the
  history route forwards 1000 instead of 200. See `fail-before.log`.
- After: **10 passed** with the same tests. See `pass-after.log`.
- The earlier broader red run also caught 513-character cursors, missing range
  partners and ranges exceeding 31 days. New frontend regressions reject
  malformed native fee metadata and money and exercise snapshot-bound paging,
  repeated cursors, partial reads and the five-page bound.

Exact final commands, run in the Condor worktree:

```sh
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/tmp
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
  /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q tests \
  --basetemp="$TMPDIR/f17-full-final-c" -p no:cacheprovider
node --test frontend/test/*.test.mjs
frontend/node_modules/.bin/tsc -b frontend/tsconfig.json
V5_WORKSPACE_ROOT=/home/rsi/dev/rsibot/.workspace/scratch/v5-wp14/final3-20261030/src/workspace-f3dcee938f3c \
  frontend/node_modules/.bin/vite build --config frontend/vite.v5.config.ts --emptyOutDir false
```

Results: **4161 pytest passed, 8 skipped; 1013 node passed, 1 skipped; tsc PASS;
bundle PASS**. Existing deprecation and chunk-size warnings remain. The first
full run caught a fixture newline/hash mismatch; provenance now records both
byte identities and the complete final suite passes. That failed run is not
presented as a pass.

## Browser evidence

Bundle: `/assets/v5-C9Jpl8K6.js`.
SHA256: `97c2e126384cf32037d95c8c7eb4c405214fc97929ab75d98fade2730c560b4a`.

The exact Tailscale HTTPS origin on port 28443 was opened and checked in the
shared real browser. Two shared-browser resize attempts remained at 1280x800.
The real-Chrome harness therefore captured the requested widths. For every
capture it compares the served HTML, entry JS and all loaded JS/CSS hashes with
the final built files. `screenshots/screenshot-index.json` binds the bundle and
PNG hashes. All 18 final PNGs were opened and visually inspected individually.
No schema-error panel, 422 history request, document overflow, clipped main
content or browser exception appeared. The real fill table contains 344 rows.

| Page | 1440 light / dark / colour-blind | 390 light / dark / colour-blind |
| --- | --- | --- |
| Bots | `screenshots/bots-light-1440.png`, `bots-dark-1440.png`, `bots-colorblind-1440.png` | `screenshots/bots-light-390.png`, `bots-dark-390.png`, `bots-colorblind-390.png` |
| Capital | `screenshots/capital-light-1440.png`, `capital-dark-1440.png`, `capital-colorblind-1440.png` | `screenshots/capital-light-390.png`, `capital-dark-390.png`, `capital-colorblind-390.png` |
| Operations | `screenshots/operations-light-1440.png`, `operations-dark-1440.png`, `operations-colorblind-1440.png` | `screenshots/operations-light-390.png`, `operations-dark-390.png`, `operations-colorblind-390.png` |

Financial values remain the real owner's values. Browser-only fixture clocks,
snapshot epochs, source sequences and opaque cursor epochs are rebased
together, without mixing different source snapshots. Original raw API fixtures
remain unchanged. The stopped native trial truthfully has partial operation
and candle diagnostics; those are not changed to PASS. The separate retained
host monitor includes its real holds and incidents. No green readiness claim
is made.

The disposable project `v5-f17-real-replay-20261031` is stopped, not removed.
Only this task's Serve route was withdrawn. Before/after Serve JSON is exactly
equal. Existing routes and all protected projects remain untouched. No image
was built: the disposable uses image
`sha256:804b2cc47e27b23db3032d3989341f51bd142c05c1a4a39ff15c20d0cd5f2be4`
(`main-024dcf5a-aa306357`) with this task's source and frozen bundle mounted
read-only. The worktree and all attempts remain preserved under the no-deletion
rule. Rollback is a normal revert of this consumer repair, not a state reset.

## Remaining observations

- Capital still displays long exact owner decimals that wrap. Operations still
  displays raw monitor check identifiers and retained incidents. These are
  visible in the screenshots and owned by the root dashboard worker; this
  repair does not silently redesign or claim to fix those pages.
- The copied native candle companion is partial; charts and comparable wallet
  statistics remain collecting, not fabricated.
- No real running owner, protected deployment, paid provider or live trading
  surface was changed. There is no new independent review of this head yet.
