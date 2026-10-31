"""Fixture catalog projection. Native execution and economic support stay separate."""

from .learning import bounded, clock, owner_record, references, source_page, text
from .projection_validation import ProjectionValidationError


def project_lineage(records):
    rows = []
    for value in records:
        data = owner_record(value)
        refs = []
        for key, item in data.items():
            if key.endswith("_refs"):
                refs.extend(references(item))
            elif key.endswith("_ref") and item is not None:
                refs.extend(references([item]))
            elif key == "consumer_manifest" and isinstance(item, dict):
                for component, binding in item.items():
                    if not component.endswith("_ref") and (
                        not isinstance(binding, dict)
                        or set(binding) != {"refs", "absence_reason"}
                    ):
                        raise ProjectionValidationError(
                            "invalid lineage consumer binding"
                        )
                    refs.extend(
                        references(
                            [binding] if component.endswith("_ref") else binding["refs"]
                        )
                    )
            elif key == "forecast_target_bindings":
                if not isinstance(item, list):
                    raise ProjectionValidationError("invalid lineage forecast bindings")
                for binding in item:
                    if not isinstance(binding, dict) or set(binding) != {
                        "forecast_ref",
                        "target_ref",
                    }:
                        raise ProjectionValidationError(
                            "invalid lineage forecast binding"
                        )
                    refs.extend(
                        references([binding["forecast_ref"], binding["target_ref"]])
                    )
        identities = []
        for key, item in data.items():
            if key.endswith(("_id", "_sha256", "_revision")) or key in {
                "usage",
                "admission",
                "reconciliation",
                "decision_cutoff_ms",
                "decision_at_ms",
            }:
                if item is not None and type(item) in (str, int):
                    identities.append({"label": key, "value": str(item)})
        if value["schema_name"] == "agent_job":
            identities.append({"label": "usage", "value": data["usage"]["state"]})
        rows.append(
            {
                "record_id": value["record_id"],
                "kind": value["schema_name"],
                "title": text(
                    data.get("claim") or data.get("reason") or value["record_id"]
                ),
                "state": text(
                    data.get("state")
                    or data.get("disposition")
                    or data.get("lifecycle_state")
                    or data.get("admission")
                    or "UNKNOWN"
                ),
                "available_at_ms": value["available_at_ms"],
                "payload_sha256": value["payload_sha256"],
                "parent_refs": references(value["parent_refs"]),
                "evidence_refs": references(value["evidence_refs"]),
                "input_refs": refs,
                "identities": identities,
            }
        )
    return sorted(rows, key=lambda row: (row["available_at_ms"], row["record_id"]))


def project_research(payload, expected_scope, *, now_ms, cursor=0, limit=25):
    from .workflows import project_workflow

    bounded(payload, max_bytes=1048576)
    candidates = payload.get("candidates") if isinstance(payload, dict) else None
    if not isinstance(candidates, list) or len(candidates) > 200:
        raise ProjectionValidationError("candidate collection exceeds fixture bound")
    clock(cursor)
    if type(limit) is not int or not 1 <= limit <= 50 or cursor > len(candidates):
        raise ProjectionValidationError("invalid candidate page")
    metadata = {key: value for key, value in payload.items() if key != "candidates"}
    records, status = source_page(metadata, expected_scope, now_ms)
    rows = []
    identities = set()
    for candidate in candidates:
        candidate_data = owner_record(candidate, "candidate_revision")
        if candidate["available_at_ms"] > payload["generated_at_ms"]:
            raise ProjectionValidationError(
                "candidate unavailable at source generation"
            )
        candidate = candidate_data
        if candidate.get("scope") != expected_scope:
            raise ProjectionValidationError("candidate scope mismatch")
        row = {
            key: text(candidate.get(key), identifier=True)
            for key in ("candidate_id", "candidate_revision", "family_id", "variant_id")
        }
        identity = (row["candidate_id"], row["candidate_revision"])
        if identity in identities:
            raise ProjectionValidationError("duplicate candidate revision")
        identities.add(identity)
        if (
            candidate.get("implementation_status")
            not in {"UNQUALIFIED", "FIXTURE_QUALIFIED"}
            or candidate.get("economic_status")
            not in {"UNAVAILABLE", "V5_NOT_SUPPORTED"}
            or candidate.get("readiness_status") != "DISABLED"
            or candidate.get("permission_status") != "NONE"
        ):
            raise ProjectionValidationError("invalid Stage 1 candidate states")
        row.update(
            {
                "catalog_eligibility": candidate["implementation_status"],
                "research_support": candidate["economic_status"],
                "readiness": "DISABLED",
                "native_execution": "UNKNOWN",
                "trial_refs": references(candidate.get("trial_refs")),
            }
        )
        rows.append(row)
    campaigns = payload.get("campaigns", [])
    if (
        not isinstance(campaigns, list)
        or len(campaigns) > 64
        or any(not isinstance(value, dict) for value in campaigns)
    ):
        raise ProjectionValidationError("campaign bound")
    projected_campaigns = [
        {key: text(value.get(key)) for key in ("campaign_id", "state", "reason")}
        for value in campaigns
    ]
    result = {
        "schema_version": "condor-research-projection.v1",
        "status": status,
        "source_generation": payload["source_generation"],
        "generated_at_ms": payload["generated_at_ms"],
        "effect": "NONE",
        "total_candidates": len(rows),
        "total_families": len({row["family_id"] for row in rows}),
        "total_variants": len({(row["family_id"], row["variant_id"]) for row in rows}),
        "candidates": rows[cursor : cursor + limit],
        "campaigns": projected_campaigns,
        "next_cursor": cursor + limit if cursor + limit < len(rows) else None,
        "lineage": project_lineage(records),
        "jobs": [
            project_workflow(value, session_id="fixture-observation")
            for value in records
            if value["schema_name"] == "agent_job"
        ],
        "native_execution": "UNKNOWN",
        "inventory_owner": "UNKNOWN",
        "inventory_policy": "UNKNOWN",
        "open_bags": None,
        "capital_occupancy": None,
        "risk_restrictions": "UNKNOWN",
        "rollback_target": "UNKNOWN",
        "forecast_quality": "UNKNOWN",
    }
    bounded(result)
    return result
