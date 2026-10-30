"""Bounded, fail-closed reader of the native V5 paper runtime status file.

Source contract: hummingbot ``scripts/component_paper_runtime.py``
``PaperRuntime.status()`` (``schema_version`` 1, ``paper_runtime_schema``
``native_component_paper_runtime_v1``), written atomically as
``<bot>.status.json`` every runtime step. The V5 dashboard reads one fixed,
read-only mounted path through a pinned directory chain. It never writes,
never follows a symlink (in the file or any parent directory), and never
fabricates a value: a missing, oversized or malformed file is UNAVAILABLE with
a reason code, and an old one is STALE.
"""

from __future__ import annotations

import json
import math
import os
import re
import stat
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import HTTPException

# The shared Bots/fleet views classify a bot as paper by its ``_paper`` name suffix, so
# only a paper-suffixed identity may bind; any other name would render as live.
STATUS_NAME = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_-]{0,57}_paper)\.status\.json$")
CONTROLLER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
PAIR = re.compile(r"^[A-Z0-9]+-[A-Z0-9]+$")
HEX32 = re.compile(r"^[a-f0-9]{32}$")
HEX64 = re.compile(r"^[a-f0-9]{64}$")
MAX_STATUS_BYTES = 2 * 1024 * 1024
MAX_CONTROLLERS = 64
STALE_AFTER_SECONDS = 30  # the runtime rewrites status about twice a second
FUTURE_SKEW_SECONDS = 5

