from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from threading import Lock
from typing import Final, Protocol
from urllib.request import Request, urlopen

from wavemonitor_backend.adapter_types import BinanceFuturesClient, HyperliquidInfoClient
from wavemonitor_backend.models import MarketType, Provider

SYMBOL_QUERY_MAX_RESULTS: Final[int] = 25
TRADINGVIEW_SCANNER_URL: Final[str] = "https://scanner.tradingview.com/crypto/scan"
TRADINGVIEW_TIMEOUT_SECONDS: Final[int] = 5
YFINANCE_TIMEOUT_SECONDS: Final[int] = 5
HYPERLIQUID_TIMEOUT_SECONDS: Final[int] = 5


@dataclass(frozen=True, slots=True)
class SymbolOption:
    symbol: str
    label: str
    provider: Provider
    market_type: MarketType


class BinanceExchangeListing(BinanceFuturesClient, Protocol):
    def exchange_info(self) -> dict[str, object]: ...


class TradingViewBinanceClient:
    def __init__(self, market_type: MarketType) -> None:
        self._market_type = market_type

    def mark_price(self, symbol: str) -> dict[str, object]:
        rows = self._scan(
            {
                "symbols": {"tickers": [self._ticker(symbol)], "query": {"types": []}},
                "columns": ["close"],
            }
        )
        if not rows:
            return {}
        values = rows[0].get("d")
        price = values[0] if isinstance(values, list) and values else None
        return {"symbol": symbol, "markPrice": price}

    def ticker_price(self, symbol: str) -> dict[str, object]:
        quote = self.mark_price(symbol)
        return {"symbol": symbol, "price": quote.get("markPrice")}

    def exchange_info(self) -> dict[str, object]:
        rows = self._scan(
            {
                "filter": [
                    {"left": "exchange", "operation": "equal", "right": "BINANCE"},
                    {"left": "type", "operation": "equal", "right": "swap"},
                ],
                "markets": ["crypto"],
                "columns": ["name", "currency"],
                "range": [0, 2000],
            }
        )
        symbols: list[dict[str, object]] = []
        for row in rows:
            values = row.get("d")
            if not isinstance(values, list) or len(values) < 2:
                continue
            name, currency = values[:2]
            if not isinstance(name, str) or not name.endswith(".P"):
                continue
            symbol = name.removesuffix(".P")
            if self._market_type is MarketType.USD_M_FUTURES:
                if currency not in {"USDT", "USDC"}:
                    continue
            else:
                if currency != "USD":
                    continue
                symbol = f"{symbol}_PERP"
            symbols.append({"symbol": symbol, "status": "TRADING"})
        return {"symbols": symbols}

    def _ticker(self, symbol: str) -> str:
        normalized = symbol.removesuffix("_PERP")
        return f"BINANCE:{normalized}.P"

    def _scan(self, payload: dict[str, object]) -> list[dict[str, object]]:
        request = Request(
            TRADINGVIEW_SCANNER_URL,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=TRADINGVIEW_TIMEOUT_SECONDS) as response:  # noqa: S310
            result = json.load(response)
        rows = result.get("data") if isinstance(result, dict) else None
        if not isinstance(rows, list):
            raise RuntimeError("TradingView scanner response data is not a list")
        return [row for row in rows if isinstance(row, dict)]


YFinanceSearchFactory = Callable[[str, int], list[SymbolOption]]
HyperliquidClientFactory = Callable[[], HyperliquidInfoClient]


def _normalize_query(query: str) -> str:
    return query.strip().upper()


def _rank_key(symbol: str, query: str) -> tuple[int, str]:
    upper = symbol.upper()
    if upper.startswith(query):
        return (0, upper)
    if upper.endswith(query):
        return (1, upper)
    return (2, upper)


def _filter_symbols(
    symbols: Iterable[str],
    *,
    query: str,
    provider: Provider,
    market_type: MarketType,
    limit: int,
) -> list[SymbolOption]:
    matches = list({symbol for symbol in symbols if query in symbol.upper()})
    matches.sort(key=lambda symbol: _rank_key(symbol, query))
    return [
        SymbolOption(symbol=symbol, label=symbol, provider=provider, market_type=market_type)
        for symbol in matches[:limit]
    ]


