"""Allowlisted read contract for native account analytics, not execution data."""
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated, Literal
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field


def amount(value):
    if not isinstance(value, str) or not Decimal(value).is_finite():
        raise ValueError('Invalid portfolio decimal')
    return value


def instant(value):
    if not isinstance(value, str):
        raise ValueError('Invalid observation instant')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None or parsed > datetime.now(timezone.utc):
        raise ValueError('Invalid observation instant')
    return value


Amount = Annotated[str, BeforeValidator(amount)]
Instant = Annotated[str, BeforeValidator(instant)]
Token = Annotated[str, Field(min_length=1, max_length=80)]


class Record(BaseModel):
    model_config = ConfigDict(extra='ignore', strict=True)


class Holding(Record):
    token: Token
    total: Amount
    available: Amount
    locked: Amount
    price: Amount | None
    value: Amount | None
    quote_currency: Literal['USDT']
    valuation_source: str | None
    price_observed_at: Instant | None


class Point(Record):
    observed_at: Instant
    priced_total: Amount
    valuation_complete: bool
    unpriced_assets: list[Token]


class Current(Point):
    holdings: list[Holding] = Field(max_length=10000)


class Scope(Record):
    account: Literal['master_account']
    connector: Literal['okx']
    market: Literal['spot']
    identity: str


class Gap(Record):
    from_: Instant = Field(alias='from')
    to: Instant
    seconds: float


class History(Record):
    points: list[Point] = Field(max_length=10000)
    first_observed_at: Instant | None
    range_start: Instant
    range_end: Instant
    truncated: bool
    gaps: list[Gap]


class Change(Record):
    observed_at: Instant
    token: Token
    previous_total: Amount
    total: Amount
    delta: Amount
    kind: Literal['observed_balance_change']


class Performance(Record):
    available: Literal[False]
    reason: str


class Analytics(Record):
    schema_version: Literal[1]
    quote_currency: Literal['USDT']
    scope: Scope | None
    capture_mode: Literal['observation-driven']
    current: Current | None
    history: History | None
    changes: list[Change] = Field(max_length=10000)
    performance: Performance