C1_DATA_SCHEMA = json.loads(r"""
{
  "$defs": {
    "decimal": {
      "type": "string",
      "pattern": "^-?[0-9]+(\\.[0-9]+)?$"
    },
    "accountingTotals": {
      "type": "object",
      "required": [
        "fees_paid_quote",
        "realized_pnl_quote",
        "unrealized_pnl_quote",
        "volume_traded_quote",
        "accounting_since_ms",
        "accounting_since_reason",
        "fees_paid",
        "fee_quote_valuation_basis",
        "count_basis",
        "unavailable_reasons",
        "entry_count",
        "exit_count"
      ],
      "properties": {
        "fees_paid_quote": {
          "anyOf": [
            {
              "$ref": "#/$defs/decimal"
            },
            {
              "type": "null"
            }
          ]
        },
        "realized_pnl_quote": {
          "anyOf": [
            {
              "$ref": "#/$defs/decimal"
            },
            {
              "type": "null"
            }
          ]
        },
        "unrealized_pnl_quote": {
          "anyOf": [
            {
              "$ref": "#/$defs/decimal"
            },
            {
              "type": "null"
            }
          ]
        },
        "volume_traded_quote": {
          "anyOf": [
            {
              "$ref": "#/$defs/decimal"
            },
            {
              "type": "null"
            }
          ]
        },
        "accounting_since_ms": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0
        },
        "accounting_since_reason": {
          "type": [
            "string",
            "null"
          ]
        },
        "fees_paid": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": {
            "$ref": "#/$defs/decimal"
          }
        },
        "fee_quote_valuation_basis": {
          "type": "string"
        },
        "count_basis": {
          "type": "string"
        },
        "unavailable_reasons": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        },
        "entry_count": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0
        },
        "exit_count": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0
        }
      }
    },
    "protectedExitProjection": {
      "type": "object",
      "required": [
        "target_price",
        "target_basis",
        "target_reason",
        "protected_exit_order",
        "remaining_target_amount"
      ],
      "properties": {
        "target_price": {
          "anyOf": [
            {
              "$ref": "#/$defs/decimal"
            },
            {
              "type": "null"
            }
          ]
        },
        "target_basis": {
          "type": [
            "string",
            "null"
          ]
        },
        "target_reason": {
          "type": [
            "string",
            "null"
          ]
        },
        "protected_exit_order": {
          "anyOf": [
            {
              "type": "object",
              "required": [
                "order_id",
                "state",
                "price",
                "remaining_amount",
                "placed_at_ms"
              ],
              "properties": {
                "order_id": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "state": {
                  "enum": [
                    "pending",
                    "open",
                    "partially_filled",
                    "filled",
                    "cancelled"
                  ]
                },
                "price": {
                  "$ref": "#/$defs/decimal"
                },
                "remaining_amount": {
                  "$ref": "#/$defs/decimal"
                },
                "placed_at_ms": {
                  "type": [
                    "integer",
                    "null"
                  ],
                  "minimum": 0
                }
              },
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "remaining_target_amount": {
          "anyOf": [
            {
              "$ref": "#/$defs/decimal"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "target_price": {
                "type": "null"
              }
            }
          },
          "then": {
            "properties": {
              "target_basis": {
                "type": "null"
              },
              "target_reason": {
                "type": "string",
                "minLength": 1
              },
              "remaining_target_amount": {
                "type": "null"
              },
              "protected_exit_order": {
                "type": "null"
              }
            }
          },
          "else": {
            "properties": {
              "target_basis": {
                "type": "string",
                "minLength": 1
              },
              "remaining_target_amount": {
                "$ref": "#/$defs/decimal"
              },
              "protected_exit_order": {
                "type": "object",
                "required": [
                  "order_id",
                  "state",
                  "price",
                  "remaining_amount",
                  "placed_at_ms"
                ],
                "properties": {
                  "order_id": {
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "state": {
                    "enum": [
                      "pending",
                      "open",
                      "partially_filled",
                      "filled",
                      "cancelled"
                    ]
                  },
                  "price": {
                    "$ref": "#/$defs/decimal"
                  },
                  "remaining_amount": {
                    "$ref": "#/$defs/decimal"
                  },
                  "placed_at_ms": {
                    "type": [
                      "integer",
                      "null"
                    ],
                    "minimum": 0
                  }
                },
                "additionalProperties": false
              }
            }
          }
        }
      ]
    }
  },
  "properties": {
    "wallet": {
      "type": "object",
      "required": [
        "quote_asset",
        "unit",
        "assets",
        "initial_funding_quote",
        "external_cash_flows_quote",
        "equity_quote",
        "valuation_policy"
      ],
      "properties": {
        "quote_asset": {
          "const": "USDC"
        },
        "unit": {
          "const": "USDC"
        },
        "assets": {
          "type": "array",
          "maxItems": 6,
          "items": {
            "type": "object",
            "required": [
              "asset",
              "total",
              "available",
              "reserved",
              "mark_quote",
              "marked_value_quote",
              "mark_at_ms"
            ],
            "properties": {
              "asset": {
                "type": "string"
              },
              "total": {
                "$ref": "#/$defs/decimal"
              },
              "available": {
                "$ref": "#/$defs/decimal"
              },
              "reserved": {
                "$ref": "#/$defs/decimal"
              },
              "mark_quote": {
                "anyOf": [
                  {
                    "$ref": "#/$defs/decimal"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "marked_value_quote": {
                "anyOf": [
                  {
                    "$ref": "#/$defs/decimal"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "mark_at_ms": {
                "type": [
                  "integer",
                  "null"
                ]
              }
            }
          }
        },
        "initial_funding_quote": {
          "$ref": "#/$defs/decimal"
        },
        "external_cash_flows_quote": {
          "$ref": "#/$defs/decimal"
        },
        "equity_quote": {
          "anyOf": [
            {
              "$ref": "#/$defs/decimal"
            },
            {
              "type": "null"
            }
          ]
        },
        "valuation_policy": {
          "type": "string"
        }
      }
    },
    "positions": {
      "type": "array",
      "maxItems": 640,
      "items": {
        "type": "object",
        "required": [
          "position_id",
          "controller_id",
          "trading_pair",
          "quantity",
          "remaining_basis_quote",
          "state"
        ],
        "properties": {
          "quantity": {
            "$ref": "#/$defs/decimal"
          },
          "remaining_basis_quote": {
            "anyOf": [
              {
                "$ref": "#/$defs/decimal"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "allOf": [
          {
            "$ref": "#/$defs/protectedExitProjection"
          }
        ]
      }
    },
    "fills": {
      "type": "array",
      "maxItems": 500,
      "items": {
        "type": "object",
        "required": [
          "trade_id",
          "order_id",
          "executor_id",
          "controller_id",
          "trading_pair",
          "side",
          "quantity",
          "price",
          "event_at_ms",
          "observed_at_ms"
        ],
        "properties": {
          "trade_id": {
            "type": "string"
          },
          "order_id": {
            "type": "string"
          },
          "trading_pair": {
            "type": "string"
          },
          "executor_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "controller_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "side": {
            "enum": [
              "BUY",
              "SELL"
            ]
          },
          "quantity": {
            "$ref": "#/$defs/decimal"
          },
          "price": {
            "$ref": "#/$defs/decimal"
          },
          "fee_amount": {
            "anyOf": [
              {
                "$ref": "#/$defs/decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "fee_currency": {
            "type": [
              "string",
              "null"
            ]
          },
          "event_at_ms": {
            "type": "integer"
          },
          "observed_at_ms": {
            "type": "integer"
          }
        }
      }
    },
    "accounting": {
      "anyOf": [
        {
          "type": "null"
        },
        {
          "type": "object",
          "required": [
            "controllers",
            "program",
            "source"
          ],
          "properties": {
            "controllers": {
              "type": "object",
              "maxProperties": 5,
              "additionalProperties": {
                "$ref": "#/$defs/accountingTotals"
              }
            },
            "program": {
              "$ref": "#/$defs/accountingTotals"
            },
            "source": {
              "type": "string"
            }
          }
        }
      ]
    },
    "risk": {
      "allOf": [
        {
          "properties": {
            "controllers": {
              "type": "object",
              "maxProperties": 5,
              "propertyNames": {
                "minLength": 1,
                "maxLength": 128
              },
              "additionalProperties": {
                "type": "object",
                "required": [
                  "operator",
                  "native"
                ],
                "properties": {
                  "operator": {
                    "type": "object"
                  },
                  "native": {
                    "type": "object"
                  }
                }
              }
            },
            "native_entry_holds": {
              "type": "array",
              "maxItems": 20,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "controller_id",
                  "reason",
                  "explanation",
                  "protected_exits"
                ],
                "properties": {
                  "controller_id": {
                    "type": "string",
                    "minLength": 1
                  },
                  "reason": {
                    "enum": [
                      "native_refusal_receipt_pending",
                      "native_refusal_owner_ambiguous",
                      "native_refusal_recovery_unavailable",
                      "v5_risk_incomplete"
                    ]
                  },
                  "explanation": {
                    "type": "string",
                    "minLength": 1
                  },
                  "protected_exits": {
                    "const": "preserved"
                  }
                }
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "reason": {
                "const": "paper_controls_unavailable"
              }
            },
            "required": [
              "reason"
            ]
          },
          "then": {
            "required": [
              "explanation",
              "holds",
              "native",
              "unavailable_reason"
            ],
            "properties": {
              "explanation": {
                "type": "string",
                "minLength": 1
              },
              "native": {
                "type": "null"
              },
              "unavailable_reason": {
                "const": "paper_controls_not_acquired"
              },
              "holds": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "type": "object",
                  "required": [
                    "reason",
                    "explanation"
                  ],
                  "properties": {
                    "reason": {
                      "const": "paper_controls_unavailable"
                    },
                    "explanation": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                }
              }
            }
          }
        }
      ],
      "anyOf": [
        {
          "type": "null"
        },
        {
          "type": "object",
          "if": {
            "properties": {
              "control_hold": {
                "enum": [
                  "clock_persistence_failed",
                  "stop_persistence_failed",
                  "stop_intent_log_damaged",
                  "ingress_unreadable",
                  "clock_anomaly",
                  "clock_invalid"
                ]
              }
            },
            "required": [
              "control_hold"
            ]
          },
          "then": {
            "required": [
              "reason",
              "explanation",
              "clock_recovery",
              "holds"
            ],
            "properties": {
              "reason": {
                "enum": [
                  "clock_persistence_failed",
                  "stop_persistence_failed",
                  "stop_intent_log_damaged",
                  "ingress_unreadable",
                  "clock_anomaly",
                  "clock_invalid"
                ]
              },
              "explanation": {
                "type": "string",
                "minLength": 1
              },
              "holds": {
                "type": "array",
                "minItems": 1,
                "maxItems": 6,
                "items": {
                  "type": "object",
                  "required": [
                    "reason",
                    "explanation"
                  ],
                  "properties": {
                    "reason": {
                      "enum": [
                        "clock_persistence_failed",
                        "stop_persistence_failed",
                        "stop_intent_log_damaged",
                        "ingress_unreadable",
                        "clock_anomaly",
                        "clock_invalid"
                      ]
                    },
                    "explanation": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                }
              }
            }
          }
        }
      ]
    },
    "executors": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/protectedExitProjection"
      }
    }
  }
}
""")


