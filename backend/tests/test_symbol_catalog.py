from __future__ import annotations

import json
from io import BytesIO
from urllib.request import Request

import pytest

from wavemonitor_backend.models import MarketType, Provider
from wavemonitor_backend.symbol_catalog import (
    TRADINGVIEW_SCANNER_URL,
    TRADINGVIEW_TIMEOUT_SECONDS,
    SymbolCatalog,
    SymbolOption,
    TradingViewBinanceClient,
    default_binance_futures_clients,
)


class FakeBinanceExchange:
    def __init__(self, symbols: list[str]) -> None:
        self._symbols = symbols

    def exchange_info(self) -> dict[str, object]:
        return {
            "symbols": [
                {"symbol": symbol, "status": "TRADING" if symbol != "HALTED" else "BREAK"}
                for symbol in self._symbols
            ]
        }


class UnavailableBinanceExchange:
    def exchange_info(self) -> dict[str, object]:
        raise RuntimeError("provider unavailable")


class FakeResponse(BytesIO):
    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def json_response(payload: object) -> FakeResponse:
    return FakeResponse(json.dumps(payload).encode())


class FakeHyperliquid:
    def __init__(
        self,
        mids: dict[str, str],
        dexs: list[dict[str, object] | None] | None = None,
        dex_mids: dict[str, dict[str, str]] | None = None,
    ) -> None:
        self._mids = mids
        self._dexs = dexs or []
        self._dex_mids = dex_mids or {}

    def all_mids(self, dex: str = "") -> dict[str, str]:
        if not dex:
            return self._mids
        return self._dex_mids.get(dex, {})

    def perp_dexs(self) -> list[dict[str, object] | None]:
        return self._dexs


def test_binance_filters_trading_symbols_and_ranks_prefix_matches() -> None:
    catalog = SymbolCatalog(
        usd_m_client=FakeBinanceExchange(["ETHUSDT", "BTCUSDT", "HALTED", "WBTCUSDT"]),
    )
    options = catalog.search(Provider.BINANCE, MarketType.USD_M_FUTURES, "btc")
    assert [option.symbol for option in options] == ["BTCUSDT", "WBTCUSDT"]


def test_binance_falls_back_to_normalized_usd_m_symbol_when_catalog_is_unavailable() -> None:
    catalog = SymbolCatalog(usd_m_client=UnavailableBinanceExchange())

    options = catalog.search(Provider.BINANCE, MarketType.USD_M_FUTURES, "btcusdt")

    assert options == [
        SymbolOption(
            symbol="BTCUSDT",
            label="BTCUSDT",
            provider=Provider.BINANCE,
            market_type=MarketType.USD_M_FUTURES,
        )
    ]


def test_binance_fallback_appends_usdt_for_partial_usd_m_symbol() -> None:
    catalog = SymbolCatalog(usd_m_client=UnavailableBinanceExchange())

    options = catalog.search(Provider.BINANCE, MarketType.USD_M_FUTURES, "btc")

    assert options[0].symbol == "BTCUSDT"


def test_binance_fallback_preserves_coin_m_contract_query() -> None:
    catalog = SymbolCatalog(coin_m_client=UnavailableBinanceExchange())

    options = catalog.search(Provider.BINANCE, MarketType.COIN_M_FUTURES, "btcusd_perp")

    assert options[0].symbol == "BTCUSD_PERP"


def test_default_binance_clients_use_tradingview_for_both_contract_types() -> None:
    usd_m, coin_m = default_binance_futures_clients()

    assert isinstance(usd_m, TradingViewBinanceClient)
    assert isinstance(coin_m, TradingViewBinanceClient)


def test_tradingview_client_maps_binance_coin_m_symbol_to_exchange_ticker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, int, dict[str, object]]] = []

    def fake_urlopen(request: Request, timeout: int) -> FakeResponse:
        url = request.full_url
        body = json.loads(request.data or b"{}")
        requests.append((url, timeout, body))
        return json_response(
            {"data": [{"s": "BINANCE:BTCUSD.P", "d": [60319.5]}]}
        )

    monkeypatch.setattr("wavemonitor_backend.symbol_catalog.urlopen", fake_urlopen)
    client = TradingViewBinanceClient(MarketType.COIN_M_FUTURES)

    assert client.mark_price("BTCUSD_PERP") == {
        "symbol": "BTCUSD_PERP",
        "markPrice": 60319.5,
    }
    assert requests == [
        (
            TRADINGVIEW_SCANNER_URL,
            TRADINGVIEW_TIMEOUT_SECONDS,
            {
                "symbols": {
                    "tickers": ["BINANCE:BTCUSD.P"],
                    "query": {"types": []},
                },
                "columns": ["close"],
            },
        )
    ]


