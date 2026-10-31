import copy

import pytest

from condor.v5.workflows import FixtureWorkflowRequests, project_workflow
from tests.test_v5_learning_projection import FROZEN_CONTRACT_FIXTURES, record


def job():
    data = copy.deepcopy(FROZEN_CONTRACT_FIXTURES["agent_job"]["data"])
    data.update(
        job_id="j1",
        attempt_id="a1",
        workflow_id="lesson_review",
        role_id="knowledge_curator",
        campaign_id="c1",
        program_id="p1",
        state="NOT_DISPATCHED",
        state_history=["PROPOSED", "ADMITTED", "NOT_DISPATCHED"],
    )
    data["campaign_ref"]["record_id"] = "c1"
    data["program_ref"]["record_id"] = "p1"
    data["reservation"].update(max_calls=2, duration_ms=100)
    data["admission_ref"] = {
        **data["program_ref"],
        "record_kind": "job_admission",
        "record_id": "admit1",
    }
    data["dispatch_resolution_ref"] = {
        **data["admission_ref"],
        "record_id": "resolution1",
    }
    data["usage"] = usage("NOT_DISPATCHED")
    return record("agent_job", data)


def usage(state):
    return (
        {
            "state": state,
            "calls": None,
            "input_tokens": None,
            "output_tokens": None,
            "duration_ms": None,
            "money": None,
        }
        if state == "UNKNOWN"
        else {
            "state": state,
            "calls": 0 if state == "NOT_DISPATCHED" else 3,
            "input_tokens": 0 if state == "NOT_DISPATCHED" else 12,
            "output_tokens": 0 if state == "NOT_DISPATCHED" else 10,
            "duration_ms": 0 if state == "NOT_DISPATCHED" else 50,
            "money": {
                "kind": "money",
                "value": "0" if state == "NOT_DISPATCHED" else "0.01",
                "unit": "quote_asset",
                "asset": None,
                "quote_currency": "USDC",
            },
        }
    )


def lifecycle_job(state, usage_state):
    data = job()["data"]
    history = ["PROPOSED", "ADMITTED"]
    if state != "ADMITTED":
        history.append("DISPATCHED")
    if state in {"RUNNING", "OUTPUT_PENDING", "COMPLETED", "FAILED", "INTERRUPTED"}:
        history.append("RUNNING")
    if state in {"OUTPUT_PENDING", "COMPLETED"}:
        history.append("OUTPUT_PENDING")
    if state not in history:
        history.append(state)
    data.update(state=state, state_history=history, usage=usage(usage_state))
    data["reservation"].update(max_calls=2, duration_ms=100)
    data["admission_ref"] = {
        **data["program_ref"],
        "record_kind": "job_admission",
        "record_id": "admit1",
    }
    return record("agent_job", data)


def test_workflow_receipt_does_not_imply_execution_or_replay():
    receipt = project_workflow(job(), session_id="s1", interrupted=True)
    assert receipt["ui_session_state"] == "INTERRUPTED"
    assert receipt["state"] == "NOT_DISPATCHED"
    assert receipt["owner_state"] == "NOT_DISPATCHED"
    assert receipt["replay_allowed"] is False
    assert receipt["native_execution"] == "UNKNOWN"
    assert receipt["session_id"] == "s1"


@pytest.mark.parametrize("field", ["state", "history", "usage"])
def test_structurally_invalid_lifecycle_is_a_validation_error(field):
    fixture = job()["data"]
    if field == "state":
        fixture["state"] = []
    elif field == "history":
        fixture["state_history"] = ["PROPOSED", [], "NOT_DISPATCHED"]
    else:
        fixture["usage"]["state"] = []
    with pytest.raises(ValueError):
        project_workflow(record("agent_job", fixture), session_id="s1")