def _paper_hold_signals(data: Any) -> list[dict[str, str]]:
    if not isinstance(data, dict):
        return []
    signals = []
    holds = data.get("holds")
    if isinstance(holds, list):
        signals.extend(row.get("reason") for row in holds[:16] if isinstance(row, dict))
    if data.get("control_hold") is not None:
        signals.append(data["control_hold"])
    reasons = []
    for signal in signals:
        reason = (
            signal[:128]
            if isinstance(signal, str) and signal.strip()
            else "invalid owner hold"
        )
        if reason not in reasons:
            reasons.append(reason)
    return [{"reason": reason} for reason in reasons]


def _paper_schema_error(section: str, payload: Any) -> HTTPException:
    detail = {
        "code": "paper_read_schema_invalid",
        "reason": "schema_invalid",
        "section": section,
    }
    holds = (
        _paper_hold_signals(payload.get("data"))
        if section == "risk" and isinstance(payload, dict)
        else []
    )
    if holds:
        detail["holds"] = holds
    return HTTPException(502, detail=detail)


def validate_paper_read(
    payload: dict, *, section: str, bot: str | None, now_ms: int
) -> dict:
    states = {"available", "collecting", "not_applicable", "degraded", "stale"}
    unbound = (
        isinstance(payload, dict)
        and payload.get("state") in ("collecting", "degraded")
        and payload.get("snapshot_id") is None
    )
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != "rsibot.v5-paper.read.v1"
        or payload.get("section") != section
        or (
            payload.get("bot_id") != bot
            and not (unbound and payload.get("bot_id") is None)
        )
        or payload.get("execution_mode") != "paper"
        or payload.get("simulated") is not True
        or not isinstance(payload.get("state"), str)
        or payload.get("state") not in states
        or (
            not unbound
            and (
                not isinstance(payload.get("snapshot_id"), str)
                or not payload["snapshot_id"]
            )
        )
        or (
            not unbound
            and (
                type(payload.get("generated_at_ms")) is not int
                or payload["generated_at_ms"] < 0
                or payload["generated_at_ms"] > now_ms + FUTURE_SKEW_SECONDS * 1000
            )
        )
        or (
            payload.get("reason") is not None
            and not isinstance(payload["reason"], str)
        )
        or (
            payload.get("stale_reason") is not None
            and not isinstance(payload["stale_reason"], str)
        )
        or any(
            key in payload
            and not (unbound and key == "generated_at_ms" and payload[key] is None)
            and not (key in {"source_at_ms", "observed_at_ms"} and payload[key] is None)
            and (
                type(payload[key]) is not int
                or not 0
                <= payload[key]
                <= min(2**53 - 1, now_ms + FUTURE_SKEW_SECONDS * 1000)
            )
            for key in ("generated_at_ms", "source_at_ms", "observed_at_ms", "read_at_ms")
        )
        or (
            section in {"positions", "fills", "executors", "orders"}
            and "completeness" not in payload
        )
        or (
            "completeness" in payload
            and payload["completeness"] not in ("complete", "partial", "collecting", "unavailable")
        )
        or (
            "next_cursor" in payload
            and payload["next_cursor"] is not None
            and (
                not isinstance(payload["next_cursor"], str)
                or not payload["next_cursor"]
            )
        )
        or ("source" in payload and not isinstance(payload["source"], dict))
        or (
            "capabilities" in payload
            and (
                not isinstance(payload["capabilities"], list)
                or any(
                    not isinstance(capability, str)
                    for capability in payload["capabilities"]
                )
            )
        )
        or (payload["state"] == "available" and payload.get("data") is None)
    ):
        raise _paper_schema_error(section, payload)
    try:
        encoded = json.dumps(payload, allow_nan=False)
        _validate_read_tree(payload.get("data"))
        _validate_section_data(section, payload.get("data"))
        if section == "accounting" and payload.get("data") is not None:
            data = payload["data"]
            if not isinstance(data, dict) or not isinstance(data.get("program"), dict):
                raise ValueError("invalid lifetime accounting")
            controllers = data.get("controllers", {})
            if not isinstance(controllers, dict) or len(controllers) > MAX_CONTROLLERS:
                raise ValueError("invalid lifetime controllers")
            for total in [data["program"], *controllers.values()]:
                if not isinstance(total, dict):
                    raise ValueError("invalid lifetime totals")
                for key in ("entry_count", "exit_count"):
                    value = total.get(key)
                    if value is not None and (type(value) is not int or value < 0):
                        raise ValueError("invalid lifetime count")
                since = total.get("accounting_since_ms")
                if since is not None and (
                    type(since) is not int or not 0 <= since <= now_ms + 5000
                ):
                    raise ValueError("invalid accounting clock")
                for key in (
                    "fees_paid_quote",
                    "realized_pnl_quote",
                    "unrealized_pnl_quote",
                    "volume_traded_quote",
                ):
                    value = total.get(key)
                    if value is not None and (
                        not isinstance(value, str)
                        or len(value) > 128
                        or re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value)
                        is None
                    ):
                        raise ValueError("invalid lifetime amount")
    except (TypeError, ValueError):
        raise _paper_schema_error(section, payload) from None
    if len(encoded.encode()) > MAX_STATUS_BYTES:
        raise HTTPException(502, detail={"code": "paper_read_capacity"})
    result = deepcopy(payload)
    if (
        result.get("completeness") in {"partial", "collecting", "unavailable"}
        and result["state"] == "available"
    ):
        result.update(
            state="degraded", reason="Paper section completeness is not complete."
        )
    if not unbound and now_ms - payload["generated_at_ms"] > STALE_AFTER_SECONDS * 1000:
        result.update(
            state="stale", reason="Paper observation source is older than 30 seconds."
        )
    fields = {
        "schema",
        "section",
        "state",
        "reason",
        "stale_reason",
        "bot_id",
        "execution_mode",
        "simulated",
        "snapshot_id",
        "generated_at_ms",
        "observed_at_ms",
        "read_at_ms",
        "source_at_ms",
        "completeness",
        "capabilities",
        "data",
        "next_cursor",
        "source",
    }
    result = {name: value for name, value in result.items() if name in fields}
    if isinstance(result.get("source"), dict):
        result["source"] = {
            name: value
            for name, value in result["source"].items()
            if name
            in {
                "owner",
                "schema",
                "sha256",
                "boot_id",
                "sequence",
                "source_sha256",
                "config_sha256",
                "recipe_sha256",
            }
        }
    return result


