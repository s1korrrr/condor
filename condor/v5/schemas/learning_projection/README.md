# Frozen Stage-A V5 projection contract (R2 owner repair)

This is a design appendix, not implementation, publication or live evidence.
All examples use synthetic `fixture-*` scope and source identities. D07/D12 off.
The design's C1–C5 bounded final verification consumes these exact files. No
further broad review is requested. Dates are labels; preparation is 17 Nov 2026.

## Files and validation

- `common.schema.json` and the four dataset schemas are Draft 2020-12. Resolve
  their local `urn:rsibot:v5-lfl:stage-a:r2:*` IDs from this directory; never
  download remote schemas. Every object is closed, every field/type is explicit.
- `error.schema.json` and `auth-error.schema.json` distinguish projection errors
  from the existing pre-auth Condor failure. `golden-index.json` binds each
  golden path to schema and HTTP status. Disabled B examples wrap their 404
  body and dataset; validate the inner body with the error schema.
- `query-*.schema.json` describes the once-decoded string-valued parameter map;
  detect duplicates before constructing that map. Reader validates authoritatively.
  Invalid decoded query types or values give 400, not FastAPI's default 422.
- `wire-contract.json` is normative for canonical bytes, sorting, owner cursor
  layout, path mapping, parser limits, status-code pairs, permitted headers and
  unchanged legacy baseline. `browser-contract.json` freezes the authenticated
  browser interface; success and typed errors pass through, not facade mapping.
- `golden-hashes.json` includes exact JSON preimages, canonical UTF-8 text and
  hex, byte lengths, SHA-256 digests, a cursor token and non-ASCII sort vector.
  Hash canonical preimage bytes, **not** pretty-printed fixture file bytes.
- `native-schema-selection.json` fixes exact native literals and their source
  pins, rejects aliases and preserves producer RUNNING. It is not an admission
  grant or a substitute for membership/source-receipt validation.
- `freshness-vectors.json` covers 89 s BOUND, 90 s boundary, 91 s UNAVAILABLE,
  stable 30 s scheduler verification, restart and new-publication warming.

## Required checks beyond JSON Schema

JSON Schema is structural, not a checksum/runtime validator. The runtime must
also reject duplicate JSON keys, invalid UTF-8, unpaired surrogates, noninteger
numeric tokens (including 1.0/1e0), bool-as-int and every x-maxUtf8Bytes overflow.
`C(value)` is exactly the canonical algorithm in `wire-contract.json`: sorted
ASCII object keys, compact punctuation, Unicode scalar strings with specified
escapes, unsigned safe integer tokens, no newline/BOM or normalization.
All JSON here uses only integer numbers. Native bytes use SHA-256 unchanged.

Apply these relational/byte invariants in addition to the schemas:

1. Bind expected scope ID/hash, projection_revision, source/publication identity
   and snapshot preimage. Check all row/envelope digests. There is no recursive
   self-hash: remove only the named top-level hash, retain nested hashes.
   projection_revision is the hash of the exact frozen revision preimage object,
   not Git HEAD or an inferred schema digest. Meaning changes require a new ID.
2. `items` are strictly ascending unsigned UTF-8 `record_id` bytes. No ties,
   locale sort, time ordering or normalization. Manifest always has six items,
   in lessons/records/jobs/candidates/campaigns/assessments order, even when the
   manifest envelope is UNAVAILABLE; these descriptors are capability/absence
   metadata, not research rows. Other UNAVAILABLE envelopes have no rows/cursor.
   In unavailable manifest descriptors, enabled A still has read=true but all
   availability fields are UNAVAILABLE and unknown totals null. B stays disabled.
3. Manifest read is a boolean: true for enabled A, false for disabled B, never
   an object/string or a health claim. availability/status enum is exactly
   BOUND/PARTIAL/UNAVAILABLE. STALE is not accepted. B reason is exactly
   DATASET_NOT_ENABLED; all three disabled paths return that typed 404 during A.
4. returned_items equals len(items), total counts never invent zero; when total
   is known it is ≥ returned_items. has_more iff next_cursor is nonnull. The
   manifest is unpaginated with limit=6 and no cursor. Normal page limit defaults
   to 25, maximum 50; bytes/receipt budget can shorten a page with continuation.
   A root_id names an in-scope root; nodes/edges never mix in one records page.
   Unknown totals stay null. pending_events must be 0 for BOUND/PARTIAL. A known
   source/integrity rejection is UNAVAILABLE, never merely a partial row.
