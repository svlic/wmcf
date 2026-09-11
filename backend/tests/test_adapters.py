from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import NoReturn

from wavemonitor_backend.adapters import (
    AdapterError,
    AdapterErrorKind,
    BinanceFuturesAdapter,
    HyperliquidAdapter,
    PriceResult,
    YFinanceAdapter,
)
from wavemonitor_backend.models import MarketType, Provider


class FakeYFinanceTicker:
    def __init__(
        self,
        fast_info: object,
        history_rows: list[dict[str, object]] | None = None,
    ) -> None:
        self.fast_info = fast_info
        self.history_rows = history_rows or []
        self.history_calls: list[dict[str, str]] = []

    def history(self, *, period: str, interval: str) -> object:
        self.history_calls.append({"period": period, "interval": interval})
        return FakeHistoryFrame(self.history_rows)


class FakeHistoryFrame:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.empty = not rows
        self.iloc = FakeILoc(rows)


class FakeILoc:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows

    def __getitem__(self, index: int) -> dict[str, object]:
        return self.rows[index]


class FakeBinanceClient:
    def __init__(
        self,
        *,
        mark_payload: dict[str, object] | BaseException | None = None,
        ticker_payload: dict[str, object] | BaseException | None = None,
    ) -> None:
        self.mark_payload = mark_payload
        self.ticker_payload = ticker_payload
        self.mark_calls: list[str] = []
        self.ticker_calls: list[str] = []

    def mark_price(self, symbol: str) -> dict[str, object]:
        self.mark_calls.append(symbol)
        if isinstance(self.mark_payload, BaseException):
            raise self.mark_payload
        if self.mark_payload is None:
            return {}
        return self.mark_payload

    def ticker_price(self, symbol: str) -> dict[str, object]:
        self.ticker_calls.append(symbol)
        if isinstance(self.ticker_payload, BaseException):
            raise self.ticker_payload
        if self.ticker_payload is None:
            return {}
        return self.ticker_payload


class FakeHyperliquidInfo:
    def __init__(
        self,
        mids: dict[str, str] | BaseException,
        dex_mids: dict[str, dict[str, str]] | None = None,
    ) -> None:
        self.mids = mids
        self.dex_mids = dex_mids or {}
        self.calls: list[str] = []

    def all_mids(self, dex: str = "") -> dict[str, str]:
        self.calls.append(dex)
        if isinstance(self.mids, BaseException):
            raise self.mids
        if dex:
            return self.dex_mids.get(dex, {})
        return self.mids


class RateLimitedProviderError(Exception):
    status_code = 429


def _fail_network_call(symbol: str) -> NoReturn:
    raise AssertionError(f"unexpected live network factory call for {symbol}")


def test_yfinance_adapter_returns_fast_info_last_price_when_float():
    observed_at = datetime(2026, 6, 30, 12, 0, tzinfo=UTC)
    ticker = FakeYFinanceTicker(fast_info={"last_price": 62.22990036010742})
    adapter = YFinanceAdapter(ticker_factory=lambda symbol: ticker, clock=lambda: observed_at)

    result = adapter.get_latest_price("CRCL", MarketType.EQUITY)

    assert isinstance(result, PriceResult)
    assert result.symbol == "CRCL"
    assert result.price == Decimal("62.22990036010742")
    assert result.raw_metadata == {
        "path": "fast_info.last_price",
        "raw_price": 62.22990036010742,
    }


def test_yfinance_adapter_returns_fast_info_last_price_when_present():
    # Given: a yfinance ticker with fast_info.last_price available for AAPL.
    observed_at = datetime(2026, 6, 30, 12, 0, tzinfo=UTC)
    ticker = FakeYFinanceTicker(fast_info={"last_price": "212.3400"})
    adapter = YFinanceAdapter(ticker_factory=lambda symbol: ticker, clock=lambda: observed_at)

    # When: the latest price is requested.
    result = adapter.get_latest_price("AAPL", MarketType.EQUITY)

    # Then: the normalized contract carries source identity, price, timestamp, and metadata.
    assert isinstance(result, PriceResult)
    assert result.source == Provider.YFINANCE
    assert result.market_type == MarketType.EQUITY
    assert result.symbol == "AAPL"
    assert result.price == Decimal("212.3400")
    assert result.timestamp == observed_at
    assert result.raw_metadata == {"path": "fast_info.last_price", "raw_price": "212.3400"}
    assert ticker.history_calls == []