def _validate_section_data(section: str, data: Any) -> None:
    """Validate C1 data and the 1e131c74 risk-map extension, then C3 containers.

    C1 leaves decisions, history and operations record identities unconstrained;
    the read adapter must additionally enforce the record shapes it projects.
    Null is reserved for the envelope's explicit unavailable/degraded states.
    """
    if data is None:
        return
    if section == "risk" and isinstance(data, dict):
        known = {
            "clock_persistence_failed", "stop_persistence_failed", "clock_invalid",
            "stop_intent_log_damaged", "ingress_unreadable", "clock_anomaly",
            "paper_controls_unavailable",
        }
        holds = data.get("holds", [])
        if not isinstance(holds, list) or len(holds) > 6:
            raise ValueError("invalid owner holds")
        reasons = []
        for hold in holds:
            if (
                not isinstance(hold, dict)
                or not isinstance(hold.get("reason"), str)
                or hold["reason"] not in known
                or not isinstance(hold.get("explanation"), str)
                or not hold["explanation"].strip()
            ):
                raise ValueError("invalid owner hold entry")
            reasons.append(hold["reason"])
        control = data.get("control_hold")
        controls_unavailable = (
            reasons == ["paper_controls_unavailable"]
            and data.get("reason") == "paper_controls_unavailable"
            and isinstance(data.get("explanation"), str)
            and bool(data["explanation"].strip())
            and data.get("native", "missing") is None
            and data.get("unavailable_reason") == "paper_controls_not_acquired"
        )
        if (
            control is not None
            and (
                not isinstance(control, str)
                or control not in known
                or control not in reasons
            )
            or reasons
            and control is None
            and not controls_unavailable
            or len(set(reasons)) != len(reasons)
        ):
            raise ValueError("inconsistent owner holds")
    schema = C1_DATA_SCHEMA["properties"].get(section)
    if schema is not None:
        if not _matches_c1_schema(data, schema):
            raise ValueError("invalid C1 section data")
    list_sections = {"positions", "fills", "executors", "orders"}
    if section in list_sections:
        if not isinstance(data, list) or any(not isinstance(row, dict) for row in data):
            raise ValueError("invalid section records")
        identifiers = {
            "positions": ("position_id", "controller_id", "trading_pair", "state"),
            "fills": ("trade_id", "order_id", "trading_pair", "side"),
            "executors": ("executor_id", "controller_id", "state"),
            "orders": ("order_id", "executor_id", "side"),
        }
        for row in data:
            for key in (
                "quantity",
                "remaining_close_quantity",
                "remaining_basis_quote",
                "cum_fees_quote",
                "realized_pnl_quote",
                "unrealized_pnl_quote",
                "target_price",
                "limit_price",
            ):
                if row.get(key) is not None and not _matches_c1_schema(
                    row[key], C1_DATA_SCHEMA["$defs"]["decimal"]
                ):
                    raise ValueError("invalid record amount")
            if any(
                not isinstance(row.get(key), str) or not row[key]
                for key in identifiers[section]
            ):
                raise ValueError("invalid section record identity")
            for key in ("executor_id", "trading_pair"):
                if (
                    key in row
                    and row[key] is not None
                    and not isinstance(row[key], str)
                ):
                    raise ValueError("invalid record identity")
            for key in ("protected_exit", "terminal"):
                if key in row and type(row[key]) is not bool:
                    raise ValueError("invalid record flag")
    elif not isinstance(data, dict):
        raise ValueError("invalid section object")
    if isinstance(data, dict):
        for key in (
            "assets",
            "controllers",
            "conditions",
            "rails",
            "latches",
            "segments",
            "gaps",
        ):
            if key in data:
                if section in {"accounting", "risk"} and key == "controllers":
                    continue
                if not isinstance(data[key], list) or any(
                    not isinstance(row, dict) for row in data[key]
                ):
                    raise ValueError("invalid nested section records")
        if section == "decisions":
            for row in data.get("controllers", []):
                if not isinstance(row.get("id"), str) or not isinstance(
                    row.get("custom_info", {}), dict
                ):
                    raise ValueError("invalid decision controller")


