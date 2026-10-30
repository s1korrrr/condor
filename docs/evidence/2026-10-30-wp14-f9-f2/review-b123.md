# PR82 B1, B2 and B3 repair — 2026-10-30

This round replaces the previous mixed-bundle after evidence. Every selected capture now proves the same built HTML, entry bundle and loaded asset bytes. The previous full PNGs remain in their original scratch evidence directories; no artifact was deleted.

## Repairs

| Review item | Repair | Regression evidence |
| --- | --- | --- |
| B1: heartbeat looked like owner-read freshness | Settings says **Heartbeat as of** and **Heartbeat reason**. The heartbeat reason uses a human sentence. Unavailable owner reads remain separate from process liveness. | The rendered fault-state test failed before the change. It now checks that freshness and as-of text occur only in explicitly labelled heartbeat rows. The browser checks the same fault state in all six variants. |
| B2: mixed bundles in after evidence | The capture harness disables browser cache and blocks service workers. For each navigation, it hashes the actual HTML response, the executed entry response and every loaded JS/CSS response. Each must match `frontend/dist-v5`; capture stops on any mismatch. The server mounts a frozen copy of that build. | The old index fails the provenance gate for 114/114 records. A retained helper test rejects old entry names, absent/wrong bundle hashes and different HTML bytes. The refreshed index records each capture's bundle proof and loaded asset hashes. |
| B3: recognised holds rejected | The six general hold classes and controls-unavailable variant match the pinned C1 schema. The producer's controls-unavailable form has no `control_hold` and is accepted only with its structured unavailable fields. Unknown holds and inconsistent control/hold combinations still fail closed. | Seven recognised hold cases, one unknown case and exact schema parity pass. The four added classes use exact vendored owner fixtures. Their labels, fallback explanations and clearing actions have frontend tests and screenshots. |
| Optional rail caption | Numeric limits are described as absent only when usable rails are absent. | Render regression covers both absent and populated rails. |

## Producer authority

Owner pin: hummingbot #220 at `1e131c74ec7b3633780b22442d0ded08954ac3cc`.

Exact vendored files under `tests/fixtures/paper-c1-1e131c74/`:

- `schema.json`;
- `stop-intent-log-damaged.json`;
- `ingress-unreadable-hold.json`;
- `clock-anomaly-hold.json`;
- `paper-controls-unavailable.json`.

The schema lists the six general hold reasons in `properties.risk.allOf[1].properties.data.anyOf[1].if/then`. Its nested `allOf` also defines `paper_controls_unavailable`. A parity test compares both clauses and that nested `allOf` with the consumer schema. Producer `scripts/meridian_v5_paper_observation.py:638-692` defines the human explanations and the controls-acquisition failure form. No new producer contract was invented.

Clearing actions stay distinct:

- Damaged stop intent log: review retained/quarantined evidence and use owner-only emergency reset.
- Unreadable ingress: restore ingress access and use owner-only ingress reset.
- Clock anomaly: review retained anomalies and use explicit owner clock maintenance.
- Controls unavailable: resolve the control-store failure before restarting. The runtime refuses ticks **and exits** in this class; the UI does not claim protective exits remain enabled.

## Single-build evidence

- Entry: `/assets/v5-CWIOvTPd.js`.
- Entry SHA256: `94fee85fa031a395fe73546cd92b7dc6d964c95a21dcc491bffa104f40c46857`.
- HTML SHA256: `180af726306a8a0d923bb9d6ece0ce9338d2e62c46f447eda2068356035be98f`.
- `build-identity.json` pins these bytes. Each `screenshot-index.json` record includes the entry/HTML hashes and actual loaded asset hashes.
- The original 38 sheets are recaptured from this build. Four additional hold states add eight sheets. Widths: 1440 and 390. Themes: light, dark and colour-blind.
- Capture code is retained as `capture-b123.cjs`; its bundle assertion is the same helper exercised by the frontend suite.
- Full PNG root: `/home/rsi/dev/rsibot/condor/.worktrees/v5-operations-export-20261029/.workspace/evidence/wp14-b123-verified-20261030/`.
- Settings fault: `settings-unavailable-light-390.png` (also dark, colourblind and 1440).
- New hold states: `bots-damaged`, `bots-ingress`, `bots-anomaly`, `bots-controls`, each with all six variants.

## Validation logs

All logs are under `/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/`.

