import pytest

from condor.v5.roles import ROLE_SPECS, resolve_role


def test_twelve_fixed_roles_default_to_disabled_deny_all():
    assert len(ROLE_SPECS) == 12
    for role_id in ROLE_SPECS:
        role = resolve_role(role_id, {})
        assert role["status"] == "BLOCKED"
        assert role["tools"] == []
        assert role["model"] == "FIXTURE_ONLY"
        assert role["effect"] == "NONE"
        assert role["usage"] == "NOT_DISPATCHED"


def test_markdown_or_capability_cannot_bind_an_unimplemented_task():
    role = resolve_role(
        "portfolio_manager", {"tools": ["delegate"], "model": "paid", "enabled": True}
    )
    assert role["status"] == "BLOCKED"
    assert role["task_id"] is None
    assert role["tools"] == []
    with pytest.raises(ValueError):
        resolve_role("arbitrary", {})


@pytest.mark.parametrize(
    "role_id,capabilities",
    [([], {}), ({}, {}), (None, {}), ("market_analyst", []), ("market_analyst", None)],
)
def test_malformed_role_inputs_raise_typed_validation_error(role_id, capabilities):
    from condor.v5.projection_validation import ProjectionValidationError

    with pytest.raises(ProjectionValidationError):
        resolve_role(role_id, capabilities)