def _matches_c1_schema(value: Any, schema: dict) -> bool:
    """Evaluate the bounded keywords used by the frozen C1 data schemas."""
    if isinstance(schema, bool):
        return schema
    if "$ref" in schema:
        return _matches_c1_schema(
            value, C1_DATA_SCHEMA["$defs"][schema["$ref"].rsplit("/", 1)[1]]
        )
    if "anyOf" in schema and not any(
        _matches_c1_schema(value, option) for option in schema["anyOf"]
    ):
        return False
    if "allOf" in schema and not all(
        _matches_c1_schema(value, option) for option in schema["allOf"]
    ):
        return False
    if "if" in schema:
        branch = "then" if _matches_c1_schema(value, schema["if"]) else "else"
        if not _matches_c1_schema(value, schema.get(branch, {})):
            return False
    types = {
        "object": dict,
        "array": list,
        "string": str,
        "integer": int,
        "null": type(None),
    }
    expected = schema.get("type")
    if expected is not None and type(value) not in [
        types[name] for name in (expected if isinstance(expected, list) else [expected])
    ]:
        return False
    if "const" in schema and value != schema["const"]:
        return False
    if "enum" in schema and value not in schema["enum"]:
        return False
    if isinstance(value, dict):
        if any(key not in value for key in schema.get("required", [])) or len(
            value
        ) > schema.get("maxProperties", MAX_STATUS_BYTES):
            return False
        properties = schema.get("properties", {})
        for key, child in value.items():
            if "propertyNames" in schema and not _matches_c1_schema(
                key, schema["propertyNames"]
            ):
                return False
            child_schema = properties.get(key, schema.get("additionalProperties", {}))
            if not _matches_c1_schema(child, child_schema):
                return False
    elif isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get(
            "maxItems", 2000
        ):
            return False
        if "items" in schema and not all(
            _matches_c1_schema(child, schema["items"]) for child in value
        ):
            return False
    elif isinstance(value, str):
        if (
            len(value) > schema.get("maxLength", MAX_STATUS_BYTES)
            or len(value) < schema.get("minLength", 0)
            or ("pattern" in schema and re.search(schema["pattern"], value) is None)
        ):
            return False
    elif type(value) is int and "minimum" in schema and value < schema["minimum"]:
        return False
    return True


