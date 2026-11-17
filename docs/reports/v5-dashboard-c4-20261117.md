# V5 dashboard C4 writer handoff

Current state: the final owner-repair receipt at the end supersedes round-1
source-schema, descriptor-cleanup, catch-all routing and legacy-logo decisions.
Round 2 on `e1224dbc` closed every round-1 finding; the boss owns the bounded
final verification of C1–C4 and the two nits. No further broad review is planned.

## Root cause

Install 10 applied `ownerTitle()` through `ownerDisplay().exact`, but native Bots metrics, expression titles, Trades exact overrides, chart markers/tooltips, phone row wrappers, market features and record previews bypassed it. The existing route scan deliberately excluded most hover titles and used mostly twelve-place fixtures.

The transitive private Capital page in rsibot also interpolated raw owner values in `amount()` titles. This requires the named rsibot companion branch from `209b10912f6c75554e0f97e0bc35ad6e55a6e831`, with only that display sink, title assertions and the Condor gitlink changed. Its independent fixture money values remain unchanged; the assertions now expect the shared twelve-place title contract.

The V5 backend mounted `/assets` and one fixed logo route, but not the other public files copied to the dist root. `v5.html` had no favicon link. The phone touch-target selector also enlarged native checkbox glyphs to 44px; cash and volume tiles still used four decimals beside two-decimal money tiles.

## Repair

- Owner-number title paths delegate to existing `ownerTitle()` through the scalar `ownerTitleText()` adapter. Typed expression builders format operands before interpolation; the adapter no longer searches arbitrary prose. Text columns, IDs, hashes, paths and record identifiers stay exact.
- Owner inputs, numeric calculations, receipt ratios, marker identities, exact as-sent disclosures, read queries, admission and owner-state checks are unchanged. Visible chart fill readouts use the exact original `markerText()` as on `45ec2f82`; only their titles are bounded. OHLC and volume readouts retain their existing visible formatters.
- New root images use exact routes from the sibling `frontend/v5-reviewed-build.json` allowlist. Only safe top-level image names are admitted. Responses use `O_NOFOLLOW | O_CLOEXEC`, inspect a regular file and its 8-MiB cap on that same descriptor before constructing a stream, then read, hash-verify and return its bytes. Descriptor ownership starts immediately after open and ends in `finally`. `O_NONBLOCK` prevents a FIFO replacement from hanging. New static HEAD requests verify the same bytes and return identical status/headers without a body. Missing manifests warn and withhold new assets. The legacy logo keeps its exact `45ec2f82` manifest-independent GET route, including symlink rejection and HEAD 405.
- The runtime image copies that same reviewed manifest beside its built dist. Without this packaging change, a built image would correctly fail closed but still return 404 for the new assets. The image-copy regression failed before the Dockerfile repair; no image build or deployment is claimed.
- `v5.html` links the shipped `/favicon.svg`; a browser request for `/favicon.ico` aliases that reviewed SVG with `image/svg+xml`.
- Phone checkbox/radio labels retain a 44px touch target without enlarging the native glyph. Cash, traded volume and retained wallet-equity tiles use two decimal places.

**Contract arithmetic correction:** `199123.96997705845820` has **13**, not twelve, decimal places after dropping trailing zeros. It therefore becomes `≈ 199123.969977058458 (rounded)` under the stated rule. `199123.96997705845800` genuinely has twelve places after trimming zeros and stays exact. No exception was added.

## Simplification

No new numeric rounding implementation, dependency, service, configuration flag, owner ledger, API authority or arbitrary static-directory mount. The title adapter reuses the existing string-arithmetic rule. Hash-verified root images are read once, not verified and then reopened for delivery.

## Changed assertions: old → new

This is the original C4 receipt. The round-1 correction receipt below supersedes
its prose-adapter and visible chart-hover expectations and its previous build identity.

All changes are display expectations; owner fixtures, raw accounting assertions, identity/reconciliation checks, protection checks, clock checks and fail-closed read tests stay in place.

