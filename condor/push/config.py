"""Strict parsing of the private ``push`` configuration section.

The section lives in the same private (mode 0600) stack config the other Condor
services read. It names *paths* to secrets, never the secrets: the APNs key is
read from ``key_path`` at runtime and never copied, logged or echoed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Mapping
from urllib.parse import urlsplit

from condor.push.events import DEFAULT_LABELS, HealthThresholds, clean_text

ENVIRONMENTS = ("sandbox", "production")
DEFAULT_STATE_DIR = "/state/push"
REGISTRY_FILE = "registry.sqlite"
OUTBOX_FILE = "outbox.sqlite"
HEARTBEAT_FILE = "heartbeat.json"
HEARTBEAT_MAX_AGE_SECONDS = 120  # the app treats an older worker heartbeat as stale

_KEYS = frozenset(
    {
        "enabled",
        "fleet_config",
        "state_dir",
        "key_path",
        "key_id",
        "team_id",
        "bundle_id",
        "environment",
        "heartbeat_url",
        "heartbeat_interval_seconds",
        "labels",
        "quote_currencies",
        "thresholds",
        "incident_min_severity",
        "summary",
        "refresh",
        "retention_days",
        "max_age_seconds",
        "poll_seconds",
    }
)
_THRESHOLD_KEYS = frozenset(
    {"stale_seconds", "confirm_seconds", "unreadable_seconds", "recover_seconds"}
)
_SUMMARY_KEYS = frozenset({"enabled", "hour_utc", "minute"})
_REFRESH_KEYS = frozenset({"enabled", "interval_seconds"})
_BUNDLE = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*){2,}")
_APPLE_ID = re.compile(r"[A-Z0-9]{10}")


class PushConfigError(ValueError):
    """The private push configuration is invalid."""


@dataclass(frozen=True)
class SummaryConfig:
    enabled: bool = False
    hour_utc: int = 20
    minute: int = 0


@dataclass(frozen=True)
class RefreshConfig:
    """Silent data-refresh pushes to iPhones; off unless explicitly enabled."""

    enabled: bool = False
    interval_seconds: int = 900


@dataclass(frozen=True)
class PushConfig:
    enabled: bool
    fleet_config: Path
    state_dir: Path
    key_path: Path
    key_id: str
    team_id: str
    bundle_id: str
    environment: str  # sandbox | production | both
    heartbeat_url: str | None = None
    heartbeat_interval_seconds: int = 60
    labels: Mapping[str, str] = field(default_factory=lambda: dict(DEFAULT_LABELS))
    quote_currencies: Mapping[str, str] = field(default_factory=dict)
    thresholds: HealthThresholds = HealthThresholds()
    incident_min_severity: str = "critical"
    summary: SummaryConfig = SummaryConfig()
    refresh: RefreshConfig = RefreshConfig()
    retention_days: int = 14
    max_age_seconds: int = 6 * 3600
    poll_seconds: int = 10

    @property
    def registry_path(self) -> Path:
        return self.state_dir / REGISTRY_FILE

    @property
    def outbox_path(self) -> Path:
        return self.state_dir / OUTBOX_FILE

    @property
    def heartbeat_path(self) -> Path:
        return self.state_dir / HEARTBEAT_FILE

    @property
    def environments(self) -> tuple[str, ...]:
        return ENVIRONMENTS if self.environment == "both" else (self.environment,)

    def allows_bundle(self, bundle_id: str) -> bool:
        return bundle_allowed(self.bundle_id, bundle_id)

    def public(self) -> dict[str, Any]:
        """What the app may know: no paths, key ids or URLs."""
        return {
            "bundle_id": self.bundle_id,
            "environments": list(self.environments),
        }


def bundle_allowed(base: str, candidate: str) -> bool:
    """The app itself, or a Watch bundle beneath it (``<base>.watch`` and its extensions)."""
    return (
        candidate == base
        or candidate == base + ".watch"
        or candidate.startswith(base + ".watch.")
    )


def _absolute(value: Any, name: str) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value or len(value) > 512:
        raise PushConfigError(f"push.{name} must be an absolute path")
    path = PurePosixPath(value)
    if not path.is_absolute() or ".." in path.parts:
        raise PushConfigError(f"push.{name} must be an absolute path without '..'")
    return Path(value)


def _int(value: Any, name: str, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise PushConfigError(f"push.{name} must be an integer from {low} to {high}")
    return value


def _number(value: Any, name: str, low: float, high: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not low <= value <= high
    ):
        raise PushConfigError(f"push.{name} must be a number from {low} to {high}")
    return float(value)


def validate_heartbeat_url(value: Any) -> str:
    parsed = urlsplit(value if isinstance(value, str) else "")
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
        or len(value) > 512
        or any(ord(c) < 33 for c in value)
    ):
        raise PushConfigError(
            "push.heartbeat_url must be an https URL without credentials"
        )
    return value


def heartbeat_host(url: str) -> str:
    """The only part of a ping URL that may be logged: its path carries the check id."""
    return urlsplit(url).hostname or "unknown"


def parse_push_config(raw: Any) -> PushConfig:
    """Validate the ``push`` section. Unknown keys are errors, not ignored."""
    if not isinstance(raw, Mapping):
        raise PushConfigError("push must be an object")
    unknown = set(raw) - _KEYS
    if unknown:
        raise PushConfigError(
            "push has unsupported keys: " + ", ".join(sorted(map(str, unknown)))
        )
    if type(raw.get("enabled")) is not bool:
        raise PushConfigError("push.enabled must be true or false")
    missing = [
        k
        for k in (
            "fleet_config",
            "key_path",
            "key_id",
            "team_id",
            "bundle_id",
            "environment",
        )
        if k not in raw
    ]
    if missing:
        raise PushConfigError("push is missing: " + ", ".join(missing))
    key_id, team_id = raw["key_id"], raw["team_id"]
    if not isinstance(key_id, str) or not _APPLE_ID.fullmatch(key_id):
        raise PushConfigError("push.key_id must be the 10-character APNs key id")
    if not isinstance(team_id, str) or not _APPLE_ID.fullmatch(team_id):
        raise PushConfigError("push.team_id must be the 10-character Apple team id")
    bundle = raw["bundle_id"]
    if (
        not isinstance(bundle, str)
        or len(bundle) > 155
        or not _BUNDLE.fullmatch(bundle)
    ):
        raise PushConfigError("push.bundle_id must be a reverse-DNS bundle identifier")
    environment = raw["environment"]
    if environment not in (*ENVIRONMENTS, "both"):
        raise PushConfigError("push.environment must be sandbox, production or both")

    labels = dict(DEFAULT_LABELS)
    for name, value in (raw.get("labels") or {}).items():
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", name)
            or not isinstance(value, str)
            or not value.strip()
            or clean_text(value, 16) != value.strip()
        ):
            raise PushConfigError("push.labels maps bot ids to short plain labels")
        labels[name] = value.strip()
    quotes: dict[str, str] = {}
    for name, value in (raw.get("quote_currencies") or {}).items():
        if (
            not isinstance(name, str)
            or not isinstance(value, str)
            or not re.fullmatch(r"[A-Za-z0-9]{1,16}", value)
        ):
            raise PushConfigError("push.quote_currencies maps bot ids to asset labels")
        quotes[name] = value

    raw_thresholds = raw.get("thresholds") or {}
    if not isinstance(raw_thresholds, Mapping) or set(raw_thresholds) - _THRESHOLD_KEYS:
        raise PushConfigError("push.thresholds has unsupported keys")
    defaults = HealthThresholds()
    thresholds = HealthThresholds(
        **{
            name: _number(
                raw_thresholds.get(name, getattr(defaults, name)),
                f"thresholds.{name}",
                30,
                86400,
            )
            for name in _THRESHOLD_KEYS
        }
    )
    raw_summary = raw.get("summary") or {}
    if not isinstance(raw_summary, Mapping) or set(raw_summary) - _SUMMARY_KEYS:
        raise PushConfigError("push.summary has unsupported keys")
    enabled_summary = raw_summary.get("enabled", False)
    if type(enabled_summary) is not bool:
        raise PushConfigError("push.summary.enabled must be true or false")
    raw_refresh = raw.get("refresh") or {}
    if not isinstance(raw_refresh, Mapping) or set(raw_refresh) - _REFRESH_KEYS:
        raise PushConfigError("push.refresh has unsupported keys")
    enabled_refresh = raw_refresh.get("enabled", False)
    if type(enabled_refresh) is not bool:
        raise PushConfigError("push.refresh.enabled must be true or false")
    severity = raw.get("incident_min_severity", "critical")
    if severity not in ("warning", "critical"):
        raise PushConfigError("push.incident_min_severity must be warning or critical")
    url = raw.get("heartbeat_url")
    return PushConfig(
        enabled=raw["enabled"],
        fleet_config=_absolute(raw["fleet_config"], "fleet_config"),
        state_dir=_absolute(raw.get("state_dir", DEFAULT_STATE_DIR), "state_dir"),
        key_path=_absolute(raw["key_path"], "key_path"),
        key_id=key_id,
        team_id=team_id,
        bundle_id=bundle,
        environment=environment,
        heartbeat_url=None if url is None else validate_heartbeat_url(url),
        heartbeat_interval_seconds=_int(
            raw.get("heartbeat_interval_seconds", 60),
            "heartbeat_interval_seconds",
            15,
            300,
        ),
        labels=labels,
        quote_currencies=quotes,
        thresholds=thresholds,
        incident_min_severity=severity,
        summary=SummaryConfig(
            enabled_summary,
            _int(raw_summary.get("hour_utc", 20), "summary.hour_utc", 0, 23),
            _int(raw_summary.get("minute", 0), "summary.minute", 0, 59),
        ),
        refresh=RefreshConfig(
            enabled_refresh,
            # Apple budgets background pushes; faster than every 5 minutes only gets throttled.
            _int(
                raw_refresh.get("interval_seconds", 900),
                "refresh.interval_seconds",
                300,
                3600,
            ),
        ),
        retention_days=_int(raw.get("retention_days", 14), "retention_days", 1, 90),
        max_age_seconds=_int(
            raw.get("max_age_seconds", 6 * 3600), "max_age_seconds", 300, 86400
        ),
        poll_seconds=_int(raw.get("poll_seconds", 10), "poll_seconds", 5, 120),
    )