def _validate_read_tree(value: Any, key: str = "", depth: int = 0) -> None:
    if depth > 16 or isinstance(value, float):
        raise ValueError("invalid paper observation value")
    if value is None:
        return
    if key.endswith("_ms"):
        if type(value) is not int or not 0 <= value <= 10**14:
            raise ValueError("invalid paper timestamp")
        return
    if isinstance(value, str) and value.lower() in {
        "nan",
        "inf",
        "infinity",
        "-inf",
        "-infinity",
    }:
        raise ValueError("invalid paper value")
    if isinstance(value, dict):
        for name, child in value.items():
            _validate_read_tree(child, name, depth + 1)
    elif isinstance(value, list):
        if len(value) > 2000:
            raise ValueError("paper row capacity")
        for child in value:
            _validate_read_tree(child, "", depth + 1)
    elif (
        key not in {"fee_quote_valuation_basis", "count_basis", "target_basis"}
        and not key.endswith(
            (
                "_currency",
                "_asset",
                "_unit",
                "_source",
                "_policy",
                "_reason",
                "_state",
                "_id",
                "_count",
            )
        )
        and re.search(
            r"(?:^|_)(?:price|quantity|amount|balance|total|available|reserved|basis|fee|fees|pnl|exposure|funding|mark|cash|equity)(?:_|$)",
            key,
        )
        and type(value) is not bool
    ):
        if (
            not isinstance(value, str)
            or re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value) is None
            or len(value) > 128
        ):
            raise ValueError("paper financial value must be decimal text")


class PaperStatusError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class PaperObservation:
    """One read of the configured status file at ``observed_at`` (seconds)."""

    state: str  # FRESH | STALE | UNAVAILABLE
    reason: str
    bot_name: str | None
    observed_at: float
    status: dict[str, Any] | None = None

    @property
    def bound(self) -> bool:
        return self.state == "FRESH"