def test_yfinance_adapter_falls_back_to_history_close_from_pandas_like_row():
    observed_at = datetime(2026, 6, 30, 12, 0, tzinfo=UTC)

    class FakeSeries:
        def __getitem__(self, key: str) -> object:
            if key == "Close":
                return 62.24800109863281
            raise KeyError(key)

    class FakeHistoryFrameWithSeries:
        empty = False

        class _ILoc:
            @staticmethod
            def __getitem__(_index: int) -> FakeSeries:
                return FakeSeries()

        iloc = _ILoc()

    class FakeHistoryWithSeries:
        fast_info: object = {}

        def history(self, *, period: str, interval: str) -> FakeHistoryFrameWithSeries:
            return FakeHistoryFrameWithSeries()

    ticker = FakeHistoryWithSeries()
    adapter = YFinanceAdapter(
        ticker_factory=lambda symbol: ticker,
        clock=lambda: observed_at,
    )

    result = adapter.get_latest_price("CRCL", MarketType.EQUITY)

    assert isinstance(result, PriceResult)
    assert result.price == Decimal("62.24800109863281")
    assert result.raw_metadata == {"path": "history.close", "raw_price": 62.24800109863281}


def test_yfinance_adapter_falls_back_to_latest_one_minute_history_close():
    # Given: fast_info lacks a usable last_price but 1m history has a latest close.
    ticker = FakeYFinanceTicker(fast_info={}, history_rows=[{"Close": "213.11"}])
    adapter = YFinanceAdapter(ticker_factory=lambda symbol: ticker)

    # When: the latest price is requested.
    result = adapter.get_latest_price("AAPL", MarketType.EQUITY)

    # Then: the adapter uses the planned 1d/1m close fallback without live network access.
    assert result.price == Decimal("213.11")
    assert result.raw_metadata == {"path": "history.close", "raw_price": "213.11"}
    assert ticker.history_calls == [{"period": "1d", "interval": "1m"}]


def test_yfinance_adapter_returns_missing_symbol_error_when_no_quote_exists():
    # Given: neither fast_info nor history has an AAPL price.
    ticker = FakeYFinanceTicker(fast_info={}, history_rows=[])
    adapter = YFinanceAdapter(ticker_factory=lambda symbol: ticker)

    # When: the latest price is requested.
    result = adapter.get_latest_price("AAPL", MarketType.EQUITY)

    # Then: callers receive a typed missing-symbol error instead of an exception.
    assert result == AdapterError(
        source=Provider.YFINANCE,
        market_type=MarketType.EQUITY,
        symbol="AAPL",
        kind=AdapterErrorKind.MISSING_SYMBOL,
        message="AAPL price was not present in yfinance fast_info or 1m history",
        raw_metadata={"paths": ["fast_info.last_price", "history.close"]},
    )


def test_yfinance_adapter_returns_malformed_price_error_for_bad_decimal_string():
    # Given: yfinance returns a malformed price string.
    ticker = FakeYFinanceTicker(fast_info={"last_price": "not-a-decimal"})
    adapter = YFinanceAdapter(ticker_factory=lambda symbol: ticker)

    # When: the latest price is requested.
    result = adapter.get_latest_price("AAPL", MarketType.EQUITY)

    # Then: malformed input is captured as a typed adapter error without crashing.
    assert isinstance(result, AdapterError)
    assert result.kind == AdapterErrorKind.MALFORMED_PRICE
    assert result.raw_metadata == {"path": "fast_info.last_price", "raw_price": "not-a-decimal"}


def test_yfinance_adapter_maps_provider_timeout_to_typed_error():
    # Given: constructing the ticker raises a timeout-like provider failure.
    adapter = YFinanceAdapter(
        ticker_factory=lambda symbol: (_ for _ in ()).throw(TimeoutError("slow")),
    )

    # When: the latest price is requested.
    result = adapter.get_latest_price("AAPL", MarketType.EQUITY)

    # Then: timeout/error mapping is typed for scheduler-safe handling.
    assert isinstance(result, AdapterError)
    assert result.kind == AdapterErrorKind.TIMEOUT
    assert result.message == "slow"


