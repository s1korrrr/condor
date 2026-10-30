# API73 response fixtures

`envelopes.json` contains actual authenticated HTTP-200 JSON responses from the
API73 FastAPI application at commit
`7b12d1c210cfde14af4f75071850187bd38f3089`. These are synthetic fixture responses,
not responses copied from a running paper stack.

Generation used the pinned repository's own
`test/fixtures/paper_observation_v2/partial-buy-cancel-tp-partial-close.json`,
its immutable candle and terminal companions, and its own `PaperObservation`
reader and `create_app`. Owner trust, watermarks and the synthetic read token
were isolated under the scratch export. No production trust or state was used.

The retained `emit.py` is the exact generation script. Copy it into a scratch
folder; extract the pinned API's `services/strategies/v5_advisory` and fixture
folder into its adjacent `f15-api-source` directory. Run it with that directory
on `PYTHONPATH`, a fresh scratch output directory, and a Python environment with
the API dependencies. It reads through `TestClient` with a synthetic read token.
The status audit UUIDs and hashes can differ on regeneration, because they refer
to the new synthetic owner trust history. The envelope and data types do not.

Every section was fetched from `/v1/paper/{section}`. Candles used the
`BNB-USDC` pair. A second unbound API application supplied the collecting
positions response. No response fields were edited before vendoring.

The fixture intentionally preserves producer truth: risk is degraded because
controls are not integrated, so status is also degraded. Wallet, positions,
executors, fills and accounting are available. Candles are collecting with
`completeness: collecting` and `capabilities: []`. The unbound collecting read
has nullable identity/timestamps and an empty capability list.

The Condor tests replay all routed envelopes through its authenticated
`/api/v5/dashboard/read` boundary. The candle envelope uses the common parser
directly; this change does not add a paper-candle route. The frontend test loads
the same JSON and renders the Bots workspace. Browser qualification rebases only
clock/epoch fields to the capture time; capability lists and owner financial
values stay unchanged.
