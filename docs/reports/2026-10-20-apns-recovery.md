# APNs retry recovery

## Result

APNs recovery now keeps retry timing consistent across alert delivery,
background refresh, and Live Activity sends. `Retry-After` accepts delay-seconds
and HTTP-date forms without an arbitrary one-hour ceiling. APNs 5XX responses
wait at least 15 minutes, and terminal `403 Forbidden` no longer starts a
global credential pause or retries the same alert.

## Cause and repair

Apple documents that 5XX responses may be retried after 15 minutes, that
`TooManyRequests` can be retried with a delay, and that `Forbidden` should not
be retried. The implementation previously capped `Retry-After` and let the
refresh and Live Activity pacing intervals shorten it. Alert delivery did not
apply the documented 5XX minimum, and all three senders anchored persisted
retry deadlines to the time before the network request.

The last issue had a deterministic reproduction: each test delayed a mocked
APNs response by 20 seconds, returned `Retry-After: 3600`, and attempted again
after 3599 seconds. Before the fix, alert, refresh, and Live Activity all sent
again 20 seconds early. Retry deadlines now use the later of request start and
response-handling time. This also anchors the credential pause to the response
time while keeping request expiry and payload timestamps tied to their original
cycle.

`retry_delay_seconds` applies the existing baseline, any valid `Retry-After`,
and the 900-second floor for 5XX. The parser accepts numeric delay-seconds and
HTTP-date values, treats past dates as immediately due, and ignores malformed
or non-finite input. The APNs classifier preserves recoverable authentication
handling for other 403 reasons but classifies `Forbidden` as terminal.

## Verification

The three slow-response regressions failed before the retry-anchor fix and pass
after it. The complete final local push suite passed: **478 passed, no skips or
warnings**. Ruff and `git diff --check` passed. Additional tests cover terminal Forbidden,
persistent 5XX alert retry, large numeric and HTTP-date `Retry-After`, refresh
and Live Activity pacing, and unchanged short transport-failure backoff.

The first environment lacked `h2`; the existing image also lacked pytest. The
final run used a task-private Python 3.12.10 environment with the existing test
dependencies and the running push image's exact HTTP/2 versions: `h2==4.4.1`,
`hpack==4.2.0`, `hyperframe==6.1.0`. The HTTP/2 tests executed successfully.
Shared environment packages and repository dependency files were unchanged.

The first full HTTP/2 run passed but pytest tried to clean another task's
protected temporary directories and warned. The final run used a dedicated
`--basetemp` and had no warnings. Earlier results are retained. No provider,
physical device, or deployed-runtime test was performed. Those remain separate
validation gates.

The implementation follows Apple's [APNs response guidance](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)
and the HTTP `Retry-After` syntax in [RFC 9110 section 10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after). A saved copy of Apple's
response guidance is at
`/Users/s1kor/.local/share/rsibot/releases/20261020-mobile-watch-recovery/official-docs/apns-response.md`.