def test_binance_usd_m_adapter_prefers_mark_price_and_uses_usd_m_client():
    # Given: separate USD-M and COIN-M fake clients expose different routes.
    usd_client = FakeBinanceClient(
        mark_payload={"symbol": "BTCUSDT", "markPrice": "60321.42", "time": 1},
    )
    coin_client = FakeBinanceClient(mark_payload={"symbol": "BTCUSD_PERP", "markPrice": "60320"})
    adapter = BinanceFuturesAdapter(usd_m_client=usd_client, coin_m_client=coin_client)

    # When: a USD-M latest price is requested.
    result = adapter.get_latest_price("BTCUSDT", MarketType.USD_M_FUTURES)

    # Then: mark price is preferred and only the USD-M route is used.
    assert isinstance(result, PriceResult)
    assert result.source == Provider.BINANCE
    assert result.market_type == MarketType.USD_M_FUTURES
    assert result.symbol == "BTCUSDT"
    assert result.price == Decimal("60321.42")
    assert result.raw_metadata == {"path": "tradingview.close", "raw_price": "60321.42"}
    assert usd_client.mark_calls == ["BTCUSDT"]
    assert coin_client.mark_calls == []


def test_binance_coin_m_adapter_uses_coin_m_route_for_perpetual_symbol():
    # Given: a COIN-M representative symbol has a mark price on the COIN-M client.
    usd_client = FakeBinanceClient(mark_payload={"symbol": "BTCUSDT", "markPrice": "1"})
    coin_client = FakeBinanceClient(mark_payload={"symbol": "BTCUSD_PERP", "markPrice": "60319.5"})
    adapter = BinanceFuturesAdapter(usd_m_client=usd_client, coin_m_client=coin_client)

    # When: a COIN-M latest price is requested.
    result = adapter.get_latest_price("BTCUSD_PERP", MarketType.COIN_M_FUTURES)

    # Then: only the COIN-M route is used for BTCUSD_PERP.
    assert isinstance(result, PriceResult)
    assert result.market_type == MarketType.COIN_M_FUTURES
    assert result.symbol == "BTCUSD_PERP"
    assert result.price == Decimal("60319.5")
    assert coin_client.mark_calls == ["BTCUSD_PERP"]
    assert usd_client.mark_calls == []


def test_binance_adapter_falls_back_to_latest_ticker_price_when_mark_absent():
    # Given: Binance mark price payload lacks markPrice but latest ticker price is available.
    client = FakeBinanceClient(
        mark_payload={"symbol": "BTCUSDT"},
        ticker_payload={"symbol": "BTCUSDT", "price": "60322.01"},
    )
    adapter = BinanceFuturesAdapter(usd_m_client=client, coin_m_client=FakeBinanceClient())

    # When: a USD-M latest price is requested.
    result = adapter.get_latest_price("BTCUSDT", MarketType.USD_M_FUTURES)

    # Then: latest ticker price is a fallback after mark-price preference.
    assert isinstance(result, PriceResult)
    assert result.price == Decimal("60322.01")
    assert result.raw_metadata == {"path": "tradingview.close", "raw_price": "60322.01"}
    assert client.mark_calls == ["BTCUSDT"]
    assert client.ticker_calls == ["BTCUSDT"]


def test_binance_adapter_maps_rate_limit_response_to_typed_error():
    # Given: the provider client raises an HTTP-429-like exception.
    client = FakeBinanceClient(mark_payload=RateLimitedProviderError("too many requests"))
    adapter = BinanceFuturesAdapter(usd_m_client=client, coin_m_client=FakeBinanceClient())

    # When: the latest price is requested.
    result = adapter.get_latest_price("BTCUSDT", MarketType.USD_M_FUTURES)

    # Then: HTTP 429/rate-limit mapping is explicit.
    assert isinstance(result, AdapterError)
    assert result.kind == AdapterErrorKind.RATE_LIMITED
    assert result.message == "too many requests"


def test_binance_adapter_returns_malformed_price_error_for_bad_decimal_string():
    # Given: Binance returns a non-decimal mark price.
    client = FakeBinanceClient(mark_payload={"symbol": "BTCUSDT", "markPrice": "NaNish"})
    adapter = BinanceFuturesAdapter(usd_m_client=client, coin_m_client=FakeBinanceClient())

    # When: the latest price is requested.
    result = adapter.get_latest_price("BTCUSDT", MarketType.USD_M_FUTURES)

    # Then: Decimal string parsing rejects malformed exchange data.
    assert isinstance(result, AdapterError)
    assert result.kind == AdapterErrorKind.MALFORMED_PRICE
    assert result.raw_metadata == {"path": "tradingview.close", "raw_price": "NaNish"}


