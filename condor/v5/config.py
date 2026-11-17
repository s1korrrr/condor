"""Configuration for the isolated V5 dashboard process."""

from __future__ import annotations

import hmac
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse, urlsplit

from .paper import status_file_name_valid
from .learning_projection import STAGE_B_REVISION, STAGE_B_SCOPE_SHA256, ContractViolation, LearningProjectionConfig, load_scope_membership

MAX_STRATEGIES = 10000
MAX_SOURCES = 10000
MAX_NODES = 20000
MAX_EDGES = 100000
MAX_STATS_ROWS = 10000
READ_BYTE_LIMITS = {"catalog": 16 * 1024 * 1024, "campaigns": 16 * 1024 * 1024, "snapshot": 32 * 1024 * 1024, "campaign": 32 * 1024 * 1024, "bundle": 64 * 1024 * 1024, "provenance": 4 * 1024 * 1024, "asset": 64 * 1024 * 1024, "overview": 16 * 1024 * 1024, "network": 64 * 1024 * 1024}


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
    host_operations_file: Path | None = None
    # Optional read-only Helm paper runtime status file for the Helm page; None hides the page's data.
    helm_status_file: Path | None = None
    # Five-minute money samples into the runtime state; off unless V5_MONEY_SAMPLER=1 (deployments only).
    money_sampler: bool = False
    tradepad_url: str | None = None
    research_url: str | None = None
    tradepad_campaign_id: str | None = None
    # Production Research OS learning projection (V5_LEARNING_*); None leaves the routes disabled/UNAVAILABLE.
    learning_projection: LearningProjectionConfig | None = None

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

        host_operations_file = None
        configured_operations = values.get("V5_HOST_OPERATIONS_FILE", "").strip()
        if configured_operations:
            host_operations_file = Path(configured_operations)
            if (
                not host_operations_file.is_absolute()
                or os.path.normpath(configured_operations) != configured_operations
            ):
                raise ConfigurationError(
                    "V5_HOST_OPERATIONS_FILE must be an absolute normalized path"
                )

        helm_status_file = None
        configured_helm = values.get("V5_HELM_STATUS_FILE", "").strip()
        if configured_helm:
            helm_status_file = Path(configured_helm)
            if (
                not helm_status_file.is_absolute()
                or os.path.normpath(configured_helm) != configured_helm
                or not status_file_name_valid(helm_status_file)
            ):
                raise ConfigurationError(
                    "V5_HELM_STATUS_FILE must be an absolute normalized <bot>_paper.status.json path"
                )

        campaign_id = values.get("V5_TRADEPAD_CAMPAIGN_ID", "").strip()
        if campaign_id and not re.fullmatch(r"w[0-9]+-[0-9]+", campaign_id):
            raise ConfigurationError("V5_TRADEPAD_CAMPAIGN_ID must be a tested-window campaign id")
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
            host_operations_file=host_operations_file,
            helm_status_file=helm_status_file,
            money_sampler=values.get("V5_MONEY_SAMPLER", "").strip() == "1",
            tradepad_url=_validate_base_url(values["V5_TRADEPAD_URL"], "V5_TRADEPAD_URL") if values.get("V5_TRADEPAD_URL", "").strip() else None,
            research_url=_validate_base_url(values["V5_RESEARCH_URL"], "V5_RESEARCH_URL") if values.get("V5_RESEARCH_URL", "").strip() else None,
            tradepad_campaign_id=campaign_id or None,
            learning_projection=_learning_projection_config(values),
        )


LEARNING_SOURCE_NAMES = (
    "V5_LEARNING_SOURCE",
    "V5_LEARNING_OWNER_URL",
    "V5_LEARNING_SCOPE_ID",
    "V5_LEARNING_SCOPE_SHA256",
    "V5_LEARNING_PROJECTION_REVISION",
)
LEARNING_SOURCE_VALUE = "research_os_v1"


def _learning_projection_config(values) -> LearningProjectionConfig | None:
    """All five V5_LEARNING_* names or none. Partial or invalid configuration fails startup."""
    given = {name: values.get(name, "").strip() for name in LEARNING_SOURCE_NAMES}
    if not any(given.values()):
        return None
    missing = [name for name, value in given.items() if not value]
    if missing:
        raise ConfigurationError("partial V5 learning projection configuration; missing " + ", ".join(missing))
    if given["V5_LEARNING_SOURCE"] != LEARNING_SOURCE_VALUE:
        raise ConfigurationError(f"V5_LEARNING_SOURCE must be exactly {LEARNING_SOURCE_VALUE}")
    scope_id = given["V5_LEARNING_SCOPE_ID"]
    if (
        len(scope_id.encode("utf-8")) > 160
        or re.search(r"[\x00-\x1f\x7f]", scope_id)
    ):
        raise ConfigurationError("V5_LEARNING_SCOPE_ID must be a nonblank identifier of at most 160 bytes")
    for name in ("V5_LEARNING_SCOPE_SHA256", "V5_LEARNING_PROJECTION_REVISION"):
        if not re.fullmatch(r"[0-9a-f]{64}", given[name]):
            raise ConfigurationError(f"{name} must be 64 lowercase hex characters")
    owner_url = given["V5_LEARNING_OWNER_URL"]
    if urlsplit(owner_url).path not in {"", "/"} or "?" in owner_url or "#" in owner_url:
        raise ConfigurationError("V5_LEARNING_OWNER_URL must not include a path, query or fragment")
    scope_sha256 = given["V5_LEARNING_SCOPE_SHA256"]
    revision = given["V5_LEARNING_PROJECTION_REVISION"]
    if revision == STAGE_B_REVISION and scope_sha256 != STAGE_B_SCOPE_SHA256:
        raise ConfigurationError("V5_LEARNING_SCOPE_SHA256 must pin the Stage B scope artifact for the Stage B revision")
    try:
        membership = load_scope_membership(scope_id, scope_sha256)
    except ContractViolation as error:
        raise ConfigurationError(str(error)) from error
    return LearningProjectionConfig(
        owner_url=_validate_base_url(owner_url, "V5_LEARNING_OWNER_URL"),
        scope_id=scope_id,
        scope_sha256=scope_sha256,
        projection_revision=revision,
        membership=membership,
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
