# V5 dashboard C4 writer handoff

## Root cause

Install 10 applied `ownerTitle()` through `ownerDisplay().exact`, but native Bots metrics, expression titles, Trades exact overrides, chart markers/tooltips, phone row wrappers, market features and record previews bypassed it. The existing route scan deliberately excluded most hover titles and used mostly twelve-place fixtures.

The transitive private Capital page in rsibot also interpolated raw owner values in `amount()` titles. This requires the named rsibot companion branch from `209b10912f6c75554e0f97e0bc35ad6e55a6e831`, with only that display sink, title assertions and the Condor gitlink changed. Its independent fixture money values remain unchanged; the assertions now expect the shared twelve-place title contract.

The V5 backend mounted `/assets` and one fixed logo route, but not the other public files copied to the dist root. `v5.html` had no favicon link. The phone touch-target selector also enlarged native checkbox glyphs to 44px; cash and volume tiles still used four decimals beside two-decimal money tiles.

## Repair

- Every owner-number title path uses `ownerTitleText()`, a text adapter that delegates numeric rounding to existing `ownerTitle()`. Each expression operand and result is handled separately. Word/ID boundaries, Unicode minus, leading-dot decimals and exponent text are covered. Known ID/hash title paths remain unchanged.
- Owner inputs, numeric calculations, receipt ratios, marker identities, exact as-sent disclosures, read queries, admission and owner-state checks are unchanged. Visible chart fill readouts use existing coin/price formatters; their titles retain bounded owner detail and exact UTC times.
- Root images come from the sibling `frontend/v5-reviewed-build.json` files allowlist. Only top-level image names are admitted. Responses reject symlinks and changed bytes and return the same bytes that passed SHA256 verification. The existing fixed `condor_old.jpeg` compatibility route stays unchanged.
- The runtime image copies that same reviewed manifest beside its built dist. Without this packaging change, a built image would correctly fail closed but still return 404 for the new assets. The image-copy regression failed before the Dockerfile repair; no image build or deployment is claimed.
- `v5.html` links the shipped `/favicon.svg`; a browser request for `/favicon.ico` aliases that reviewed SVG with `image/svg+xml`.
- Phone checkbox/radio labels retain a 44px touch target without enlarging the native glyph. Cash, traded volume and retained wallet-equity tiles use two decimal places.

**Contract arithmetic correction:** `199123.96997705845820` has **13**, not twelve, decimal places after dropping trailing zeros. It therefore becomes `≈ 199123.969977058458 (rounded)` under the stated rule. `199123.96997705845800` genuinely has twelve places after trimming zeros and stays exact. No exception was added.

## Simplification

No new numeric rounding implementation, dependency, service, configuration flag, owner ledger, API authority or arbitrary static-directory mount. The title adapter reuses the existing string-arithmetic rule. Hash-verified root images are read once, not verified and then reopened for delivery.

## Changed assertions: old → new

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