def test_hyperliquid_adapter_looks_up_all_mids_coin_and_parses_decimal_string():
    # Given: Hyperliquid all_mids returns string prices keyed by coin.
    info = FakeHyperliquidInfo({"BTC": "60324.125", "ETH": "3400.1"})
    adapter = HyperliquidAdapter(info_client=info)

    # When: BTC latest price is requested.
    result = adapter.get_latest_price("BTC", MarketType.PERPETUAL)

    # Then: all_mids lookup returns a Decimal-safe perpetual price.
    assert isinstance(result, PriceResult)
    assert result.source == Provider.HYPERLIQUID
    assert result.market_type == MarketType.PERPETUAL
    assert result.symbol == "BTC"
    assert result.price == Decimal("60324.125")
    assert result.raw_metadata == {"path": "all_mids.BTC", "raw_price": "60324.125"}
    assert info.calls == [""]


def test_hyperliquid_adapter_looks_up_dex_prefixed_hip3_symbols():
    # Given: a HIP-3 contract deployed under trade.xyz uses a dex-prefixed coin.
    info = FakeHyperliquidInfo(
        {"BTC": "60324.125"},
        dex_mids={"xyz": {"xyz:CRCL": "63.31"}},
    )
    adapter = HyperliquidAdapter(info_client=info)

    # When: the dex-prefixed latest price is requested.
    result = adapter.get_latest_price("xyz:CRCL", MarketType.PERPETUAL)

    # Then: the adapter routes to that DEX and preserves the lowercase dex prefix.
    assert isinstance(result, PriceResult)
    assert result.symbol == "xyz:CRCL"
    assert result.price == Decimal("63.31")
    assert result.raw_metadata == {"path": "all_mids.xyz.xyz:CRCL", "raw_price": "63.31"}
    assert info.calls == ["xyz"]


def test_hyperliquid_adapter_returns_missing_symbol_for_absent_coin():
    # Given: Hyperliquid all_mids lacks DOGE.
    adapter = HyperliquidAdapter(info_client=FakeHyperliquidInfo({"BTC": "60324.125"}))

    # When: DOGE latest price is requested.
    result = adapter.get_latest_price("DOGE", MarketType.PERPETUAL)

    # Then: missing symbol is typed rather than raising KeyError.
    assert isinstance(result, AdapterError)
    assert result.kind == AdapterErrorKind.MISSING_SYMBOL
    assert result.symbol == "DOGE"


def test_hyperliquid_adapter_maps_provider_errors_to_typed_error():
    # Given: Hyperliquid SDK raises a provider exception.
    adapter = HyperliquidAdapter(info_client=FakeHyperliquidInfo(RuntimeError("sdk unavailable")))

    # When: BTC latest price is requested.
    result = adapter.get_latest_price("BTC", MarketType.PERPETUAL)

    # Then: future scheduler callers receive a typed provider error.
    assert isinstance(result, AdapterError)
    assert result.kind == AdapterErrorKind.PROVIDER_ERROR
    assert result.message == "sdk unavailable"


def test_adapters_do_not_create_default_clients_during_mocked_tests():
    # Given: adapters receive injected fake clients and a network-failing yfinance factory.
    yfinance_adapter = YFinanceAdapter(ticker_factory=_fail_network_call)
    binance_adapter = BinanceFuturesAdapter(
        usd_m_client=FakeBinanceClient(mark_payload={"markPrice": "1"}),
        coin_m_client=FakeBinanceClient(mark_payload={"markPrice": "2"}),
    )
    hyperliquid_adapter = HyperliquidAdapter(info_client=FakeHyperliquidInfo({"BTC": "3"}))

    # When: injected clients are used for non-yfinance adapters.
    binance_result = binance_adapter.get_latest_price("BTCUSDT", MarketType.USD_M_FUTURES)
    hyperliquid_result = hyperliquid_adapter.get_latest_price("BTC", MarketType.PERPETUAL)

    # Then: tests stay offline and yfinance network factories are not invoked implicitly.
    assert isinstance(binance_result, PriceResult)
    assert isinstance(hyperliquid_result, PriceResult)
    assert (
        yfinance_adapter.get_latest_price("AAPL", MarketType.EQUITY).kind
        == AdapterErrorKind.PROVIDER_ERROR
    )