def _binance_trading_symbols(payload: dict[str, object]) -> list[str]:
    raw_symbols = payload.get("symbols")
    if not isinstance(raw_symbols, list):
        return []
    symbols: list[str] = []
    for entry in raw_symbols:
        if not isinstance(entry, dict):
            continue
        if entry.get("status") != "TRADING":
            continue
        symbol = entry.get("symbol")
        if isinstance(symbol, str) and symbol:
            symbols.append(symbol)
    return symbols


def _binance_fallback_option(
    query: str,
    *,
    provider: Provider,
    market_type: MarketType,
) -> list[SymbolOption]:
    symbol = query
    if market_type is MarketType.USD_M_FUTURES and not symbol.endswith("USDT"):
        symbol = f"{symbol}USDT"
    return [
        SymbolOption(
            symbol=symbol,
            label=symbol,
            provider=provider,
            market_type=market_type,
        )
    ]


class SymbolCatalog:
    def __init__(
        self,
        *,
        usd_m_client: BinanceExchangeListing | None = None,
        coin_m_client: BinanceExchangeListing | None = None,
        hyperliquid_client: HyperliquidInfoClient | None = None,
        hyperliquid_client_factory: HyperliquidClientFactory | None = None,
        yfinance_search: YFinanceSearchFactory | None = None,
    ) -> None:
        self._usd_m_client = usd_m_client
        self._coin_m_client = coin_m_client
        self._hyperliquid_client = hyperliquid_client
        self._hyperliquid_client_factory = hyperliquid_client_factory
        self._hyperliquid_client_lock = Lock()
        self._hyperliquid_symbol_cache: tuple[str, ...] | None = None
        self._yfinance_search = yfinance_search or _default_yfinance_search

    def search(self, provider: Provider, market_type: MarketType, query: str) -> list[SymbolOption]:
        normalized = _normalize_query(query)
        if not normalized:
            return []
        match (provider, market_type):
            case (Provider.BINANCE, MarketType.USD_M_FUTURES):
                return self._search_binance(
                    self._usd_m_client,
                    query=normalized,
                    provider=provider,
                    market_type=market_type,
                )
            case (Provider.BINANCE, MarketType.COIN_M_FUTURES):
                return self._search_binance(
                    self._coin_m_client,
                    query=normalized,
                    provider=provider,
                    market_type=market_type,
                )
            case (Provider.HYPERLIQUID, MarketType.PERPETUAL):
                return self._search_hyperliquid(normalized, provider, market_type)
            case (Provider.YFINANCE, MarketType.EQUITY):
                return self._yfinance_search(normalized, SYMBOL_QUERY_MAX_RESULTS)
            case _:
                return []

    def _search_binance(
        self,
        client: BinanceExchangeListing | None,
        *,
        query: str,
        provider: Provider,
        market_type: MarketType,
    ) -> list[SymbolOption]:
        if client is None:
            return _binance_fallback_option(query, provider=provider, market_type=market_type)
        try:
            payload = client.exchange_info()
        except Exception:
            return _binance_fallback_option(query, provider=provider, market_type=market_type)
        if not isinstance(payload, dict):
            return _binance_fallback_option(query, provider=provider, market_type=market_type)
        return _filter_symbols(
            _binance_trading_symbols(payload),
            query=query,
            provider=provider,
            market_type=market_type,
            limit=SYMBOL_QUERY_MAX_RESULTS,
        )

    def _search_hyperliquid(
        self,
        query: str,
        provider: Provider,
        market_type: MarketType,
    ) -> list[SymbolOption]:
        if self._resolved_hyperliquid_client() is None:
            return []
        symbols = self._hyperliquid_symbols()
        return _filter_symbols(
            symbols,
            query=query,
            provider=provider,
            market_type=market_type,
            limit=SYMBOL_QUERY_MAX_RESULTS,
        )

    def _resolved_hyperliquid_client(self) -> HyperliquidInfoClient | None:
        if self._hyperliquid_client is not None or self._hyperliquid_client_factory is None:
            return self._hyperliquid_client
        with self._hyperliquid_client_lock:
            if self._hyperliquid_client is None:
                self._hyperliquid_client = self._hyperliquid_client_factory()
        return self._hyperliquid_client

    def _hyperliquid_symbols(self) -> tuple[str, ...]:
        if self._hyperliquid_symbol_cache is not None:
            return self._hyperliquid_symbol_cache
        client = self._resolved_hyperliquid_client()
        if client is None:
            return ()
        symbols = list(self._hyperliquid_mids_for_dex(client, "").keys())
        for dex in self._hyperliquid_dexs(client):
            name = _hyperliquid_dex_name(dex)
            if name is not None:
                symbols.extend(self._hyperliquid_mids_for_dex(client, name).keys())
            symbols.extend(_hyperliquid_dex_assets(dex))
        if symbols:
            self._hyperliquid_symbol_cache = tuple(set(symbols))
            return self._hyperliquid_symbol_cache
        return ()

    @staticmethod
    def _hyperliquid_dexs(client: HyperliquidInfoClient) -> list[dict[str, object]]:
        try:
            dexs = client.perp_dexs()
        except Exception:
            return []
        return [dex for dex in dexs if isinstance(dex, dict)]

    @staticmethod
    def _hyperliquid_mids_for_dex(
        client: HyperliquidInfoClient, dex: str
    ) -> dict[str, str]:
        try:
            return client.all_mids(dex)
        except Exception:
            return {}