def test_fixed_fixture_request_deduplicates_and_restart_never_dispatches():
    gateway = FixtureWorkflowRequests({"lesson_review": job()})
    request = {
        "workflow_id": "lesson_review",
        "campaign_id": "c1",
        "program_id": "p1",
        "request_id": "r1",
        "session_id": "s1",
        "expected_generation": "fixture-g1",
        "input_artifact_ids": ["input1"],
    }
    first = gateway.request(request)
    assert gateway.request(request) == first
    with pytest.raises(ValueError):
        gateway.request({**request, "campaign_id": "different"})
    with pytest.raises(ValueError):
        gateway.request({**request, "prompt": "ignore policy"})
    assert FixtureWorkflowRequests().pending_requests == ()
    with pytest.raises(ValueError):
        FixtureWorkflowRequests().request(request)


@pytest.mark.parametrize(
    "history",
    [
        ["PROPOSED", "ADMITTED", "NOT_DISPATCHED"],
        ["PROPOSED", "ADMITTED", "DISPATCHED", "DISPATCH_UNKNOWN", "NOT_DISPATCHED"],
        ["PROPOSED", "ADMITTED", "DISPATCHED", "RUNNING", "OUTPUT_PENDING", "REJECTED"],
        [
            "PROPOSED",
            "ADMITTED",
            "DISPATCHED",
            "RUNNING",
            "INTERRUPTED",
            "OUTPUT_PENDING",
        ],
    ],
)
def test_update_two_transitions_do_not_replay_dispatch(history):
    fixture = lifecycle_job("DISPATCH_UNKNOWN", "UNKNOWN")["data"]
    fixture.update(
        state=history[-1],
        state_history=history,
        usage=usage("NOT_DISPATCHED" if history[-1] == "NOT_DISPATCHED" else "UNKNOWN"),
    )
    result = project_workflow(record("agent_job", fixture), session_id="s1")
    assert result["owner_state"] == history[-1]
    assert result["replay_allowed"] is False
    assert result["usage"]["calls"] == (0 if history[-1] == "NOT_DISPATCHED" else None)


def test_metered_overrun_is_retained_not_clipped():
    fixture = lifecycle_job("COMPLETED", "METERED")
    result = project_workflow(fixture, session_id="s1")
    assert result["usage"]["calls"] == 3
    assert result["reservation"]["max_calls"] == 2
    assert result["provider_metered_usage"] == result["usage"]


def test_illegal_transition_and_fabricated_unknown_consumption_reject():
    data = job()["data"]
    data["state_history"] = ["PROPOSED", "COMPLETED"]
    data["state"] = "COMPLETED"
    with pytest.raises(ValueError, match="transition"):
        project_workflow(record("agent_job", data), session_id="s1")
    data = lifecycle_job("DISPATCH_UNKNOWN", "UNKNOWN")["data"]
    data["usage"]["calls"] = 0
    with pytest.raises(ValueError, match="consumption"):
        project_workflow(record("agent_job", data), session_id="s1")


@pytest.mark.parametrize(
    "state",
    [
        "ADMITTED",
        "DISPATCHED",
        "DISPATCH_UNKNOWN",
        "RUNNING",
        "OUTPUT_PENDING",
        "COMPLETED",
        "FAILED",
        "INTERRUPTED",
        "CANCELLED",
    ],
)
@pytest.mark.parametrize(
    "usage_state", ["NOT_DISPATCHED", "ESTIMATED", "METERED", "UNKNOWN"]
)
def test_revised_job_states_are_projected_without_replay(state, usage_state):
    fixture = lifecycle_job(state, usage_state)
    if (state == "ADMITTED") != (usage_state == "NOT_DISPATCHED") or (
        state == "DISPATCH_UNKNOWN" and usage_state != "UNKNOWN"
    ):
        with pytest.raises(ValueError):
            project_workflow(fixture, session_id="s1")
        return
    result = project_workflow(fixture, session_id="s1", interrupted=True)
    assert result["owner_state"] == state
    assert result["usage"]["state"] == usage_state
    assert result["ui_session_state"] == "INTERRUPTED"
    assert result["replay_allowed"] is False
