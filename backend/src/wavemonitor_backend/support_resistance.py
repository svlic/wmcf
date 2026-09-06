from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from enum import StrEnum
from typing import Final, assert_never

ZERO: Final[Decimal] = Decimal("0")


class AlertMode(StrEnum):
    STATIC = "static"
    FIXED_DRAWDOWN = "fixed_drawdown"


def normalize_optional_level(value: Decimal | str | int | float | None) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if stripped == "":
            return None
        return Decimal(stripped)
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        raise ValueError("Decimal values must be provided as strings, Decimal, or integers")
    raise ValueError("Decimal values must be provided as strings, Decimal, or integers")


def derived_support(high_water: Decimal, fixed_drawdown: Decimal) -> Decimal:
    support = high_water - fixed_drawdown
    if support <= ZERO:
        raise ValueError("support must be positive")
    return support


def nearest_pair(
    supports: Sequence[Decimal],
    resistances: Sequence[Decimal],
    price: Decimal,
) -> tuple[Decimal | None, Decimal | None]:
    """Pick the greatest support below price and the least resistance above it."""
    below = tuple(level for level in supports if level < price)
    above = tuple(level for level in resistances if level > price)
    return (max(below) if below else None, min(above) if above else None)


def validate_instrument_levels(
    *,
    supports: Sequence[Decimal],
    resistances: Sequence[Decimal],
    alert_mode: AlertMode = AlertMode.STATIC,
    high_water: Decimal | None = None,
    fixed_drawdown: Decimal | None = None,
) -> None:
    match alert_mode:
        case AlertMode.STATIC:
            if high_water is not None or fixed_drawdown is not None:
                raise ValueError("high_water and fixed_drawdown must not be set in static mode")
            if not supports and not resistances:
                raise ValueError("at least one of support or resistance must be set")
            for support in supports:
                if support <= ZERO:
                    raise ValueError("support must be positive when set")
            for resistance in resistances:
                if resistance <= ZERO:
                    raise ValueError("resistance must be positive when set")
            if supports and resistances and max(supports) >= min(resistances):
                raise ValueError("support must be less than resistance")
        case AlertMode.FIXED_DRAWDOWN:
            if high_water is None or fixed_drawdown is None:
                raise ValueError("high_water and fixed_drawdown are required")
            if fixed_drawdown <= ZERO:
                raise ValueError("fixed_drawdown must be positive")
            computed = derived_support(high_water, fixed_drawdown)
            for support in supports:
                if support != computed:
                    raise ValueError("support is derived")
            if len(resistances) > 1:
                raise ValueError("fixed_drawdown accepts at most one resistance")
            for resistance in resistances:
                if resistance <= ZERO:
                    raise ValueError("resistance must be positive when set")
                if computed >= resistance:
                    raise ValueError("support must be less than resistance")
        case unreachable:
            assert_never(unreachable)


def levels_for_alerts(
    *, support: Decimal | None, resistance: Decimal | None, price: Decimal
) -> tuple[Decimal, Decimal]:
    """Snapshot values stored on alert rows when a level was not configured."""
    return (
        support if support is not None else price,
        resistance if resistance is not None else price,
    )