def status_file_name_valid(path: Path) -> bool:
    return STATUS_NAME.fullmatch(path.name) is not None


def read_paper_status(path: Path, *, now: float) -> PaperObservation:
    match = STATUS_NAME.fullmatch(path.name)
    bot = match.group(1) if match else None
    try:
        if bot is None or not path.is_absolute():
            raise PaperStatusError("PAPER_STATUS_PATH")
        payload = _parse(_read_regular(path))
        status = validate_status(payload, bot)
    except PaperStatusError as exc:
        return PaperObservation("UNAVAILABLE", exc.code, bot, now)
    generated = status["generated_at"]
    if generated > now + FUTURE_SKEW_SECONDS:
        return PaperObservation("UNAVAILABLE", "PAPER_STATUS_CLOCK_SKEW", bot, now)
    if now - generated > STALE_AFTER_SECONDS:
        return PaperObservation("STALE", "PAPER_STATUS_STALE", bot, now, status)
    return PaperObservation("FRESH", "PAPER_STATUS_FRESH", bot, now, status)


def _read_regular(path: Path) -> bytes:
    # Symlinked parent directories would let the mount point be redirected.
    if os.path.realpath(path.parent) != str(path.parent):
        raise PaperStatusError("PAPER_STATUS_PATH")
    descriptor = _open_pinned(path)
    try:
        return _read_descriptor(descriptor)
    except OSError:
        # EIO and similar faults on an opened status file: the owner is unavailable.
        raise PaperStatusError("PAPER_STATUS_IO") from None
    finally:
        os.close(descriptor)


def _read_descriptor(descriptor: int) -> bytes:
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode):
        raise PaperStatusError("PAPER_STATUS_NOT_REGULAR")
    if metadata.st_size > MAX_STATUS_BYTES:
        raise PaperStatusError("PAPER_STATUS_CAPACITY")
    chunks, total = [], 0
    while total <= MAX_STATUS_BYTES:
        chunk = os.read(descriptor, MAX_STATUS_BYTES + 1 - total)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    if total > MAX_STATUS_BYTES:
        raise PaperStatusError("PAPER_STATUS_CAPACITY")
    return b"".join(chunks)


def _open_pinned(path: Path) -> int:
    """Open ``path`` through a directory chain that cannot be redirected.

    Each directory is opened with ``O_NOFOLLOW`` relative to its already opened
    parent and the file relative to the last one, so no component can be swapped
    for a symlink between the canonical-path check and the open. O_NONBLOCK keeps
    a FIFO from blocking open.
    """
    cloexec = getattr(os, "O_CLOEXEC", 0)
    # O_PATH (Linux) pins a directory that is searchable but not listable, as a
    # read-only bind mount's parents may be; elsewhere fall back to O_RDONLY.
    directory_flags = (
        getattr(os, "O_PATH", os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW | cloexec
    )
    try:
        parent = os.open("/", directory_flags)
    except OSError:
        raise PaperStatusError("PAPER_STATUS_PATH") from None
    try:
        for part in path.parent.parts[1:]:
            try:
                child = os.open(part, directory_flags, dir_fd=parent)
            except FileNotFoundError:
                raise PaperStatusError("PAPER_STATUS_MISSING") from None
            except OSError:
                # ELOOP/ENOTDIR: a directory was replaced after the path check.
                raise PaperStatusError("PAPER_STATUS_PATH") from None
            os.close(parent)
            parent = child
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | cloexec
        try:
            return os.open(path.name, flags, dir_fd=parent)
        except FileNotFoundError:
            raise PaperStatusError("PAPER_STATUS_MISSING") from None
        except OSError:
            # ELOOP: the file itself is a symlink.
            raise PaperStatusError("PAPER_STATUS_NOT_REGULAR") from None
    finally:
        os.close(parent)


# The status file carries counters and epoch times; 19 digits covers any int64.
MAX_INT_DIGITS = 19
# The real runtime status nests about ten levels (custom_info bags, executor configs).
MAX_DEPTH = 32
REQUIRED_KEYS = (
    "controller_kind",
    "controllers",
    "failure",
    "generated_at",
    "native_reports",
    "process_boot_id",
    "ready",
    "reasons",
    "report_observed_at",
    "unavailable_controller_ids",
    "simulation_assumptions",
)


def _parse(raw: bytes) -> Any:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(_name):
        raise ValueError("nonfinite JSON")

    # Every number must be representable: a literal exponent such as 1e999 parses to
    # an infinite float, and an integer of hundreds of digits overflows float
    # conversion later. Both make the whole status malformed, never a fresh value.
    def finite_float(text):
        number = float(text)
        if not math.isfinite(number):
            raise ValueError("nonfinite JSON number")
        return number

    def bounded_int(text):
        if len(text.lstrip("-")) > MAX_INT_DIGITS:
            raise ValueError("JSON integer out of range")
        return int(text)

    try:
        payload = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=pairs,
            parse_constant=constant,
            parse_float=finite_float,
            parse_int=bounded_int,
        )
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise PaperStatusError("PAPER_STATUS_MALFORMED") from None
    # Projections and the response encoder recurse; a status nested deeper than the
    # runtime ever writes is malformed (checked iteratively, never recursively).
    stack = [(payload, 1)]
    while stack:
        value, depth = stack.pop()
        if depth > MAX_DEPTH:
            raise PaperStatusError("PAPER_STATUS_MALFORMED")
        if isinstance(value, dict):
            stack.extend((item, depth + 1) for item in value.values())
            stack.extend((key, depth + 1) for key in value)
        elif isinstance(value, list):
            stack.extend((item, depth + 1) for item in value)
        elif isinstance(value, str):
            # JSON escapes can produce lone surrogates, which no response can encode.
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                raise PaperStatusError("PAPER_STATUS_MALFORMED") from None
    return payload


