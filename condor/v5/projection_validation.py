"""Pinned owner shape validation before any projection reads record data."""

import json
from pathlib import Path

from jsonschema import Draft202012Validator, ValidationError

OWNER_CONTRACT_HEAD = "798ea9b4da65006e3010597ea55fe527a0b80ffc"


class ProjectionValidationError(ValueError):
    pass


class OwnerReceiptValidationError(ProjectionValidationError):
    pass


OWNER_KINDS = (
    "adoption",
    "agent_job",
    "agent_message",
    "candidate_revision",
    "event",
    "experience_ref",
    "forecast",
    "forecast_evaluation",
    "knowledge_release",
    "lesson_revision",
    "opportunity",
    "retraction",
)
OWNER_SCHEMAS = {
    kind: json.loads(
        (
            Path(__file__).parent / "schemas" / "learning" / f"{kind}.schema.json"
        ).read_text()
    )
    for kind in OWNER_KINDS
}
VALIDATORS = {
    kind: Draft202012Validator(schema) for kind, schema in OWNER_SCHEMAS.items()
}
ROLE_INPUT = Draft202012Validator(
    {
        "type": "object",
        "required": ["role_id", "capability_manifest"],
        "additionalProperties": False,
        "properties": {
            "role_id": {"type": "string", "minLength": 1, "maxLength": 128},
            "capability_manifest": {"type": "object"},
        },
    }
)


def validate_shape(validator, value):
    try:
        validator.validate(value)
    except ValidationError as error:
        raise ProjectionValidationError("invalid projection record shape") from error


def validate_owner_shape(value, kind=None):
    if not isinstance(value, dict):
        raise ProjectionValidationError("invalid owner envelope")
    name = value.get("schema_name")
    if (
        not isinstance(name, str)
        or name not in VALIDATORS
        or (kind is not None and name != kind)
    ):
        raise ProjectionValidationError("unsupported owner schema")
    validate_shape(VALIDATORS[name], value)


def validate_role_input(role_id, capability_manifest):
    validate_shape(
        ROLE_INPUT, {"role_id": role_id, "capability_manifest": capability_manifest}
    )