| Assertion family | Old | New |
| --- | --- | --- |
| Bots live realized profit | `114.1396691483993272381433853` title | `≈ 114.139669148399 (rounded)` |
| Supplied live wallet | raw `199123.96997705845820` title | `≈ 199123.969977058458 (rounded)`; true twelve-place padded control stays exact |
| Breakeven-distance expression | raw `680.8963033983613722931914460` operand | `≈ 680.896303398361 (rounded)` operand; `594.17` and existing rounded result stay unchanged |
| Trades exact override | arbitrary long override bypasses formatter | positive/negative ties round away from zero; carry `9.9999999999995` becomes `≈ 10 (rounded)` |
| Bots Today title / failed-cache negative assertion | raw `-12.000000000000000000000000000001` | `≈ −12 (rounded)` in both presence and absence assertions |
| Position profit expression | raw long realized value on both sides | each owner operand/result bounded independently |
| Position breakeven/trailing peak | raw 25/18-place titles | `≈ 680.896303398361 (rounded)` / `≈ 800.123456789123 (rounded)` |
| Position holdings/dust | raw `1.234567890123456789` / `0.000000000000000001` | `≈ 1.234567890123 (rounded)` / `≈ 0 (rounded)`; visible holdings and dust policy unchanged |
| Market holding expression | raw `0.016200000000000000000000000010` | `≈ 0.0162 (rounded)`; integer price operands remain exact |
| Money / Overview since-start expression | raw equity/net precision | bounded equity `≈ 199980.077146231622 (rounded)` and net `≈ −19.922853768378 (rounded)` |
| Money percent expression | `−0.0099614268841888%` | `≈ −0.009961426884 (rounded)%`; calculations still retain the original ratio |
| Finite cohort percentage | `0.000095367431640625%` | `≈ 0.000095367432 (rounded)%`; `1 / 1048576` inputs retained |
| Chart tooltip rounded-zero value | raw `-0.0040000000000000001` title | `≈ −0.004 (rounded)` title; visible `0.00` unchanged |
| Chart marker title | raw long quantity/price | each is bounded by ownerTitle; side and exact millisecond UTC time retained; marker IDs stay raw and distinct |
| Chart hover readout | raw `BUY 0.00000000 @ 101.123456789` | visible `BUY 0 @ 101.12`; per-fill title carries bounded owner detail |
| Stocks selected price titles | `9876.000000000000001`, `9877.000000000000001`, `456.000000000000001` | `≈ 9876 (rounded)`, `≈ 9877 (rounded)`, `≈ 456 (rounded)` |
| Stocks exponent / preview selection | raw tiny exponent in hover title | `≈ 0 (rounded)`; exact JSON disclosure still contains original exponent and identifiers |
| Engine feature title | raw `0.123456789012345678901234567890` | `≈ 0.123456789012 (rounded)` |
| Route scan | visible-only scan, mostly twelve-place strings | exact 28-place fixture plus every `[title]`, including phone pseudo-element sources, across every registered V5 route and expanded scenarios |
| Phone row wrappers | raw summary and expanded-field titles | both wrappers and their owner cells use the shared title rule |
| Cash / volume tiles | `198,162.2907 USDC` and other four-place values | two decimal places, matching money tiles; current/unavailable gates preserved |
| System checkbox at 390 / 430 | native glyph forced to min-width/min-height 44px | 20px glyph, 44px label touch target; text/search inputs remain 44px |
| Root public assets / favicon | four root assets and implicit favicon return 404; no icon link | manifest-bound 200 with exact bytes/content types; icon link resolves; traversal, extra files, symlinks and changed bytes rejected |
| Private Capital title | raw `1234567.123456789123456789 USDC` | `≈ 1234567.123456789123 (rounded) USDC`; visible grouped value unchanged |
| Private Bots fixture title map | six raw owner titles | explicit independent rounded-title literals; the same six visible monetary values and all age/remount/skew/withholding assertions remain |
| Private Bots first frame / failed read / retained cache | raw equity title and raw Today title | `≈ 199980.077146231622 (rounded)` and `≈ −12 (rounded)`; cache transport, first-frame absence and stale-value checks remain |
| Runtime static manifest packaging | final image has dist only | final image also has the exact reviewed manifest; no arbitrary root file serving |

## Width sweep and Backlog

Evidence is the supplied install-10 archive, not a new installed build. Viewed the Overview, Bots, Market, Helm and Agents screenshots at **1280, 390 and 430**, local System captures at **390/430**, plus Trades/trade-detail/chart recaptures. Contact sheets and a readable trade-detail crop are retained under `/var/tmp/dash-c4`.

- All 32 `compare.json` captures report document `scrollWidth == clientWidth`; the recaptured phone Trades tables intentionally scroll within the page. The retained gesture moved `scrollLeft` to 150 with client width 344 and table width 957. This is not proof of every hidden interaction or the new build's browser layout.
- Fixed clear defects: raw owner titles, raw long chart hover fill text, four-versus-two-place monetary tiles, and oversized native System checkboxes. Each has a regression test.
- No additional document overflow or permanently clipped text is demonstrated by this evidence. Phone table columns extend beyond the initial view but have observed horizontal scrolling.

**Backlog — owner: V5 dashboard boss:**

1. Phone Trades tables require horizontal scrolling through 610–1011px tables in a 344px region. A card/column-priority redesign needs its own interaction and information-retention acceptance; do not drop columns here.
2. Bots' five full controller IDs dominate the first phone screen. A concise summary with complete, accessible owner identity details needs an agreed presentation; do not abbreviate authoritative IDs opportunistically.
3. Helm mandate/revocation text makes the two-column phone cards tall, and the laptop grid leaves a lone Funding tile. Rebalance the tile hierarchy in a separate layout slice, with fresh rendered checks.
4. Market phone cards wrap premium timestamps and long unavailable reasons densely. A one-column or progressive-details design needs a deliberate information hierarchy, not hidden diagnostics.
5. Research subnavigation extends beyond the first phone view. Improve horizontal-scroll affordance or navigation composition separately; do not remove destinations.
6. The archived Market snapshot contains an owner-read `paper_read_schema_invalid` / HTTP 502, and Agents lacks upstream projected history. Those are owner-source readiness limits, not permission to fabricate values or change bots/APIs in this display-only task.
7. The new local build warns about mixed static/dynamic imports and an approximately 1.83MB minified entry chunk exceeding the 600KB advisory threshold. Bundle splitting needs a separate loading/performance acceptance, not a width redesign. No runtime performance measurement or baseline regression attribution is claimed.

