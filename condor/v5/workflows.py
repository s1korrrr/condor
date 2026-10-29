"""Fixed, non-dispatching workflow fixture receipts. No restart replay queue."""

import copy
from decimal import Decimal, InvalidOperation

from .learning import HASH, bounded, clock, owner_record, references, text

WORKFLOWS = frozenset({"lesson_review", "release_review", "campaign_review"})
JOB_STATES = frozenset(
    {
        "PROPOSED",
        "NOT_DISPATCHED",
        "REJECTED",
        "ADMITTED",
        "DISPATCHED",
        "DISPATCH_UNKNOWN",
        "RUNNING",
        "OUTPUT_PENDING",
        "COMPLETED",
        "FAILED",
        "INTERRUPTED",
        "CANCELLED",
    }
)
USAGE_STATES = frozenset({"NOT_DISPATCHED", "ESTIMATED", "METERED", "UNKNOWN"})
JOB_TRANSITIONS = {
    "PROPOSED": {"REJECTED", "ADMITTED"},
    "NOT_DISPATCHED": set(),
    "ADMITTED": {"DISPATCHED", "NOT_DISPATCHED"},
    "DISPATCHED": {"RUNNING", "DISPATCH_UNKNOWN", "CANCELLED"},
    "DISPATCH_UNKNOWN": {"NOT_DISPATCHED", "RUNNING", "OUTPUT_PENDING", "CANCELLED"},
    "RUNNING": {"OUTPUT_PENDING", "FAILED", "INTERRUPTED", "CANCELLED"},
    "OUTPUT_PENDING": {"COMPLETED", "REJECTED"},
    "INTERRUPTED": {"OUTPUT_PENDING"},
    **{state: set() for state in ("REJECTED", "COMPLETED", "FAILED", "CANCELLED")},
}


def project_workflow(owner_receipt, *, session_id, interrupted=False):
    data = owner_record(owner_receipt, "agent_job")
    if not isinstance(data.get("state"), str) or data["state"] not in JOB_STATES:
        raise ValueError("unsupported Stage 1 owner state")
    if (
        not isinstance(data.get("allowed_action"), str)
        or data.get("allowed_action")
        not in {
            "READ_FIXTURE",
            "INFER",
            "RETRIEVE",
            "EVALUATE",
            "COMPILE",
            "VALIDATE",
            "REVIEW",
        }
        or data.get("authority_ceiling") != "repository-process-only"
    ):
        raise ValueError("non-fixture workflow rejected")
    text(data.get("model_id"), identifier=True)
    text(data.get("provider_id"), identifier=True)
    history = data.get("state_history")
    if (
        not isinstance(history, list)
        or not 1 <= len(history) <= 64
        or any(not isinstance(state, str) for state in history)
        or history[0] != "PROPOSED"
        or history[-1] != data["state"]
    ):
        raise ValueError("invalid job state history")
    if any(
        current not in JOB_TRANSITIONS.get(previous, ())
        for previous, current in zip(history, history[1:])
    ):
        raise ValueError("illegal job transition")
    usage = data.get("usage")
    consumption = {"calls", "input_tokens", "output_tokens", "duration_ms", "money"}
    if (
        not isinstance(usage, dict)
        or set(usage) != consumption | {"state"}
        or not isinstance(usage["state"], str)
        or usage["state"] not in USAGE_STATES
    ):
        raise ValueError("invalid usage object")
    measured = usage["state"] != "UNKNOWN"
    if any((usage[field] is not None) != measured for field in consumption):
        raise ValueError("usage consumption conflicts with state")
    if measured:
        for field in consumption - {"money"}:
            clock(usage[field])
        money = usage["money"]
        if not isinstance(money, dict) or money.get("kind") != "money":
            raise ValueError("explicit money units required")
        text(money.get("value"))
        text(money.get("unit"))
        text(money.get("quote_currency"), identifier=True)
        try:
            amount = Decimal(money["value"])
            if not amount.is_finite() or amount < 0:
                raise ValueError("invalid usage money")
        except InvalidOperation as error:
            raise ValueError("invalid usage money") from error
        if usage["state"] == "NOT_DISPATCHED" and (
            any(usage[field] != 0 for field in consumption - {"money"}) or amount != 0
        ):
            raise ValueError("NOT_DISPATCHED consumption must be explicit zero")
    last_not_dispatched = (
        len(history) - 1 - history[::-1].index("NOT_DISPATCHED")
        if "NOT_DISPATCHED" in history
        else -1
    )
    dispatch_history = history[last_not_dispatched + 1 :]
    dispatched = bool({"DISPATCHED", "DISPATCH_UNKNOWN"} & set(dispatch_history))
    if dispatched != (usage["state"] != "NOT_DISPATCHED") or (
        data["state"] == "DISPATCH_UNKNOWN" and usage["state"] != "UNKNOWN"
    ):
        raise ValueError("dispatch history conflicts with usage")
    if "NOT_DISPATCHED" in history:
        resolution = references([data.get("dispatch_resolution_ref")])[0]
        if resolution["record_kind"] != "job_admission":
            raise ValueError("no-dispatch resolution requires owner admission proof")
    if usage["state"] == "METERED" and not {"DISPATCHED", "RUNNING"}.intersection(
        history
    ):
        raise ValueError("metered usage requires dispatched or running history")
    reservation_state = data.get("reservation_state", "HELD")
    if reservation_state not in {"HELD", "CLOSED"} or (
        reservation_state == "CLOSED"
        and (
            data["state"]
            not in {"NOT_DISPATCHED", "REJECTED", "COMPLETED", "FAILED", "CANCELLED"}
            or usage["state"] not in {"METERED", "NOT_DISPATCHED"}
        )
    ):
        raise ValueError("reservation closure requires resolved terminal consumption")
    reservation = data.get("reservation")
    if not isinstance(reservation, dict):
        raise ValueError("invalid reservation")
    for key in ("max_calls", "retries", "fan_out", "tool_invocations"):
        clock(reservation.get(key))
    if "ADMITTED" in history:
        references([data.get("admission_ref")])
        if not reservation["max_calls"] or not clock(reservation.get("duration_ms")):
            raise ValueError("admission requires nonzero reservation")
    for key in ("input_sha256", "context_sha256", "release_sha256"):
        if not isinstance(data.get(key), str) or not HASH.fullmatch(data[key]):
            raise ValueError("invalid workflow identity digest")
    result = {
        key: text(data.get(key), identifier=True)
        for key in (
            "job_id",
            "attempt_id",
            "workflow_id",
            "role_id",
            "campaign_id",
            "program_id",
        )
    }
    result.update(
        {
            "session_id": text(session_id, identifier=True),
            "state": data["state"],
            "ui_session_state": "INTERRUPTED" if interrupted else "OBSERVED",
            "owner_state": data["state"],
            "replay_allowed": False,
            "usage": copy.deepcopy(usage),
            "reservation": copy.deepcopy(reservation),
            "reservation_state": reservation_state,
            "dispatch_resolution_ref": copy.deepcopy(
                data.get("dispatch_resolution_ref")
            ),
            "state_history": list(history),
            "provider_metered_usage": (
                copy.deepcopy(usage) if usage["state"] == "METERED" else None
            ),
            "effect": "NONE",
            "native_execution": "UNKNOWN",
            "receipt_id": owner_receipt["record_id"],
            "receipt_sha256": owner_receipt["payload_sha256"],
            "input_sha256": data["input_sha256"],
            "context_sha256": data["context_sha256"],
            "release_sha256": data["release_sha256"],
        }
    )
    return result


