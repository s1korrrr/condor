# Frozen owner shapes

These 12 JSON Schemas are byte-for-byte copies from rsibot commit
`798ea9b4da65006e3010597ea55fe527a0b80ffc`, directory
`research_os/src/research_os/research_knowledge/schemas/agent-learning/v1/`.
The lesson schema declares version 2 despite the directory name.

`projection_validation.py` loads this fixed registry. `owner_record()` invokes
it before projection code can read envelope or data fields. Research, learning,
lineage and workflow projections all use that boundary. Role inputs use the
same validator adapter and typed error, with a separate fixed input shape.
No schema lookup reaches a network or another repository at runtime. Schema
files are included as package data. JSON Schema support was already a Condor
dependency; this fix adds no dependency.

The schemas enforce required keys, types, nested objects, enums and unknown-field
rejection. Existing integrity, scope, clock, binding and workflow checks remain.
They raise `ProjectionValidationError`, a `ValueError` subtype. Read routes
catch only that type. Invalid owner workflow receipts use its
`OwnerReceiptValidationError` subtype and return the research-projection 502.
Malformed workflow requests remain 422. Unexpected implementation errors are
not converted into owner-validation responses.

The schema digest regression in `tests/test_v5_learning_projection.py` pins
every file. The generic API regression mutates all present fields, removes
every present required key, and corrupts enum values. It covers all 12 owner
schemas through research, all four learning schemas through the manifest route,
and job receipts through the workflow route. Valid controls must return 200.
Malformed inputs must raise the typed error and return the typed 502.

Producer semantic validation remains authoritative. These shape checks do not
grant dispatch, trading, publication or readiness permission.