- Before: `b123-frontend-red.log`: 5 failed, 52 passed. B1 and the four new hold labels failed.
- Before: `b123-python-red.log`: 4 failed, 4 passed. All four added producer hold classes were rejected.
- Before: `b2-old-evidence-red.log`: all 114 old records lack the required final-build provenance.
- After: `b123-frontend-focused.log`: 59 passed.
- After: `b123-python-green-final.log`: 9 passed, including pinned-schema parity.
- Full frontend: `b123-frontend-full.log`: 1000 passed, 1 skipped, 0 failed.
- Full Python: `b123-python-full.log`: 4086 passed, 8 skipped, 18 warnings in 463.97 seconds.
- TypeScript: `b123-tsc.log`: PASS.
- Combined V5 build: `b123-build.log`: PASS, normal chunk-size warnings only.

Commands remain the same as in the main report. The new capture command is:

```bash
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/tmp
EVIDENCE_ROOT=/home/rsi/dev/rsibot/condor/.worktrees/v5-operations-export-20261029/.workspace/evidence/wp14-b123-verified-20261030 \
  node /home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/qualify-b123.cjs
```

The first new capture attempt stopped at Settings because a whole-page assertion also matched an unrelated Task profiles table's `Owner reason` column. The check now targets only the Paper owner identity card. That failed attempt remains under `wp14-b123-20261030`; none of its PNGs are selected in the refreshed index. The complete rerun uses the verified directory above.

During inspection, one agent-detail colour-blind frame exposed a synthetic fixture publication race: the fixture rewrote its heartbeat file in place. The production reader correctly reported malformed input. The disposable fixture now publishes heartbeat and operations files atomically. All six agent-detail variants were recaptured into `wp14-b123-agent-final-20261030`; only these six are selected for that page. Two intervening failed recheck attempts are retained and excluded. The capture harness also waits for outstanding initial asset requests before navigation.

Final evidence gate: **PASS**, 138 selected full PNGs and 46 contact sheets. This replaces all original 38 sheets and adds eight sheets for the four new hold states. All 46 selected sheets were opened and visually inspected, including all three theme variants at both widths. Every selected PNG hash, HTML hash, entry hash and loaded JS/CSS hash was rechecked against `frontend/dist-v5`. All 525 source-file hashes in `source-identity.json` still match. No document overflow, clipped main content or browser exception was observed. Wide tables retain deliberate horizontal scrolling.

| Item | Before | Selected after sheets (relative to this folder) |
| --- | --- | --- |
| B1 | `9eb037d7`, Settings fault shows unscoped source time and raw reason | `sheets/settings-unavailable-1440.png`, `sheets/settings-unavailable-390.png` |
| B2 | Previous committed index: 114 records without final-build provenance; mixed bundles | `screenshot-index.json`: all 138 records prove one bundle; `sheets/` contains 46 inspected sheets |
| B3 | Four canonical holds rejected as schema-invalid | `sheets/bots-damaged-1440.png`, `sheets/bots-damaged-390.png`, `sheets/bots-ingress-1440.png`, `sheets/bots-ingress-390.png`, `sheets/bots-anomaly-1440.png`, `sheets/bots-anomaly-390.png`, `sheets/bots-controls-1440.png`, `sheets/bots-controls-390.png` |

Full-suite commands (from the Condor worktree):

```bash
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
  /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q tests \
  --basetemp="$TMPDIR/b123-full-<unique timestamp>" -p no:cacheprovider
node --test frontend/test/*.test.mjs
frontend/node_modules/.bin/tsc -b frontend/tsconfig.json
V5_WORKSPACE_ROOT=/home/rsi/.t3/worktrees/rsibot/t3-d0925a05 \
  frontend/node_modules/.bin/vite build --config frontend/vite.v5.config.ts --emptyOutDir false
```

The exact Tailscale HTTPS page on task-owned port 26443 was opened in the shared real browser and checked before capture. After qualification, the disposable compose project was stopped, the owned browser tab was closed and only the task's Serve route was withdrawn. Before/after JSON comparison confirms every pre-existing route is unchanged. Containers and all failed evidence remain retained. No service link remains active for this qualification.

## Scope and limits

Paper/read-only consumer work only. F2 keyed risk maps and list-shaped decisions remain unchanged. No trading, protected-service change, deletion, force-push or producer modification. Root PR594 is unchanged in this round; its unrelated dirty gitlink remains untouched. No image was built: the existing fixture image and a frozen frontend build copy are used. This is not deployment proof. The upstream F3 gate and deliberately collecting Bots chart mount remain open.