class FixtureWorkflowRequests:
    def __init__(self, receipts=None):
        self._receipts = copy.deepcopy(receipts or {})
        self._requests = {}

    @property
    def available(self):
        return bool(self._receipts)

    @property
    def pending_requests(self):
        return ()

    def request(self, value):
        bounded(value)
        fields = {
            "workflow_id",
            "campaign_id",
            "program_id",
            "request_id",
            "session_id",
            "expected_generation",
            "input_artifact_ids",
        }
        if not isinstance(value, dict) or set(value) != fields:
            raise ValueError("fixed workflow request fields required")
        for field in fields - {"input_artifact_ids"}:
            text(value[field], identifier=True)
        inputs = value["input_artifact_ids"]
        if not isinstance(inputs, list) or not 1 <= len(inputs) <= 64:
            raise ValueError("bounded input artifacts required")
        for artifact in inputs:
            text(artifact, identifier=True)
        workflow_id = value["workflow_id"]
        if workflow_id not in WORKFLOWS or workflow_id not in self._receipts:
            raise ValueError("workflow fixture is not bound")
        if value["expected_generation"] != "fixture-g1":
            raise ValueError("fixture generation changed")
        key = value["request_id"]
        previous = self._requests.get(key)
        if previous:
            if previous[0] != value:
                raise ValueError("request identity conflict")
            return copy.deepcopy(previous[1])
        if len(self._requests) >= 128:
            raise ValueError("fixture request capacity")
        receipt = project_workflow(
            self._receipts[workflow_id], session_id=value["session_id"]
        )
        if (
            receipt["owner_state"] not in {"PROPOSED", "NOT_DISPATCHED", "REJECTED"}
            or receipt["usage"]["state"] != "NOT_DISPATCHED"
        ):
            raise ValueError("request fixture must not imply dispatch")
        if any(
            receipt[field] != value[field]
            for field in ("workflow_id", "campaign_id", "program_id")
        ):
            raise ValueError("workflow receipt scope mismatch")
        receipt.update(
            {
                "request_id": key,
                "input_artifact_ids": list(inputs),
                "receipt_binding": "FIXTURE_PREVIEW_ONLY",
            }
        )
        self._requests[key] = (copy.deepcopy(value), copy.deepcopy(receipt))
        return receipt
