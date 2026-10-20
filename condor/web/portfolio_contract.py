"""Allowlisted read contract for native account analytics, not execution data."""
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated, Literal
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator


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
    quote_currency: Literal['USDT', 'USDC']
    valuation_source: str | None
    price_observed_at: Instant | None
    usd_equivalent: Amount | None = None
    usd_equivalent_source: Literal['okx_account_balance_eqUsd'] | None = None
    excluded_from_valuation: bool | None = None


class Point(Record):
    observed_at: Instant
    priced_total: Amount
    valuation_complete: bool
    unpriced_assets: list[Token]


class Current(Point):
    holdings: list[Holding] = Field(max_length=10000)
    dust_threshold_usd: Amount | None = None
    excluded_dust_assets: list[Token] | None = Field(default=None, max_length=10000)


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
    quote_currency: Literal['USDT', 'USDC']
    valuation_basis: Literal['native_account_usdc_material_v1'] | None = None
    scope: Scope | None
    capture_mode: Literal['observation-driven']
    current: Current | None
    history: History | None
    changes: list[Change] = Field(max_length=10000)
    performance: Performance

    @model_validator(mode='after')
    def qualified_usdc_materiality(self):
        if self.quote_currency == 'USDT':
            if self.valuation_basis is not None:
                raise ValueError('USDT observations cannot use the USDC materiality basis')
            if self.current is not None and (
                self.current.dust_threshold_usd is not None
                or bool(self.current.excluded_dust_assets)
                or any(holding.excluded_from_valuation is True for holding in self.current.holdings)
            ):
                raise ValueError('Legacy USDT observations cannot claim materiality exclusions')
            return self
        if self.valuation_basis != 'native_account_usdc_material_v1':
            raise ValueError('USDC observations require the native materiality basis')
        if self.current is None:
            return self
        current = self.current
        if current.dust_threshold_usd is None or Decimal(current.dust_threshold_usd) != Decimal('1'):
            raise ValueError('USDC materiality threshold must be one USD')
        if current.excluded_dust_assets is None:
            raise ValueError('USDC excluded dust evidence is unavailable')
        if len(set(current.unpriced_assets)) != len(current.unpriced_assets):
            raise ValueError('Duplicate USDC unpriced asset')
        tokens = [holding.token for holding in current.holdings]
        if len(set(tokens)) != len(tokens):
            raise ValueError('Duplicate account holding')
        listed = set(current.excluded_dust_assets)
        if len(listed) != len(current.excluded_dust_assets):
            raise ValueError('Duplicate excluded dust asset')
        if any(holding.quote_currency != 'USDC' for holding in current.holdings):
            raise ValueError('USDC holdings have a mismatched quote currency')
        excluded = set()
        for holding in current.holdings:
            usd = Decimal(holding.usd_equivalent) if holding.usd_equivalent is not None else None
            source = holding.usd_equivalent_source
            marked = holding.excluded_from_valuation
            total = Decimal(holding.total)
            if (
                total < 0
                or (usd is not None and (not usd.is_finite() or usd < 0))
                or (total == 0 and usd is not None and usd != 0)
                or (source is not None and usd is None)
                or marked is None
            ):
                raise ValueError('Invalid USDC materiality evidence')
            if usd is not None and usd < 1 and source is not None and marked is not True:
                raise ValueError('Verified sub-dollar asset must be excluded')
            if marked is True:
                if usd is None or usd >= 1 or source is None or holding.price is not None or holding.value is not None:
                    raise ValueError('Excluded asset lacks verified dust evidence')
                excluded.add(holding.token)
        if excluded != listed:
            raise ValueError('Excluded dust asset list does not match holding evidence')
        if listed.intersection(current.unpriced_assets):
            raise ValueError('Excluded dust asset is also unpriced')
        expected_unpriced = {
            holding.token
            for holding in current.holdings
            if Decimal(holding.total) > 0
            and holding.excluded_from_valuation is False
            and (holding.price is None or holding.value is None)
        }
        if expected_unpriced != set(current.unpriced_assets):
            raise ValueError('USDC material unpriced assets do not match holding evidence')
        return self


class CapitalMetric(Record):
    value: Amount | None = None
    availability: Literal['available', 'unavailable', 'partial', 'insufficient_history', 'not_applicable']
    reason_code: str | None = None
    unit: str | None = None


class CapitalDashboard(Record):
    schema_version: Literal['rsibot.native_capital.v1']
    generated_at: str
    execution_authorized: Literal[False]
    range_rewritten: Literal[False]
    range_start: Instant | None = None
    range_end: Instant | None = None
    period_pnl: CapitalMetric
    today_pnl: CapitalMetric
    classified_flow_count: int = Field(ge=0)
    observed_change_count: int = Field(ge=0)
