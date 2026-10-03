# Push recipient reliability audit

Base: `226cc2e33db62aede15883dad0ab425f98affc83`. Repair branch:
`feat/andrzej_mobile_alert_identity`. These are isolated fixtures, not production observations.

## Contract and repairs

The authenticated registry owner supplies the user identity; callers and event text cannot
choose the notification recipient. A persistent installation UUID distinguishes different
Condor registries with colliding integer user IDs and token-derived device IDs. Each queued
row retains both identities. A row whose owner changed, or a legacy row without trustworthy
binding, is cancelled before APNs submission. Client payloads and registration responses
carry additive recipient fields; older clients can ignore them.

A delayed APNs rejection may deactivate only the registration captured before submission.
The conditional update matches its owner, token, registration time, environment, topic and
installation, including Apple's timestamp fence. Reassignment enforces the target user's
device limit and does not inherit another user's alert/quiet preferences. Upsert responses
are captured inside the write transaction to prevent another writer replacing their owner.

Five deterministic regressions fail on the base and pass on the repair. The scoped suite
passes 213 tests with no skips, including loopback HTTP/2. Black, isort and diff checks pass.
Exact commands and patch hash are in validation.txt; logs distinguish original failures and
repaired outcomes. Test execution denied outbound network except loopback. No APNs or
production credentials, records or services were used.

## Deployment and compatibility

No deployment is performed. Under separate approval, back up registry.sqlite and outbox.sqlite,
stop/restart only the intended push web/worker service, and deploy this producer before the
new strict mobile consumer. Registry initialization atomically creates `meta.recipient_server_id`;
preserve it across ordinary restarts/restores. Outbox initialization adds nullable recipient
columns transactionally. Old pending rows are deliberately cancelled, never rebound to a
new user. Observe cancellations and send a newly generated test alert after registration.

Do not run an older unbound delivery worker concurrently with the new producer/consumer.
Keep installation identity private to the owning persistent registry, do not copy one UUID
to a different server. A client must refresh registration to receive the identity. The linked
RSIBOT mobile repair rejects missing or mismatched identities; installing it before this
producer leaves remote alerts unavailable until registration is refreshed.

Rollback requires coherent producer/consumer rollback. Old code tolerates additive DB columns,
but lacks recipient protection; restoring it knowingly restores these defects. Do not erase
installation identity or replay cancelled legacy deliveries as part of rollback. Any backup
restore/replay requires a separately approved production reconciliation.

An alert already accepted by APNs can still display OS-owned text after account switching.
Client checks prevent importing it into the wrong feed; this does not promise recall of
in-flight banners. Physical APNs, registration refresh and device lifecycle remain unverified.
Execution engines and capital/order semantics are outside this read-only companion repair.

Primary API contract: [Apple APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
requires uncompressed JSON within 4096 bytes; recipient metadata is included in that budget.
