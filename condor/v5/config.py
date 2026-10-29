"""Configuration for the isolated V5 dashboard process."""

from __future__ import annotations

import hmac
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from .paper import status_file_name_valid


class ConfigurationError(ValueError):
    """Raised when the V5 process is missing an isolation boundary."""


@dataclass(frozen=True)
class Settings:
    runtime_root: Path
    dashboard_token_file: Path
    dashboard_origin: str
    observation_base_url: str
    observation_read_token_file: Path
    advisor_control_base_url: str
    advisor_request_token_file: Path
    cookie_secure: bool = True
    stock_agents_root: Path | None = None
    frontend_dist: Path | None = None
    # Optional read-only native paper status file; None keeps the unbound release.
    paper_status_file: Path | None = None
    candle_store_socket: Path | None = None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        values = os.environ if env is None else env
        required = (
            "V5_RUNTIME_ROOT",
            "V5_DASHBOARD_TOKEN_FILE",
            "V5_DASHBOARD_ORIGIN",
            "V5_OBSERVATION_BASE_URL",
            "V5_OBSERVATION_TOKEN_FILE",
            "V5_ADVISOR_CONTROL_BASE_URL",
            "V5_ADVISORY_REQUEST_TOKEN_FILE",
        )
        missing = [name for name in required if not values.get(name, "").strip()]
        if missing:
            raise ConfigurationError(
                "missing required V5 setting(s): " + ", ".join(missing)
            )

        runtime_root = Path(values["V5_RUNTIME_ROOT"]).expanduser().resolve()
        source_path = Path(__file__).resolve()
        repo_roots = (source_path.parents[1], source_path.parents[2])
        forbidden_roots = {root / ".condor" for root in repo_roots}
        forbidden_roots.update(root / "agents" for root in repo_roots)
        for env_name in (
            "CONDOR_RUNTIME_ROOT",
            "CONDOR_AGENTS_ROOT",
            "CONDOR_STOCK_AGENTS_ROOT",
        ):
            configured = values.get(env_name, "").strip()
            if configured:
                forbidden_roots.add(Path(configured).expanduser().resolve())
        stock_agents_root = (
            Path(values.get("V5_STOCK_AGENTS_ROOT", str(repo_roots[1] / "agents_v5")))
            .expanduser()
            .resolve()
        )
        frontend_dist = (
            Path(
                values.get(
                    "V5_FRONTEND_DIST", str(repo_roots[1] / "frontend" / "dist-v5")
                )
            )
            .expanduser()
            .resolve()
        )
        forbidden_roots.update((stock_agents_root, frontend_dist))
        for forbidden in forbidden_roots:
            forbidden = forbidden.resolve()
            if (
                runtime_root == forbidden
                or forbidden in runtime_root.parents
                or runtime_root in forbidden.parents
            ):
                raise ConfigurationError(
                    "V5_RUNTIME_ROOT overlaps ordinary Condor runtime or agent state"
                )

        origin = values["V5_DASHBOARD_ORIGIN"].strip().rstrip("/")
        parsed_origin = urlparse(origin)
        if (
            parsed_origin.scheme not in {"http", "https"}
            or not parsed_origin.netloc
            or parsed_origin.path
            or parsed_origin.username
            or parsed_origin.password
        ):
            raise ConfigurationError(
                "V5_DASHBOARD_ORIGIN must be an origin without a path"
            )

        observation_url = _validate_base_url(
            values["V5_OBSERVATION_BASE_URL"], "V5_OBSERVATION_BASE_URL"
        )
        control_url = _validate_base_url(
            values["V5_ADVISOR_CONTROL_BASE_URL"], "V5_ADVISOR_CONTROL_BASE_URL"
        )
        dashboard_token_file = Path(values["V5_DASHBOARD_TOKEN_FILE"]).expanduser()
        observation_token_file = Path(values["V5_OBSERVATION_TOKEN_FILE"]).expanduser()
        request_token_file = Path(values["V5_ADVISORY_REQUEST_TOKEN_FILE"]).expanduser()
        dashboard_token = read_secret_file(dashboard_token_file)
        observation_token = read_secret_file(observation_token_file)
        request_token = read_secret_file(request_token_file)
        if not dashboard_token:
            raise ConfigurationError(
                "V5 dashboard token file is unavailable or invalid"
            )
        if not observation_token:
            raise ConfigurationError(
                "V5 observation token file is unavailable or invalid"
            )
        if not request_token:
            raise ConfigurationError(
                "V5 advisory request token file is unavailable or invalid"
            )
        if hmac.compare_digest(observation_token, request_token):
            raise ConfigurationError(
                "V5 observation and advisory request tokens must be different"
            )

        paper_status_file = None
        configured_paper = values.get("V5_PAPER_STATUS_FILE", "").strip()
        if configured_paper:
            paper_status_file = Path(configured_paper)
            if (
                not paper_status_file.is_absolute()
                or os.path.normpath(configured_paper) != configured_paper
                or not status_file_name_valid(paper_status_file)
            ):
                raise ConfigurationError(
                    "V5_PAPER_STATUS_FILE must be an absolute normalized <bot>_paper.status.json path"
                )

        candle_store_socket = None
        configured_socket = values.get("V5_CANDLE_STORE_SOCKET", "").strip()
        if configured_socket:
            candle_store_socket = Path(configured_socket)
            if (
                not candle_store_socket.is_absolute()
                or os.path.normpath(configured_socket) != configured_socket
                or not configured_socket.endswith(".sock")
            ):
                raise ConfigurationError(
                    "V5_CANDLE_STORE_SOCKET must be an absolute normalized .sock path"
                )

        return cls(
            runtime_root=runtime_root,
            dashboard_token_file=dashboard_token_file,
            dashboard_origin=origin,
            observation_base_url=observation_url,
            observation_read_token_file=observation_token_file,
            advisor_control_base_url=control_url,
            advisor_request_token_file=request_token_file,
            cookie_secure=values.get("V5_COOKIE_SECURE", "true").strip().lower()
            not in {"0", "false", "no"},
            stock_agents_root=stock_agents_root,
            frontend_dist=frontend_dist,
            paper_status_file=paper_status_file,
            candle_store_socket=candle_store_socket,
        )


def _validate_base_url(value: str, name: str) -> str:
    value = value.strip().rstrip("/")
    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise ConfigurationError(f"{name} must be a fixed http(s) base URL")
    return value


def read_secret_file(path: Path) -> str:
    """Read one bounded secret without following a symlink."""
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 4096:
            return ""
        with os.fdopen(descriptor, "rb", closefd=True) as source:
            descriptor = None
            raw = source.read(4097)
    except OSError:
        return ""
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if not 32 <= len(raw) <= 256 or any(byte < 0x21 or byte > 0x7E for byte in raw):
        return ""
    return raw.decode("ascii")
