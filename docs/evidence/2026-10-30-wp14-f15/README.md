# F15: API read-envelope alignment

## Result

Condor follows API73's section capability list. An empty list is valid. Objects,
numbers, non-string members and blank strings are rejected. The dashboard
PROFILE capability dictionary is unchanged. No write route or authority changed.

The original defect is reproduced with API73's real HTTP-200 envelope output,
not a consumer-written envelope. The exact pin and generation method are in
`tests/fixtures/paper-api-7b12d1c2/README.md`.

## Field audit

API owner: `services/strategies/v5_advisory/paper_observation.py:216-234` and the
C1 section validator at `:660-677`, commit `7b12d1c2`.
`?` below means optional metadata in the existing consumer compatibility model;
when present, the value is validated. API output includes it. This repair does
not remove the existing requirement for completeness on every list section.

| Field | Owner type | Condor Python / TypeScript after repair |
| --- | --- | --- |
| schema | literal `rsibot.v5-paper.read.v1` | Same literal / same literal |
| section | string | Must equal the allowlisted requested section / non-empty string |
| state | available, collecting, not_applicable, degraded, stale | Same five states / same union |
| bot_id | string or null | Exact configured bot, or null for an unbound collecting/degraded read / string or null |
| execution_mode | literal paper | Same literal / same literal |
| simulated | literal true | Exact true, not a string or integer / literal true |
| snapshot_id | string or null | Non-empty string when bound; null for unbound collecting/degraded reads / string or null with same bound guard |
| generated_at_ms | integer or null | Safe non-negative integer when bound; null when unbound / number or null with safe-integer guard |
| observed_at_ms | integer or null | Nullable safe non-negative integer? / number or null? |
| read_at_ms | integer | Safe non-negative integer?, now retained in projection / number? with safe-integer guard |
| source_at_ms | integer or null | Nullable safe non-negative integer? / number or null? |
| completeness | string; C1 section enum complete, partial, collecting, unavailable | Same four values?; required for list sections / string? guarded against same four values |
| stale_reason | C1 section string or null; API maps it to envelope reason | Optional string or null extension, validated and retained / optional string or null; not a required API field |
| reason | string or null | String or null in every state / string or null |
| capabilities | list of strings, including empty list | List of non-blank strings? / string[]? with the same guard; never a dict |
| data | Any in envelope; section-specific C1 schema before publication | Same vendored section schema and bounds / unknown with section guards; null allowed for unavailable/collecting states |
| next_cursor | string or null | Optional null or non-empty opaque string / same |
| source | dictionary of string keys to Any | Dictionary?; safe provenance field projection retained / Record<string, unknown>? |

Timestamp bounds and exact identity checks remain consumer safety checks. They
do not coerce invalid values. Collecting or unavailable data cannot become a
fresh complete count. `source` stays a dictionary. No section capability is used
to enable a write. Unbound status may carry an owner-chain witness while its
identity and generated/observed timestamps are null; this form now passes both
guards without claiming availability.

## Regression evidence

- Before, focused Python: **35 failed, 80 passed**. Real API responses and empty
  capability lists were rejected. Invalid capability dictionaries and malformed
  read-time/section-reason metadata were accepted.
- Before, focused frontend: **2 failed, 52 passed**. The real API render and
  malformed-envelope guards reproduced the mismatch.
- After, full Python: **4132 passed, 8 skipped**, 18 warnings, 224.48 seconds.
- After, full frontend: **1001 passed, 1 skipped**, zero failures.
- TypeScript and rebuilt combined V5 bundle: **PASS**.

Commands from the Condor worktree:

```bash
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/tmp
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
  /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q tests \
  --basetemp="$TMPDIR/f15-final-full-<unique timestamp>" -p no:cacheprovider
node --test frontend/test/*.test.mjs
frontend/node_modules/.bin/tsc -b frontend/tsconfig.json
V5_WORKSPACE_ROOT=/home/rsi/.t3/worktrees/rsibot/t3-d0925a05 \
  frontend/node_modules/.bin/vite build --config frontend/vite.v5.config.ts --emptyOutDir false
```

Logs are retained in `/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/`:
`f15-python-red-final.log`, `f15-node-red.log`, `f15-python-final-full.log`,
`f15-node-final-full.log`, `f15-tsc-final.log`, `f15-build-final.log`.

## Browser evidence

Built entry: `/assets/v5-CnR1BLP8.js`.
SHA256: `0eed2590b0dce9911e4532e9f49c20eb3ee58a0c76a86d367356454dcaec24ce`.
HTML SHA256: `2ecf4e0143573e228b04fc122863cf57c3c26886e86aef8513cf0f46fca9bd13`.

The disposable uses the pinned API envelopes. Only fixture clocks and epoch
identities are rebased for current captures. It does not manufacture risk
availability or chart samples. The first capture exposed a rebasing error:
snapshot IDs advanced while source.sequence remained unchanged. Capital correctly
refused that fixture epoch. The fixture now rebases both consistently. That
attempt is retained under `wp14-f15-20261030` and is not selected evidence. A
second attempt reached the fixture before its restart completed; it is retained
and excluded too. No product code was changed for either fixture issue.

Selected captures, provenance and cleanup receipts are listed in
`screenshot-index.json`, `build-identity.json` and `browser-summary.json`.
The capture harness rejects schema-error and wallet-read-failure messages,
non-200 read responses, non-list capability fields, asset-byte mismatches,
document overflow and clipped main content. All eight selected PNGs were opened
and visually inspected. The selected batch recorded 57 successful HTTP-200 read
responses, each with list-shaped capabilities. No schema-error page, wallet
read-failure panel, document overflow, clipped main content or browser exception
was observed in the final batch.

The full PNGs are committed under `screenshots/` with these names:
`bots-light-1440.png`, `bots-dark-1440.png`, `bots-light-390.png`,
`bots-dark-390.png`, `capital-light-1440.png`, `capital-dark-1440.png`,
`capital-light-390.png`, `capital-dark-390.png`. The index records original and
committed paths and SHA256 values.

The exact Tailscale HTTPS URL on owned port 27443 was opened in the shared real
browser. Bots and Capital were checked there before qualification. After
capture, the owned fixture was stopped, the browser tab was closed and only
the 27443 Serve route was withdrawn. A before/after JSON comparison proved that
all pre-existing routes were preserved. No container, network, file or failed
capture was deleted. The task worktree remains for review and evidence.

This is disposable fixture qualification, not a deployment or live test. No
image is built. The existing image
`sha256:804b2cc47e27b23db3032d3989341f51bd142c05c1a4a39ff15c20d0cd5f2be4`
is reused with isolated state and a frozen frontend build. Root PR594 code and
its unrelated dirty Condor gitlink are unchanged. No frozen C1/C3 contract is
changed: this consumer is corrected to match it. Unknown/malformed sections,
wrong identities and live/arbitrary-URL routes still fail closed.