5. SourceRef paths are canonical safe relative POSIX under configured roots,
   not URLs/absolute paths/traversal. Pointers are RFC 6901 (validate escapes).
   Ref.source_index points to an existing source in the same row. Combined
   refs across every field ≤4, sources ≤2, row issues ≤2, envelope issues ≤4.
   OUT_OF_SCOPE refs expose only opaque IDs, no details/fetch/expansion.
6. Whole row ≤8,192 canonical bytes, SourceRef/Ref ≤512, Issue ≤256,
   descriptor ≤1,024. Fixed/scalar/text region ≤3,072, row_scope ≤768,
   source region ≤1,024, refs ≤2,048, issues ≤512, remaining punctuation ≤512;
   total worst region sum ≤7,936. At most 16 nested objects per row and depth≤8
   (count containers below the row, excluding the row object itself). Arrays,
   display strings and aggregate budgets all apply; smaller individual maxima
   do not waive whole-object limits. Native mandatory-ID overflow uses a verified
   base-only unavailable stub; unrepresentable identity uses envelope issue and
   unknown coverage, never truncation. A stub needs sources and nonempty issues.
7. Canonical response ≤224,000 owner/proxy decoded bytes, Condor cap 256,000;
   reserve 16,000 for all nonrow fields, max 64 compact receipt objects/32,768
   bytes, guard-receipt budget 262,144, total descriptor/guard ≤294,912 bytes.
   Errors ≤2,048. Count actual bytes; reject bad/truncated Content-Length or
   transfer framing before committing headers. Accept-Encoding: identity;
   compressed upstream is rejected, not decoded without bound.
8. Epoch-ms fields are native UTC parsing, not mtime/ingestion guesses. For
   fractional native ISO times floor fractional milliseconds; missing authentic
   source -> null. started_at_ms uses started event; finished_at_ms uses finished
   event. RUNNING means completion not recorded, never process liveness. Never
   synthesize STARTED as a native status. A recorded finish requires a matching
   native terminal event/source; if its valid timestamp is missing, keep null
   and PARTIAL with COMPLETION_NOT_RECORDED rather than inventing a time.
9. generated_at≤verified_at≤served_at, verification age≤90,000 ms (90 s inclusive),
   future skew tolerance≤5,000 ms on receipt; local display expires using the
   remaining owner age/monotonic time, never a poll timestamp. Polls cannot
   advance verified_at; only the completed 30 s scheduler checks can. Failed
   verification invalidates immediately. Initial/new-generation warming is 503.
10. PARTIAL must have a real coverage/row/descriptor issue; BOUND cannot conceal
    a partial row, unresolved membership, omitted content or unknown required
    source proof. Contradiction totals not indexed remain null, not false zero.
    Descriptor native_schema_ids are the exact producer IDs, sorted UTF-8.

Scope artifact set arrays use canonical-byte ordering: family_lane_pairs by
`(family_id UTF-8, lane UTF-8)`; enabled_datasets by unsigned UTF-8 strings;
source_receipts by C(object); each set is unique. Scope's projection of pairs
retains that order. Row/receipt arrays and refs retain producer/index order;
their order is hash-significant, not re-sorted by consumers. Source receipts
bind the complete producer bytes; fields are never relabelled to satisfy a schema.

## Transport and browser boundary

Proxy :8875 maps each exact owner path to itself at reader :8873; legacy :8874
never gains these paths. Reader alone validates query meaning. Parseable proxy
failure precedence: disallowed path→404, target length→414, method→405,
body framing→413, saturation→503. For HEAD omit error body per HTTP while
retaining its canonical Content-Length/headers. Pre-accept overflow can refuse,
reset or time out; parsed full-capacity requests get typed 503/Retry-After: 1.
No schema claims a guaranteed HTTP reply before accept or for malformed HTTP.

Valid reader 400/404/409/503 errors preserve their status and JSON bytes through
proxy and Condor, including bounded normalized Retry-After on 503. Local proxy
errors are METHOD_NOT_ALLOWED/REQUEST_BODY_NOT_ALLOWED/TARGET_TOO_LONG and
ROUTE_NOT_FOUND/PROJECTION_BUSY, UPSTREAM_INVALID or UPSTREAM_UNAVAILABLE as
specified in wire-contract. Error.owner names the projection namespace, not
the response's originating hop. Browser receives no FastAPI detail wrapper for
projection errors; the existing 401 auth wrapper is deliberately distinct.

This appendix has no runtime measurement result. Hash size/time is UNMEASURED;
the method and readiness HOLD are in the design §3.5. Full-chain, saturation,
legacy regression, cold-hash-under-load and browser gates are future tests, not
proof from validating these JSON examples. The three writers consume this same
appendix and must not alter it independently.
