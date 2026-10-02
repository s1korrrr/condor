"""``python -m condor.push --healthcheck | --report`` (the worker itself starts via the stack entrypoint)."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from condor.push.config import OUTBOX_FILE
from condor.push.store import delivery_report
from condor.push.worker import healthcheck


def main() -> None:
    state = os.environ.get("CONDOR_PUSH_STATE_DIR")
    if sys.argv[1:] == ["--healthcheck"]:
        raise SystemExit(0 if state and healthcheck(state) else 1)
    if sys.argv[1:] == ["--report"] and state:
        print(
            json.dumps(
                delivery_report(Path(state) / OUTBOX_FILE, now=time.time()),
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(0)
    sys.stderr.write(
        "usage: python -m condor.push --healthcheck | --report  (CONDOR_PUSH_STATE_DIR must be set)\n"
        "The worker itself starts through the stack entrypoint: entrypoint.py condor-push\n"
    )
    raise SystemExit(2)


if __name__ == "__main__":
    main()
