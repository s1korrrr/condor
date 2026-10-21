# Status observation, summary history and Tradepad integrity

Source and regression review is CLEAN. This report does not establish deployed latency or
physical mobile acceptance. The source starts at `main` `a284278c2cf811ce881759f701ee7b571d8aa093`
and locally integrates open PR #64 at `2571dc0d13ea950e0507f889e6e57be4f95cc137`.
That dependency has not been merged into the default branch by this task.

## Cause and repair

A native status refresh awaited native history and then five serial runtime-wallet reads plus
wallet/paper persistence before publishing its status cache. A slow reporting observation could
therefore consume the full-summary deadline even when direct native status was available.
The old cache timestamp was also selected after that unrelated work, overstating freshness.

Native history write attempts remain awaited before cache publication. Their existing error
logging and best-effort behavior remain explicit. Cache age now begins when the native fetch
completes. Server-only wallet sampling runs in an SDS-owned task with one active batch and one
coalesced pending demand per server. An unstarted demand contains no received body. Every
completed observation retains its source timestamps and receives ordered, independent wallet,
paper-performance and paper-wallet write attempts; an error in one category is logged and does
not skip the others. Failed writes are not claimed durable and no journal or retry queue is added.

The web lifespan drains SDS when it owns the service and has no remaining subscriptions.
Main teardown always stops and drains SDS before closing API clients.
Owned task references and shielded waiters follow the Python 3.12
[task cancellation guidance](https://docs.python.org/3.12/library/asyncio-task.html#shielding-from-cancellation).
This protects orderly client lifetime; it does not guarantee persistence after a forced kill.
Native fetch/history work can still exceed the unchanged twelve-second summary deadline.

The integrated PR #64 keeps independent owner, market and account reads concurrent. It now
awaits status settlement before selecting the history clock and reading native history. This
prevents a summary from pairing new status with a history snapshot taken before its first point
or segment gap was recorded. The real SDS/history/summary regression checks that boundary while
wallet sampling is held. Empty-status fallback remains covered.

A separate full-suite failure exposed a pre-existing Tradepad digest-cache defect. Same-size
rewrites could retain the path/mtime/size key and reuse the previous digest. The deterministic
regression rewrites bytes and restores the original modification time. Verification now hashes
current bytes in 1 MiB chunks, without metadata-only digest reuse or an unbounded digest cache.
The route offloads verification to its existing threadpool. Every bundle request, including a
conditional request returning 304, now hashes up to the existing 1 GiB size limit. This trades
additional I/O for the published integrity check. It does not establish atomic response identity
if a path is replaced between verification and `FileResponse` opening it.

## Validation

Tests used Python **3.12.14** in qualified image
`sha256:6ea5faaec68a16193d9dc88721106b6e7ed40df953eb726e4bce9f5455df875b`.
Both source trees were mounted read-only and copied into disposable writable `/tmp/source`.
Containers had no network or live config/data/socket mounts, one CPU, 3 GiB memory, a read-only
root, disposable tmpfs and all capabilities dropped. The same image and test tools covered both
baseline and repaired source. Earlier direct read-only-source runs are not the matched baseline:
they failed configuration writes and collection, and are retained separately.

| Check | Result |
| --- | --- |
| SDS original behavior | Four expected RED failures before repair |
| History ordering and detached error logging | Two expected RED failures before correction |
| Independent store failures | Two RED cases, then GREEN |
| SDS and fleet-summary focused files | 58 PASS |
| Real native history / SDS / summary / held-wallet boundary | PASS, including segment gap |
| Tradepad restored-mtime mutation | RED before cache removal, GREEN after |
| Tradepad route/store file | 19 PASS |
| Baseline full directory | 3,057 PASS, 5 FAIL, 8 SKIP, 6 warnings |
| Repaired full directory | 3,077 PASS, 5 FAIL, 8 SKIP, 6 warnings |
| Failed-node comparison | Identical five failures; no new or disappeared failures |
| Ruff on touched Python files and selected formatting | PASS |
| Complete diff whitespace check | PASS |

The five failures are `tests/test_custom_provider.py` cases for environment fallback, missing
base URL/model ID, model-ID normalization and base URL/key use. Each fails because the isolated
image lacks optional `openai`. The eight skips cover unavailable source-dependent native/API
checks, Node and built frontend; the six existing warnings concern pydantic-settings, Telegram
and FastAPI. The full suite therefore exits 1. These results are not a full-suite PASS.
Existing unrelated formatting in the Tradepad test file was preserved.

The exact Docker invocations use the options above and run these commands inside `/tmp/source`:

```sh
python -m pytest -p no:cacheprovider -q tests/test_sds_status_observation.py tests/test_fleet_summary.py
python -m pytest -p no:cacheprovider -q tests/test_tradepad_routes.py
python -m pytest -p no:cacheprovider -q -ra tests
```

Private receipt `status-observation-repair/receipt.final.json` has SHA-256
`00cb114542047d00deb6de931f6adcad83b4c1fa1324054b42207bade56340d1` and binds source/log
hashes, exact commands, skipped checks and warnings. Independent source review covers the
combined production paths: SDS, Tradepad, web lifespan, fleet-summary assembly/route and main
teardown. No trading, capital, timeout/TTL, database schema, registry or credential change is made.

## Adoption and recovery

An owner-coherent image based on the previous corrected Condor image `9311546d` also replaces
four older sender modules with source already merged in PR #63:
`condor/push/apns.py`, `delivery.py`, `live_activity.py` and `refresh.py`. Those source changes
include terminal Forbidden handling, HTTP-date Retry-After parsing, the fifteen-minute 5xx
retry floor and retry deadlines measured after the response. They are present in this report's
owner baseline and full source tests, but differ from that older Condor image. Together with
SDS, Tradepad, web lifespan, summary assembly and main teardown, there are nine changed Python
runtime paths relative to `9311546d`. The image is not a status-only byte patch. Its qualification
must explicitly cover the inherited sender paths as well as the status/history boundary; a
later deployment approval must include this full declared image scope.

Prototype `sha256:a536942a3f472d8c05673a767d41332f8b8a5329c3eb40e5d07d10455f68a88f`,
bound to implementation commit `243033386484f04c4e5cb9d5bf3971201d326505`, passed offline
identity checks: all 327 runtime Python files match the owner, dependencies/runtime configuration
and all 50 integrated dashboard files are unchanged, and 77 status/history/Tradepad tests pass
using production imports from the image. Those 77 tests do not cover sender retry behavior.
The final publication-bound image and its actual-image status and sender checks are recorded
separately in the root rollout qualification; verify that packet before adoption.

No image from this repair has been adopted. Default-branch merge and guarded deployment require
separate explicit authority. The retained reporting predecessors remain the runtime rollback;
source recovery is a task-branch revert. Native bots and stored data must remain unchanged.
