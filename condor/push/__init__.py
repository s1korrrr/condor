"""Native push alerts (APNs) for the RSIBOT iPhone and Watch app.

Read-only by construction: this package observes the registered native bots through
the same fixed GET routes the Telegram fleet worker uses, turns what it sees into
alert events, and delivers them to registered devices. It never calls a trading,
lifecycle or control route, and no push payload carries an action that could.

Modules:
    events      pure, deterministic alert detectors and the AlertEvent contract
    config      strict parsing of the private ``push`` configuration section
    store       SQLite device registry (shared with the web routes) and outbox (worker only)
    apns        ES256 provider token, payload/header builder and HTTP/2 sender
    delivery    outbox -> APNs delivery with retries, quiet hours and token hygiene
    heartbeat   dead-man's switch: worker heartbeat plus an optional external ping
    worker      the ``condor-push`` process
"""
