import { fixed } from "./rules";
import type { EnabledSource, MarketType, Provider } from "./types";
const PROVIDER_TIMEOUT_MS = 10_000;
const TRADINGVIEW_SCANNER_URL = "https://scanner.tradingview.com/crypto/scan";
type TradingViewRow = { s?: string; d?: unknown[] };

async function tradingViewScan(payload: Record<string, unknown>): Promise<TradingViewRow[]> {
  const result = await jsonFetch(TRADINGVIEW_SCANNER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }) as { data?: TradingViewRow[] };
  if (!Array.isArray(result.data)) throw new Error("TradingView scanner response data is not a list");
  return result.data;
}


export interface PriceResult { ok: true; price: string; path: string }
export interface PriceError { ok: false; error: string }
export type PollResult = PriceResult | PriceError;

async function jsonFetch(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function fetchPrice(source: EnabledSource): Promise<PollResult> {
  try {
    if (source.provider === "binance") {
      const symbol = source.symbol.endsWith("_PERP") ? source.symbol.slice(0, -5) : source.symbol;
      const ticker = `BINANCE:${symbol}.P`;
      const rows = await tradingViewScan({
        symbols: { tickers: [ticker], query: { types: [] } },
        columns: ["close"],
      });
      const row = rows.find((item) => item.s === ticker);
      const price = row?.d?.[0];
      if (typeof price !== "string" && typeof price !== "number") throw new Error("price missing");
      return { ok: true, price: fixed(String(price)), path: "tradingview.close" };
    }
    if (source.provider === "hyperliquid") {
      const dex = source.symbol.includes(":") ? source.symbol.split(":", 1)[0] : "";
      const payload = await jsonFetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids", dex }) }) as Record<string, unknown>;
      const value = payload[source.symbol];
      if (typeof value !== "string" && typeof value !== "number") throw new Error("price missing");
      return { ok: true, price: fixed(String(value)), path: "all_mids" };
    }
    const payload = await jsonFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(source.symbol)}?interval=1m&range=1d`) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number }, indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
    const result = payload.chart?.result?.[0];
    let value = result?.meta?.regularMarketPrice;
    if (value == null) value = [...(result?.indicators?.quote?.[0]?.close ?? [])].reverse().find((item): item is number => item != null);
    if (value == null) throw new Error("price missing");
    return { ok: true, price: fixed(String(value)), path: "chart.regularMarketPrice" };
  } catch (error) { return { ok: false, error: `provider_error: ${error instanceof Error ? error.message : "unknown provider error"}`.slice(0, 500) }; }
}

export async function querySymbols(provider: Provider, marketType: MarketType, query: string): Promise<Array<{ symbol: string; label: string; provider: Provider; market_type: MarketType }>> {
  const q = query.trim().toUpperCase(); if (!q) return [];
  try {
    if (provider === "yfinance") {
      const payload = await jsonFetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=25&newsCount=0`) as { quotes?: Array<{ symbol?: string; shortname?: string; longname?: string }> };
      return (payload.quotes ?? []).filter((x): x is { symbol: string; shortname?: string; longname?: string } => typeof x.symbol === "string").slice(0, 25).map((x) => ({ symbol: x.symbol.toUpperCase(), label: `${x.symbol} — ${x.shortname ?? x.longname ?? x.symbol}`, provider, market_type: marketType }));
    }
    if (provider === "hyperliquid") {
      const payload = await jsonFetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }) }) as Record<string, unknown>;
      return Object.keys(payload).filter((symbol) => symbol.toUpperCase().includes(q)).sort().slice(0, 25).map((symbol) => ({ symbol, label: symbol, provider, market_type: marketType }));
    }
    const expectedCurrency = marketType === "coin_m_futures" ? "USD" : null;
    const rows = await tradingViewScan({
      filter: [
        { left: "exchange", operation: "equal", right: "BINANCE" },
        { left: "type", operation: "equal", right: "swap" },
      ],
      markets: ["crypto"],
      columns: ["name", "currency"],
      range: [0, 2000],
    });
    return rows.flatMap((row) => {
      const [name, currency] = row.d ?? [];
      if (typeof name !== "string" || !name.endsWith(".P")) return [];
      if (expectedCurrency === null ? currency !== "USDT" && currency !== "USDC" : currency !== expectedCurrency) return [];
      const symbol = `${name.slice(0, -2)}${marketType === "coin_m_futures" ? "_PERP" : ""}`;
      return symbol.includes(q) ? [{ symbol, label: symbol, provider, market_type: marketType }] : [];
    }).sort((a, b) => a.symbol.localeCompare(b.symbol)).slice(0, 25);
  } catch { return provider === "binance" ? [{ symbol: marketType === "usd_m_futures" && !q.endsWith("USDT") ? `${q}USDT` : q, label: marketType === "usd_m_futures" && !q.endsWith("USDT") ? `${q}USDT` : q, provider, market_type: marketType }] : []; }
}