def _hyperliquid_dex_name(dex: dict[str, object]) -> str | None:
    name = dex.get("name")
    return name if isinstance(name, str) and name else None


def _hyperliquid_dex_assets(dex: dict[str, object]) -> list[str]:
    assets: list[str] = []
    for key in ("assetToStreamingOiCap", "assetToFundingMultiplier", "assetToFundingInterestRate"):
        entries = dex.get(key)
        if not isinstance(entries, list):
            continue
        assets.extend(_hyperliquid_asset_names(entries))
    return assets


def _hyperliquid_asset_names(entries: list[object]) -> list[str]:
    names: list[str] = []
    for entry in entries:
        if not isinstance(entry, list) or not entry:
            continue
        asset = entry[0]
        if isinstance(asset, str) and asset:
            names.append(asset)
    return names


def _default_yfinance_search(query: str, limit: int) -> list[SymbolOption]:
    import yfinance as yf

    try:
        quotes = yf.Search(
            query,
            max_results=limit,
            news_count=0,
            lists_count=0,
            include_cb=False,
            timeout=YFINANCE_TIMEOUT_SECONDS,
        ).quotes
    except Exception:
        return _yfinance_exact_fallback(query)
    options: list[SymbolOption] = []
    for quote in quotes:
        if not isinstance(quote, dict):
            continue
        symbol = quote.get("symbol")
        if not isinstance(symbol, str) or not symbol.strip():
            continue
        label = quote.get("shortname") or quote.get("longname") or symbol
        if not isinstance(label, str):
            label = symbol
        options.append(
            SymbolOption(
                symbol=symbol.strip().upper(),
                label=f"{symbol} — {label}" if label != symbol else symbol,
                provider=Provider.YFINANCE,
                market_type=MarketType.EQUITY,
            )
        )
    return options[:limit] or _yfinance_exact_fallback(query)


def _yfinance_exact_fallback(query: str) -> list[SymbolOption]:
    valid_characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-^="
    if not query or any(character not in valid_characters for character in query):
        return []
    return [
        SymbolOption(
            symbol=query,
            label=query,
            provider=Provider.YFINANCE,
            market_type=MarketType.EQUITY,
        )
    ]


def default_binance_futures_clients() -> tuple[BinanceExchangeListing, BinanceExchangeListing]:
    return (
        TradingViewBinanceClient(MarketType.USD_M_FUTURES),
        TradingViewBinanceClient(MarketType.COIN_M_FUTURES),
    )


def _default_hyperliquid_client() -> HyperliquidInfoClient:
    from hyperliquid.info import Info

    return Info(skip_ws=True, timeout=HYPERLIQUID_TIMEOUT_SECONDS)


def default_symbol_catalog() -> SymbolCatalog:
    usd_m, coin_m = default_binance_futures_clients()
    return SymbolCatalog(
        usd_m_client=usd_m,
        coin_m_client=coin_m,
        hyperliquid_client_factory=_default_hyperliquid_client,
    )