def _finite(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _require(condition: bool) -> None:
    if not condition:
        raise PaperStatusError("PAPER_STATUS_SCHEMA")


def validate_status(payload: Any, bot: str) -> dict[str, Any]:
    """Check the identity and shape fields every projection depends on."""
    if not isinstance(payload, dict):
        raise PaperStatusError("PAPER_STATUS_MALFORMED")
    _require(payload.get("schema_version") == 1)
    _require(payload.get("paper_runtime_schema") == "native_component_paper_runtime_v1")
    _require(
        payload.get("execution_mode") == "paper" and payload.get("bot_name") == bot
    )
    _require(_finite(payload.get("generated_at")) and payload["generated_at"] > 0)
    _require(
        isinstance(payload.get("process_boot_id"), str)
        and HEX32.fullmatch(payload["process_boot_id"]) is not None
    )
    _require(
        isinstance(payload.get("source_sha256"), str)
        and HEX64.fullmatch(payload["source_sha256"]) is not None
    )
    _require(
        isinstance(payload.get("controller_kind"), str)
        and 0 < len(payload["controller_kind"]) <= 64
    )
    _require(isinstance(payload.get("ready"), bool))
    reasons = payload.get("reasons")
    _require(isinstance(reasons, list) and len(reasons) <= 64)
    _require(all(isinstance(item, str) and len(item) <= 300 for item in reasons))
    # Keys every projection indexes directly must be present, even when null.
    _require(all(key in payload for key in REQUIRED_KEYS))
    failure = payload.get("failure")
    _require(failure is None or (isinstance(failure, str) and len(failure) <= 200))
    report_time = payload.get("report_observed_at")
    _require(report_time is None or _finite(report_time))
    _require(isinstance(payload.get("native_reports"), dict))
    unavailable = payload.get("unavailable_controller_ids")
    _require(
        isinstance(unavailable, list)
        and all(isinstance(item, str) for item in unavailable)
    )
    _require(isinstance(payload.get("simulation_assumptions"), dict))
    controllers = payload.get("controllers")
    _require(isinstance(controllers, list) and len(controllers) <= MAX_CONTROLLERS)
    seen = set()
    for row in controllers:
        _require(isinstance(row, dict))
        identity = row.get("id")
        _require(
            isinstance(identity, str)
            and CONTROLLER_ID.fullmatch(identity) is not None
            and identity not in seen
        )
        seen.add(identity)
        pair = row.get("pair")
        pairs = pair if isinstance(pair, list) else [pair]
        _require(
            0 < len(pairs) <= 64
            and all(isinstance(p, str) and PAIR.fullmatch(p) for p in pairs)
        )
        _require(
            isinstance(row.get("controller_name"), str)
            and len(row["controller_name"]) <= 128
        )
        _require(isinstance(row.get("custom_info", {}), dict))
    # The runtime declares every controller it owns, and each one is either reported
    # (native_reports) or listed unavailable, never both. A truncated declaration
    # would let projections present partial inventory as complete.
    _require(bool(seen))
    reported, missing = set(payload["native_reports"]), set(unavailable)
    _require(not reported & missing and reported | missing == seen)
    retained = payload.get("retained_reports") or {}
    _require(isinstance(retained, dict) and set(retained) <= seen)
    return payload