def test_tradingview_catalog_separates_binance_linear_and_inverse_contracts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "data": [
            {"s": "BINANCE:BTCUSDT.P", "d": ["BTCUSDT.P", "USDT"]},
            {"s": "BINANCE:BTCUSDC.P", "d": ["BTCUSDC.P", "USDC"]},
            {"s": "BINANCE:BTCUSD.P", "d": ["BTCUSD.P", "USD"]},
        ]
    }

    def fake_urlopen(_request: object, timeout: int) -> FakeResponse:
        assert timeout == TRADINGVIEW_TIMEOUT_SECONDS
        return json_response(payload)

    monkeypatch.setattr("wavemonitor_backend.symbol_catalog.urlopen", fake_urlopen)
    usd_client = TradingViewBinanceClient(MarketType.USD_M_FUTURES)
    coin_client = TradingViewBinanceClient(MarketType.COIN_M_FUTURES)

    assert usd_client.exchange_info() == {
        "symbols": [
            {"symbol": "BTCUSDT", "status": "TRADING"},
            {"symbol": "BTCUSDC", "status": "TRADING"},
        ]
    }
    assert coin_client.exchange_info() == {
        "symbols": [{"symbol": "BTCUSD_PERP", "status": "TRADING"}]
    }


def test_hyperliquid_searches_all_mids() -> None:
    catalog = SymbolCatalog(hyperliquid_client=FakeHyperliquid({"BTC": "1", "ETH": "2"}))
    options = catalog.search(Provider.HYPERLIQUID, MarketType.PERPETUAL, "bt")
    assert options == [
        SymbolOption(
            symbol="BTC",
            label="BTC",
            provider=Provider.HYPERLIQUID,
            market_type=MarketType.PERPETUAL,
        )
    ]


def test_hyperliquid_searches_hip3_stock_contract_dexs() -> None:
    catalog = SymbolCatalog(
        hyperliquid_client=FakeHyperliquid(
            {"BTC": "1"},
            dexs=[{"name": "hip3-stocks"}],
            dex_mids={"hip3-stocks": {"hip3-stocks:AAPL": "1", "hip3-stocks:TSLA": "2"}},
        )
    )
    options = catalog.search(Provider.HYPERLIQUID, MarketType.PERPETUAL, "aa")
    assert options == [
        SymbolOption(
            symbol="hip3-stocks:AAPL",
            label="hip3-stocks:AAPL",
            provider=Provider.HYPERLIQUID,
            market_type=MarketType.PERPETUAL,
        )
    ]


def test_hyperliquid_searches_trade_xyz_assets_from_perp_dex_metadata() -> None:
    catalog = SymbolCatalog(
        hyperliquid_client=FakeHyperliquid(
            {"BTC": "1"},
            dexs=[
                None,
                {
                    "name": "xyz",
                    "fullName": "XYZ",
                    "assetToStreamingOiCap": [
                        ["xyz:AAPL", "100000000.0"],
                        ["xyz:CRCL", "100000000.0"],
                    ],
                },
            ],
        )
    )
    options = catalog.search(Provider.HYPERLIQUID, MarketType.PERPETUAL, "crcl")
    assert options == [
        SymbolOption(
            symbol="xyz:CRCL",
            label="xyz:CRCL",
            provider=Provider.HYPERLIQUID,
            market_type=MarketType.PERPETUAL,
        )
    ]

def test_hyperliquid_searches_mstr_and_crcl_across_hip3_metadata_fields() -> None:
    catalog = SymbolCatalog(
        hyperliquid_client=FakeHyperliquid(
            {"BTC": "1"},
            dexs=[
                {
                    "name": "xyz",
                    "assetToStreamingOiCap": [
                        ["xyz:MSTR", "100000000.0"],
                        ["xyz:CRCL", "150000000.0"],
                    ],
                    "assetToFundingMultiplier": [
                        ["xyz:MSTR", "0.5"],
                        ["xyz:CRCL", "0.5"],
                    ],
                }
            ],
        )
    )

    mstr = catalog.search(Provider.HYPERLIQUID, MarketType.PERPETUAL, "MSTR")
    crcl = catalog.search(Provider.HYPERLIQUID, MarketType.PERPETUAL, "CRCL")

    assert [option.symbol for option in mstr] == ["xyz:MSTR"]
    assert [option.symbol for option in crcl] == ["xyz:CRCL"]


def test_yfinance_uses_injected_search_factory() -> None:
    def fake_search(query: str, limit: int) -> list[SymbolOption]:
        assert query == "AAPL"
        assert limit == 25
        return [
            SymbolOption(
                symbol="AAPL",
                label="AAPL — Apple Inc.",
                provider=Provider.YFINANCE,
                market_type=MarketType.EQUITY,
            )
        ]

    catalog = SymbolCatalog(yfinance_search=fake_search)
    options = catalog.search(Provider.YFINANCE, MarketType.EQUITY, "aapl")
    assert len(options) == 1
    assert options[0].symbol == "AAPL"

def test_yfinance_returns_exact_symbol_when_search_provider_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import yfinance as yf

    class UnavailableSearch:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            raise RuntimeError("Yahoo search unavailable")

    monkeypatch.setattr(yf, "Search", UnavailableSearch)

    catalog = SymbolCatalog()

    assert catalog.search(Provider.YFINANCE, MarketType.EQUITY, "mstr") == [
        SymbolOption(
            symbol="MSTR",
            label="MSTR",
            provider=Provider.YFINANCE,
            market_type=MarketType.EQUITY,
        )
    ]


def test_yfinance_returns_exact_symbol_when_search_provider_returns_no_quotes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import yfinance as yf

    class EmptySearch:
        quotes: list[object] = []

        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

    monkeypatch.setattr(yf, "Search", EmptySearch)

    options = SymbolCatalog().search(Provider.YFINANCE, MarketType.EQUITY, "crcl")

    assert [option.symbol for option in options] == ["CRCL"]
