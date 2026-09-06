from decimal import Decimal

import pytest

from wavemonitor_backend.models import AlertMode
from wavemonitor_backend.support_resistance import (
    derived_support,
    nearest_pair,
    validate_instrument_levels,
)


def test_derived_support_is_high_water_minus_fixed_drawdown():
    # Given: an absolute drawdown from a high-water mark.
    # When: support is derived.
    # Then: the result is the price difference, not a percentage.
    assert derived_support(
        high_water=Decimal("100000"),
        fixed_drawdown=Decimal("5000"),
    ) == Decimal("95000")


def test_derived_support_rejects_non_positive_result():
    with pytest.raises(ValueError, match="support must be positive"):
        derived_support(high_water=Decimal("100"), fixed_drawdown=Decimal("100"))


def test_validate_instrument_levels_accepts_fixed_drawdown_without_client_support():
    validate_instrument_levels(
        alert_mode=AlertMode.FIXED_DRAWDOWN,
        supports=(Decimal("95000"),),
        resistances=(Decimal("120000"),),
        high_water=Decimal("100000"),
        fixed_drawdown=Decimal("5000"),
    )


def test_validate_instrument_levels_still_requires_a_level_in_static_mode():
    with pytest.raises(ValueError, match="at least one of support or resistance"):
        validate_instrument_levels(
            alert_mode=AlertMode.STATIC,
            supports=(),
            resistances=(),
        )


def test_nearest_pair_picks_greatest_support_below_price_and_least_resistance_above():
    # Given: several supports below price and resistances above it, unsorted.
    # When: the nearest pair is selected.
    # Then: support is the greatest value strictly below price, resistance the least strictly above.
    support, resistance = nearest_pair(
        supports=(Decimal("90"), Decimal("98"), Decimal("80")),
        resistances=(Decimal("120"), Decimal("105"), Decimal("130")),
        price=Decimal("100"),
    )

    assert support == Decimal("98")
    assert resistance == Decimal("105")


def test_nearest_pair_ignores_levels_on_the_wrong_side_of_price():
    support, resistance = nearest_pair(
        supports=(Decimal("100"), Decimal("110"), Decimal("90")),
        resistances=(Decimal("100"), Decimal("95"), Decimal("120")),
        price=Decimal("100"),
    )

    assert support == Decimal("90")
    assert resistance == Decimal("120")


def test_nearest_pair_returns_none_when_no_level_is_on_the_correct_side():
    support, resistance = nearest_pair(
        supports=(Decimal("100"), Decimal("110")),
        resistances=(Decimal("90"), Decimal("100")),
        price=Decimal("100"),
    )

    assert support is None
    assert resistance is None


def test_validate_instrument_levels_accepts_multiple_static_levels():
    validate_instrument_levels(
        alert_mode=AlertMode.STATIC,
        supports=(Decimal("90"), Decimal("95")),
        resistances=(Decimal("110"), Decimal("120")),
    )


def test_validate_instrument_levels_rejects_static_support_not_below_resistance():
    with pytest.raises(ValueError, match="support must be less than resistance"):
        validate_instrument_levels(
            alert_mode=AlertMode.STATIC,
            supports=(Decimal("90"), Decimal("115")),
            resistances=(Decimal("110"), Decimal("120")),
        )


def test_validate_instrument_levels_rejects_multiple_fixed_drawdown_resistances():
    with pytest.raises(ValueError, match="fixed_drawdown accepts at most one resistance"):
        validate_instrument_levels(
            alert_mode=AlertMode.FIXED_DRAWDOWN,
            supports=(),
            resistances=(Decimal("120000"), Decimal("130000")),
            high_water=Decimal("100000"),
            fixed_drawdown=Decimal("5000"),
        )