## Verification

Scratch/log root: `/var/tmp/dash-c4`. Every heavy command, including both worktree additions and dependency copy, ran serially through:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-c4 --wait 5400 -- nice -n 10 <command>
```

All test/build invocations set `TMPDIR=/var/tmp`; Node checks set `NODE_OPTIONS=--max-old-space-size=1536`. Python checks also set `PYTHONDONTWRITEBYTECODE=1`, `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`, and `PYTHONPATH=.:tests`.

Fail-first evidence:

- Exact `45ec2f8240a3c42d0c9d4aad91d814b1ec94fc8b` production source loaded through `git show`, without resetting or modifying a baseline checkout: `V5_TITLE_BASELINE=45ec2f8240a3c42d0c9d4aad91d814b1ec94fc8b node --test --test-concurrency=1 test/v5-owner-title-contract.test.mjs test/v5-route-render-loop.test.mjs` from `condor/frontend`: **33 passed, 8 failed**. Includes decisive live title/expression/override/row/width failures and the all-route scan. Log: `baseline-final-source-valid.log`.
- Final split-case run of the same exact-base command: **34 passed, 9 failed**. Profit and supplied wallet are independently named failing tests, the genuine twelve-place padded control passes, and the all-title route scan still fails. Log: `baseline-split-live-cases.log`.
- Initial server regressions before app/HTML repair: `python -m pytest -q -p no:cacheprovider --basetemp=/var/tmp/dash-c4/pytest-baseline tests/test_v5_static_assets.py`: **6 failed, 12 passed**. All four missing root assets, implicit favicon and HTML icon link fail. Traversal/withholding controls pass. Log: `baseline-python.log`.
- Checkbox test on unchanged base phone CSS: `node --test --test-name-pattern="phone checkboxes" test/v5-phone-layout.test.mjs`: **1 failed**, 390px checkbox min-width was `44px`. Log: `baseline-checkbox-actual.log`.
- Private Capital before its source repair, from `dashboard/condor-workspace`: `node --test --test-name-pattern="paper Capital rounds" test/v5-paper-capital.test.mjs`: **1 failed**. Log: `baseline-private-capital.log`.
- Runtime-image manifest packaging on the unchanged Dockerfile: `python -m pytest -q -p no:cacheprovider --basetemp=/var/tmp/dash-c4/pytest-image-baseline tests/test_v5_static_assets.py -k runtime_image`: **1 failed, 19 deselected**. Log: `baseline-image-manifest.log`.
- During implementation, one complete frontend run reported **832 passed, 16 failed**, all old raw-title/hover expectations. Updated assertions are listed above, including the negative cached-read assertion. The log remains `frontend-full-1.log`.
- Retained initial harness mistakes (wrong working directory; missing static-render context) are not counted as regression proof or passes. Corrected reproductions have separate logs.
- The first private-suite run was **666 passed, 15 failed**; after its shared title-map and Capital expectation updates it was **677 passed, 4 failed**. The four remaining direct raw-title assertions were updated to explicit bounded literals, not removed. Logs: `private-workspace-final.log`, `private-workspace-corrected.log`.

### Final integrated local checks

These commands ran from the named C4 worktree, through the serial gate above. Common environment: `TMPDIR=/var/tmp`, `NODE_OPTIONS=--max-old-space-size=1536` for Node; Python also sets `PYTHONDONTWRITEBYTECODE=1`, `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`, `PYTHONPATH=.:tests`.

| Working directory | Exact command after gate/environment | Result | Log under scratch root |
| --- | --- | --- | --- |
| rsibot C4 root | `node dashboard/v5-workspace/typecheck.mjs condor/frontend .` | PASS, exit 0, no diagnostics | `typecheck-integrated-final.log` |
| `condor/frontend` | `node --test --test-concurrency=1 test/v5-*.test.mjs` | 850 passed, 0 failed, 0 skipped | `frontend-integrated-final.log` |
| `condor` | `/Users/s1kor/anaconda3/bin/python3 -m pytest -q -p no:cacheprovider -p pytest_asyncio.plugin --basetemp=/var/tmp/dash-c4/pytest-integrated-final tests/test_v5_dashboard_bridge.py tests/test_v5_helm_status.py tests/test_v5_money.py tests/test_v5_workspace_auth.py tests/test_v5_paper_trade_costs.py tests/test_v5_advisor_history.py tests/test_v5_static_assets.py` | 656 passed | `python-integrated-final.log` |
| `dashboard/condor-workspace` | `node --test --test-concurrency=1 test/*.test.mjs` | 681 passed, 0 failed, 0 skipped; temporal mutation tests still kill their mutants | `private-workspace-verified-final.log` |

The Python command explicitly loads `pytest_asyncio.plugin` because general plugin autoload is disabled. An earlier run without that plugin reported 652 passed / 3 async-harness failures; the corrected command passed all 655 tests then present, and the final command above passes all 656 including runtime-manifest packaging. Both earlier logs remain: `python-required-final.log` and `python-required-asyncio.log`. No asynchronous server assertion was skipped or weakened.

### Reviewed build and actual built-file smoke

From `condor/frontend`, gated with the same Node memory cap and `TMPDIR`:

1. `V5_WORKSPACE_ROOT=/Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-c4 node node_modules/vite/bin/vite.js build --config vite.v5.config.ts --outDir /var/tmp/dash-c4/artifact-c4/dist-v5 --emptyOutDir false` — PASS; output was required not to exist beforehand. Log: `build-reviewed.log`.
2. Regenerated only `{entry, entrySha256, files}` using the canonical tool's exported `distHashes()` and the built HTML's module script. Installed Vite, TypeScript, React, React DOM, React plugin and Tailwind plugin versions match the corresponding lockfile entries; no dependency files changed.
3. `node tooling/check-v5-reproducibility.mjs rebuild /var/tmp/dash-c4/repro-c4-final /Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-c4` — PASS, **two fresh builds**, each verifies all **26 files** against the reviewed manifest. Both builds use this same workspace; this is not a cross-machine or Docker-image proof. Log: `reproducibility-final.log`.
4. Sequentially within that final gate, `PYTHONPATH=/Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-c4/condor:/Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-c4/condor/tests /Users/s1kor/anaconda3/bin/python3 /var/tmp/dash-c4/check-built-static.py /var/tmp/dash-c4/artifact-c4/dist-v5 /Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-c4/condor/frontend/v5-reviewed-build.json` — PASS. It copies the reviewed manifest beside the actual built dist and uses an in-process TestClient with fake upstream: **25 shipped JS/CSS/image files** return 200 with reviewed byte hashes; **six root-image requests**, including implicit favicon, have correct content types; **six traversal/unlisted requests** return 404; built HTML links the shipped icon. No listening server or live connection is started. Log: `built-static-final.log`.

Reviewed entry: `assets/v5-MyocE3Dw.js`. SHA256: `62ebcdeaab7fa3eaae84f8587cb2fe1781b5ec9d121e9694a4c30ce3df77d21f`. The manifest and runtime-image copy must travel with this build and the rsibot companion pin.

### Git backing-store incident and recovery

After the first local Condor commit, `90ef064206a880a6007050c3900ad3f198ba09aa`, and before any push, its borrowed common Git store under `rsibot/.git/worktrees/v5-k17/modules/condor` disappeared. The exact actor is unverified. The first root-side commit command stopped before staging anything because that nested Git directory could no longer be read. No source files or retained validation evidence disappeared. The original unpushed commit identity is retained here; its vanished object is not claimed recoverable.

The owning-boundary repair is an independent, task-owned bare Git store at `/Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-c4/.workspace/condor-owner.git`, not another task's disposable submodule store. The gated recovery fetched only the release branch, verified its exact base `45ec2f8240a3c42d0c9d4aad91d814b1ec94fc8b`, and registered an empty `--no-checkout` worktree. After preserving both old pointer files under `/var/tmp/dash-c4`, the store was moved into this ignored task-owned directory, the existing source pointer was relinked, and `git worktree repair` repaired the backlink. `git read-tree 45ec2f8240a3c42d0c9d4aad91d814b1ec94fc8b` initialized only the fresh index; no checkout, reset, stash, force, source overwrite or deletion was used.

A before/after SHA256 inventory verifies **684 production/test/build-input files unchanged**, with **zero mismatches**. Inventory: `/var/tmp/dash-c4/source-before-metadata-repair.sha256`, inventory SHA256 `4e1c7e2991a79591463bb4a1e31c86198c6cde22a4cdd145e6c811893d5d77e7`. The reviewed manifest itself remains `772c579b9f96c9eb7b095203182d98d7be63ebdc49f611c2c78aa1ec33802231`. Thus the prior local checks and built-file proof still apply to the same source bytes; only Git metadata and this documentation receipt change during recovery. The task is recommitted on the same exact base; final commit/push identities are the final handoff's, not the unavailable first commit's.

Recovery fetch/registration log: `/var/tmp/dash-c4/git-metadata-repair.log`. Preserved pointers: `condor-git-pointer.before-repair.txt` and `condor-git-pointer.registration.txt` in that directory. Both actual task worktrees are locked for handoff; retain the task-owned backing store with them. The empty registration scratch directory is also retained. This removes the cross-task lifecycle dependency without touching the original root working checkout.

## Remaining

No merge, install, deploy, service restart, browser connection to live services, trading operation or real credential/token access occurred. No checkout work, branches, worktrees or retained evidence were deleted or discarded. Independent review was not run: this writer was explicitly forbidden to delegate. Boss review and live acceptance after an authorized install remain required. Keep the task worktrees/branch and retained evidence.

## Round-1 correction receipt — 2026-11-17

This section supersedes the earlier implementation, assertion and build descriptions
where they conflict. Starting clean heads: Condor
`aa9d761580148e21a57c7572ce79fe02cdf5b7fb`, rsibot
`4b670f0770f24fba08039c2f8f2a7157888fa959`; both branches are
`feat/andrzej_v5_dashboard_backlog_c4`. Only the locked C4 worktree was used.

### Root cause

- B1: desktop cells bypassed the title boundary, including JS numbers and Stock
  depth fields whose existing sort kind is text. The route fixture poisoned strings only.
- B2/S1: the prose-wide substitution adapter had no field semantics: it changed
  decimal-looking identifiers while missing adjacent arithmetic operands.
- B3: chart hover text was changed along with its title, outside the display contract.
- B4/S2/S5: the legacy logo bypassed the manifest, pathname checks raced reads,
  HEAD was not registered, and absent manifests had no warning.
- S3/S4: scanner recognition shared adapter assumptions and money-tile expectations
  called the formatter under test instead of using independent literals.

### Repair

- Numeric table columns and title-only `ownerValue` metadata call the same scalar
  `ownerTitle()` rule through `ownerTitleText()`. Text IDs remain exact on both
  layouts. Stock sort/filter kinds and visible values stay unchanged.
- Expressions format typed operands and results at their builders, retaining raw
  `.exact` provenance where consumed elsewhere. Stock record titles format known
  amount keys and only the first two bid/ask fields; paths, IDs and other fields
  remain exact. Exact-as-sent JSON remains unchanged.
- Restored visible `markerText()` as on `45ec2f82`; a separate typed marker title
  bounds only hover attributes. Phone visible notes are retained separately from titles.
- Root assets, including the legacy logo, use manifest membership, a safe basename,
  `O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK`, same-descriptor `fstat`, an 8 MiB regular-file
  cap, bounded reads and SHA256 validation. HEAD verifies the same bytes and returns
  GET's status/headers/content length without a body. Missing manifests warn.
- Independent fraction/exponent probes, numeric poisoning and deterministic
  pre-open symlink/post-open inode-swap tests cover the missed boundaries. Tile
  expectations are six explicit literals. No dependency/build-config/checkbox change.

### Simplification

Removed prose-wide number replacement and the separate unverified logo route.
No new dependency, state authority, service or formatter rule. Explicit title-only
metadata avoids changing Stock sort semantics to fix an unrelated display issue.

### Changed assertions: round-1 old → new

| File / assertion | Old | New |
| --- | --- | --- |
| `v5-marker-labels.test.mjs`, visible BUY/SELL | `BUY 0 @ 101.12`; `SELL 1.23457 @ 102.99` | `BUY 0.000000000000000001 @ 101.1234567890123456789`; `SELL 1.234567890123456789 @ 102.9876543210987654321`; exact UTC suffixes unchanged |
| `v5-phone-bots-layout.test.mjs`, visible BUY | `BUY 0 @ 101.12` | `BUY 0.00000000 @ 101.123456789`; exact UTC suffix unchanged |
| `v5-bots-summary.test.mjs`, title oracle | `ownerTitleText(tile.exact)` | explicit `≈ 199980.077146231622 (rounded)`, `≈ −19.922853768378 (rounded)`, `≈ −12 (rounded)`, `≈ 13.093702869214 (rounded)`, `≈ −33.016556637591 (rounded)`, `≈ 4.314779042378 (rounded)` |
| `v5-owner-title-contract.test.mjs`, expression source | raw `distance.exact` sent to prose adapter | typed builder's `distance.title`; same expected bounded expression |
| Same file, scalar probes | prose containing leading dot / Unicode minus / exponent | explicit `.1234567890125` → `≈ 0.123456789013 (rounded)`, `−1.1234567890125` → `≈ −1.123456789013 (rounded)`, `1e-13` → `≈ 0 (rounded)`; `order/1.12345678901234567890` unchanged |
| Same file, phone owner column | implicit text column | explicitly numeric owner column; four bounded title assertions unchanged |
| `v5-bots-position.test.mjs` / `v5-candle-store-views.test.mjs` | `{text, exact}` | original fields unchanged, plus explicit `title` equal to the original short expression |
| `v5-trade-costs.test.mjs` | exponent-source object has `exact` only | same `exact`, plus title `1e1 / 70 × 100 = ≈ 14.2857 % (rounded)` |
| `v5-market-detail-values.test.mjs` | raw floating results `-0.004000000000004`, `49.998799999999996`; interpolated range | explicit `≈ −0.004 (rounded)`, `≈ 49.9988 (rounded)` and literal range `50`; inputs retained |
| `v5-route-render-loop.test.mjs`, scanner count | 4 matches | 5 independently detected matches, including an ID-looking digit run; separate identifier-preservation tests prevent semantic overreach |
| Same file, chart close lookup | hardcoded original close | poisoned fixture's actual close, preserving the original lookup's meaning |
| Same file, visible scan | scans restored exact marker readout as formatted value | excludes only marker readout text, not its title; explicit marker tests assert raw visible text |
| `v5-stocks-presentation.test.mjs`, retained catalog after detail failure | raw `123.456789012345678901` title | bounded title `≈ 123.456789012346 (rounded)` and unchanged visible `123.46`; failed detail's prior price still forbidden |
| `test_v5_static_assets.py`, verified-byte race | monkeypatch pathname `read_bytes` | swap pathname after `os.open`; response must contain the already-open reviewed inode's bytes |
| `test_v5_dashboard_bridge.py`, logo fixture | logo without manifest | fixture includes exact HTML/logo hashes; existing status/content/deep-link assertions unchanged |

The raw-source assertions were not loosened: native amounts, IDs, accounting,
state/clock/error handling, exact record disclosure and fail-closed checks remain.

### Verification: fail before repair

Every heavy command used this exact gate prefix (no alternate pool or bypass):

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-c4 --wait 5400 -- nice -n 10
```

The commands below ran after that prefix, with `TMPDIR=/var/tmp`,
`NODE_OPTIONS=--max-old-space-size=1536`, `PYTHONDONTWRITEBYTECODE=1` and
`PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` where applicable.

From Condor/frontend:

```sh
env V5_TITLE_BASELINE=aa9d761580148e21a57c7572ce79fe02cdf5b7fb node --test --test-concurrency=1 test/v5-owner-title-boundaries.test.mjs test/v5-route-render-loop.test.mjs
```

**33 passed / 9 failed / 42 total**, exit 1: all eight new boundary tests fail
on pinned production source, plus the real-route render loop. Failed identities:
desktop td/th; numeric title override with visible note; text IDs; candle health
detail; Stock record IDs/amounts; Stock depth/trade title metadata; breakeven
operands; Helm/System derived results; settled real V5 routes. The baseline route
failure includes raw numeric `mean_abs_bps`/`p95_abs_bps` and Stock price titles.
The hook obtains each frontend production module using `git show <SHA>:<path>`;
it does not edit or switch the checkout.

From the task-owned baseline archive directory:

```sh
env PYTHONPATH=.:tests /Users/s1kor/anaconda3/bin/python3 -m pytest -q -p no:cacheprovider -p pytest_asyncio.plugin --basetemp=/var/tmp/dash-c4-r1-fix.t93QyW/pytest-baseline-final tests/test_v5_static_assets.py
```

**20 passed / 13 failed / 33 total**, exit 1, using exact archived `aa9d7615`
production with only the new static test file overlaid. `condor/v5/app.py` SHA256
matches `git show` exactly:
`e21cace6cf8e3372fbf83c9ae2192e14b4cb732f00526bf612fadb7d7074be54`.
Failing node suffixes under `tests/test_v5_static_assets.py::`:

- `test_root_static_requires_a_bounded_regular_descriptor[directory|fifo|oversized]`
  (each GET is rejected; baseline HEAD is 405 rather than the required 404).
- `test_root_static_size_limit_uses_the_open_descriptor`.
- `test_legacy_logo_also_requires_its_reviewed_hash`.
- `test_root_static_head_matches_get_headers_without_body[condor.png|favicon.svg|hyperliquid.png|icons.svg|condor_old.jpeg|favicon.ico]` (six distinct nodes).
- `test_root_static_symlink_swap_at_open_is_rejected` (baseline returns 200).
- `test_missing_static_manifest_logs_warning`.

### Verification: rebuild identity

From Condor/frontend, gated as above:

```sh
env V5_WORKSPACE_ROOT=/Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-c4 node node_modules/vite/bin/vite.js build --config vite.v5.config.ts --outDir /var/tmp/dash-c4-r1-fix.t93QyW/seed-dist --emptyOutDir false
node tooling/check-v5-reproducibility.mjs rebuild /var/tmp/dash-c4-r1-fix.t93QyW/repro-final /Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-c4
```

Seed build PASS. Regenerated `frontend/v5-reviewed-build.json` from built HTML's
module entry and the canonical exported `distHashes()`, verified with `verifyDist()`.
Rebuild PASS: **two fresh builds, 26/26 files verified each**, exit 0.
Entry `assets/v5-DnpER67o.js`; SHA256
`b170da8e1eed2f9324775b12a6e1281c435f3941fec11d52ae0e58a1635d3d37`.
Both builds use the same workspace; no cross-machine/Docker proof is claimed.
Vite reports existing mixed static/dynamic imports and the large entry chunk.

### Verification: final local gates

All commands use the exact gate/environment above. From Condor:

```sh
node ../dashboard/v5-workspace/typecheck.mjs frontend ..
```

**PASS**, exit 0. From Condor/frontend:

```sh
node --test --test-concurrency=1 test/v5-*.test.mjs
```

**858 passed / 0 failed / 0 skipped**, exit 0. The focused boundary/route run
also passed **42/42**. From Condor:

```sh
env PYTHONPATH=.:tests /Users/s1kor/anaconda3/bin/python3 -m pytest -q -p no:cacheprovider -p pytest_asyncio.plugin --basetemp=/var/tmp/dash-c4-r1-fix.t93QyW/pytest-final-confirmed tests/test_v5_dashboard_bridge.py tests/test_v5_helm_status.py tests/test_v5_money.py tests/test_v5_workspace_auth.py tests/test_v5_paper_trade_costs.py tests/test_v5_advisor_history.py tests/test_v5_static_assets.py
```

**669 passed / 0 failed**, exit 0, including **33 static-asset cases**.
From the C4 worktree's `dashboard/condor-workspace`:

```sh
node --test --test-concurrency=1 test/*.test.mjs
```

**681 passed / 0 failed / 0 skipped**, exit 0. These are local test results,
not hosted CI, browser or deployed-service evidence.

Intermediate failures were repaired, not classified as baseline parity: the
first full frontend run was **851 pass / 5 fail**, then **857 pass / 1 fail**;
the last failure expected a now-bounded Stock catalog title. The first canonical
Python run was **668 pass / 1 fail** because its synthetic legacy-logo fixture
lacked the now-required manifest; adding exact fixture hashes preserves all
existing success/deep-link assertions without weakening the production guard.
A redundant queued validation command was stopped before admission; it is not
counted as a check. The completed final stream above supplies every required result.

Before any production edits, this gated command also demonstrated the marker
regression on unchanged `aa9d7615` source, from Condor/frontend:

```sh
node --test --test-concurrency=1 test/v5-owner-title-boundaries.test.mjs test/v5-marker-labels.test.mjs test/v5-phone-bots-layout.test.mjs
```

That initial mixed run was **11 pass / 7 fail**. Three failures were the explicit
original visible marker expectations (`v5-marker-labels.test.mjs` hover and
move-off tests, and `v5-phone-bots-layout.test.mjs` chart-hover test): actual
`BUY 0 @ 101.12` differed from required raw text. One Stock boundary test in this
early run had a test-import setup error; it was corrected, and the later pinned
42-test baseline run above is the authoritative boundary fail-first evidence.

`git diff --check` passed in both repositories. The existing checkbox stylesheet,
package files and Vite configuration have no changes relative to `aa9d7615`.

### Remaining

No subagents, independent review, services, credentials, merge, deployment or
live verification. The boss owns round 2, the last broad review, and acceptance.
The locked worktree and task-owned Condor Git backing store must remain.
Only this writer's `/var/tmp/dash-c4-r1-fix.t93QyW` scratch is eligible for removal
after its evidence has been recorded. Earlier `/var/tmp/dash-c4` is not ours.

## Final owner-repair receipt — C1–C4, 2026-11-17

### Root cause

Round-2 baseline: Condor `e1224dbc19bbc96e0f501aea1972957fc655c3cb`, rsibot
`20629af1a28d9f1926ff7573b3dcf6f1fbd4f237`, both on
`feat/andrzej_v5_dashboard_backlog_c4` in the existing locked C4 worktree.
The title replacer reused the visible preview's partial numeric-key set;
`fdopen(open(...))` left rejected directory descriptors ownerless; a root
catch-all changed unrelated method matching; the new manifest requirement also
captured a pre-existing logo route. Phone summary null titles had disappeared.

### Repair: correction → change → test

| Correction | Change | Test / observed evidence |
| --- | --- | --- |
| C1 | Source schemas declare decimal, opaque and book-tuple roles for instruments and all seven carried OKX event kinds; source TypeScript payload types derive from those same schemas. Title projection selects the dataset's schema and calls the existing scalar formatter only on declared numeric fields. The visible preview is unchanged. | Independent real-shaped funding/ticker fixture checks all 21 amount fields, including `settFundingRate`; IDs, timestamps, paths, hashes, unknown nested metadata and exact-as-sent JSON stay exact. Source-schema probe fails on `e1224dbc`, passes after repair. |
| C2 | Own the descriptor immediately after `os.open`, require a regular bounded file with `fstat` before `fdopen(closefd=False)`, close in `finally`. | 300 directory-replacement GETs: baseline fd count **18 → 318**; repaired test requires unchanged count. Existing symlink-swap, same-descriptor bytes and size-cap probes still pass. |
| C3 | Register exact manifest-allowlisted asset names, plus the available favicon alias; remove the GET/HEAD root catch-all. | Three existing GET paths retain HEAD 405; four POST path cases retain base statuses. Direct loading of exact `45ec2f82` confirmed `/market`, `/helm`, `/health`: HEAD/POST 405; unknown single segment: HEAD/POST 404. |
| C4 | Restore the original manifest-independent logo GET route, including its existing file/symlink checks. Document dist plus sibling-manifest layout beside `V5_FRONTEND_DIST`. New assets remain hash-verified and manifest-dependent. | No-manifest logo GET 200 with exact bytes, all five new static names/alias withheld with 404 and warning. Legacy HEAD remains 405; legacy symlinks are rejected. |
| Nits | Restore the null phone-summary `title="—"`; update the C4 plan to the final reviewed entry/hash. | Explicit `<strong title="—">—</strong>` probe fails before and passes after. Manifest and plan identify `assets/v5-Bdp43O3A.js`. |

### Simplification

There is no prose-wide numeric recognition or second title-formatting rule.
Declared source roles drive both types and record-title projection; opaque and
unknown metadata are not recursively searched. The existing visible preview
and exact disclosure remain unchanged. Exact framework routes replace a global
catch-all; standard descriptor ownership replaces nested resource acquisition.
No dependencies, state authority, services or checkbox styles changed.

### Verification: fail before repair

All test/build/Git batches used this exact admission prefix, without bypass:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-c4 --wait 5400 -- nice -n 10
```

Batches exported `TMPDIR=/var/tmp`, `NODE_OPTIONS=--max-old-space-size=1536`,
`PYTHONDONTWRITEBYTECODE=1`, `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`.
Only tests changed before the following baseline checks; production was still
the pinned `e1224dbc` head. No baseline checkout was reset or edited.

- In `condor/frontend`: `V5_TITLE_BASELINE=e1224dbc node --test --test-concurrency=1 --test-name-pattern="stock source schemas|phone row summary" test/v5-owner-title-boundaries.test.mjs` — **0 passed, 2 failed**. Repeating the settlement probe with `--test-name-pattern="stock source schemas"` explicitly failed at `funding.settFundingRate`.
- In `condor`: `PYTHONPATH=.:tests /Users/s1kor/anaconda3/bin/python3 -m pytest -q -p no:cacheprovider -p pytest_asyncio.plugin --basetemp=/var/tmp/dash-c4-owner-final.zhp9N3/pytest-red tests/test_v5_static_assets.py` — **33 passed, 7 failed**: legacy-logo GET; missing-manifest logo; repeated directory fd count; HEAD `/market`, `/helm`, `/health`; POST unknown single segment. The red-test cleanup closes only tracked directory descriptors, preserving other process resources.
- Base method parity: `git -C condor show 45ec2f82:condor/v5/app.py` was loaded with `importlib.util.spec_from_file_location("condor.v5._base_app", ...)` and exercised through TestClient; all eight HEAD/POST status expectations above matched the exact base.

### Verification: final commands and counts

Each command below ran inside the gate prefix above. Paths are relative to the
C4 worktree unless absolute. No unrequested full Python/workspace suites ran.

| Working directory | Exact command | Result |
| --- | --- | --- |
| `condor` | `node ../dashboard/v5-workspace/typecheck.mjs frontend ..` | PASS |
| `condor/frontend` | `node --test --test-concurrency=1 test/v5-*.test.mjs` | **860 passed, 0 failed** |
| `condor` | `PYTHONPATH=.:tests /Users/s1kor/anaconda3/bin/python3 -m pytest -q -p no:cacheprovider -p pytest_asyncio.plugin --basetemp=/var/tmp/dash-c4-owner-final.zhp9N3/pytest-final tests/test_v5_static_assets.py tests/test_v5_dashboard_bridge.py` | **48 passed, 0 failed** |
| `dashboard/condor-workspace` | Workspace title command below | **9 passed, 0 failed**, including an existing duplicate registration of the paper-Capital title case |
| `condor/frontend` | `node tooling/check-v5-reproducibility.mjs rebuild /var/tmp/dash-c4-owner-final.zhp9N3/repro /Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-c4` | **2 fresh builds × 26 files**, both exactly match the reviewed manifest |

Exact workspace title command:

```sh
node --test --test-concurrency=1 --test-name-pattern="Capital groups large exact|Capital normalizes|paper Capital rounds|Bots ages retained|decimal display|N1 first committed|Bots Money (endpoint|read failure)" test/v5-dashboard-polish.test.mjs test/v5-paper-capital.test.mjs test/v5-retained-query-observer.test.mjs test/v5-real-first-frame.test.mjs test/v5-real-boundaries.test.mjs
```

The seed build used `V5_WORKSPACE_ROOT=/Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-c4 node node_modules/vite/bin/vite.js build --config vite.v5.config.ts --outDir /var/tmp/dash-c4-owner-final.zhp9N3/seed-dist --emptyOutDir false`.
Manifest regeneration imported `distHashes()` and `verifyDist()` from the
canonical `tooling/check-v5-reproducibility.mjs`, derived the entry from built
`v5.html`, and applied the resulting reviewed JSON through `apply_patch`.
Both canonical rebuilds independently verified every manifest file and entry:

- Entry: `assets/v5-Bdp43O3A.js`.
- SHA256: `d4c87564e5364f2b1b2513e06f5f12e4a2844f44cb38bcce169c4b545a592d2c`.
- Mixed-import and chunk-size advisory warnings remain; no performance claim.

### Changed assertions: owner-repair old → new

| Assertion | Old | New |
| --- | --- | --- |
| Legacy logo after replacing its bytes | GET 404, HEAD 404 | GET 200 with those exact file bytes, HEAD 405, matching base behavior |
| Static GET/HEAD equivalence parameter set | All root images including legacy logo | New verified images and favicon alias only; legacy method contract is tested separately |
| Missing manifest | Warning only | Same warning plus legacy logo 200 and every new static/alias 404 |
| Legacy symlink coverage | New images only | Add the legacy logo while retaining its base symlink rejection |
| Existing amount/ID record boundary fixture | Context-free mixture of trade and book fields | Real `recent_trades[].data` and `latest.books.data` containers; all original rounding and ID assertions unchanged |
| New schema/phone/fd/method probes | No assertions at those boundaries | Explicit bounded settlement/21-field fixture; unchanged IDs and null-title literal; unchanged fd count after 300 rejects; exact base method statuses |

### Remaining

The boss owns bounded final verification of these named corrections; no third
repair or broad review is authorized. Evidence is local source/TestClient/build
evidence only, not browser, service, deployment or live-trading evidence.
Commit/push only the task branches and matching rsibot gitlink. Keep both locks
and `.workspace/condor-owner.git`. Only this turn's scratch
`/var/tmp/dash-c4-owner-final.zhp9N3` is removable; earlier scratch is not ours.
