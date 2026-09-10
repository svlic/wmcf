import { fixed } from "./rules";
import type { EnabledSource, MarketType, Provider } from "./types";
const PROVIDER_TIMEOUT_MS = 10_000;


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
      const base = source.market_type === "coin_m_futures" ? "https://dapi.binance.com" : "https://fapi.binance.com";
      const prefix = source.market_type === "coin_m_futures" ? "/dapi/v1" : "/fapi/v1";
      const mark = await jsonFetch(`${base}${prefix}/premiumIndex?symbol=${encodeURIComponent(source.symbol)}`) as Record<string, unknown>;
      const markPrice = mark.markPrice;
      if (typeof markPrice === "string" || typeof markPrice === "number") return { ok: true, price: fixed(String(markPrice)), path: "mark_price.markPrice" };
      const ticker = await jsonFetch(`${base}${prefix}/ticker/price?symbol=${encodeURIComponent(source.symbol)}`) as Record<string, unknown>;
      const tickerPrice = ticker.price;
      if (typeof tickerPrice !== "string" && typeof tickerPrice !== "number") throw new Error("price missing");
      return { ok: true, price: fixed(String(tickerPrice)), path: "ticker_price.price" };
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
    const base = marketType === "coin_m_futures" ? "https://dapi.binance.com/dapi/v1/exchangeInfo" : "https://fapi.binance.com/fapi/v1/exchangeInfo";
    const payload = await jsonFetch(base) as { symbols?: Array<{ symbol?: string; status?: string }> };
    return (payload.symbols ?? []).filter((x): x is { symbol: string; status?: string } => x.status === "TRADING" && typeof x.symbol === "string" && x.symbol.includes(q)).sort((a, b) => a.symbol.localeCompare(b.symbol)).slice(0, 25).map((x) => ({ symbol: x.symbol, label: x.symbol, provider, market_type: marketType }));
  } catch { return provider === "binance" ? [{ symbol: marketType === "usd_m_futures" && !q.endsWith("USDT") ? `${q}USDT` : q, label: marketType === "usd_m_futures" && !q.endsWith("USDT") ? `${q}USDT` : q, provider, market_type: marketType }] : []; }
}
