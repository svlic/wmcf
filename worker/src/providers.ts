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

export interface SymbolOption {
  symbol: string;
  label: string;
  provider: Provider;
  market_type: MarketType;
}

type HyperliquidDex = {
  assetToStreamingOiCap?: unknown;
  assetToFundingMultiplier?: unknown;
  assetToFundingInterestRate?: unknown;
};

function symbolRank(symbol: string, query: string): [number, string] {
  const normalized = symbol.toUpperCase();
  const asset = normalized.split(":").at(-1) ?? normalized;
  if (asset === query) return [0, normalized];
  if (asset.startsWith(query)) return [1, normalized];
  return [2, normalized];
}

function compareSymbols(left: string, right: string, query: string): number {
  const leftRank = symbolRank(left, query);
  const rightRank = symbolRank(right, query);
  return leftRank[0] - rightRank[0] || leftRank[1].localeCompare(rightRank[1]);
}

function hyperliquidDexSymbols(dex: HyperliquidDex): string[] {
  const symbols: string[] = [];
  for (const key of [
    "assetToStreamingOiCap",
    "assetToFundingMultiplier",
    "assetToFundingInterestRate",
  ] as const) {
    const entries = dex[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === "string") symbols.push(entry[0]);
    }
  }
  return symbols;
}

async function queryYahooSymbols(
  provider: Provider,
  marketType: MarketType,
  query: string,
): Promise<SymbolOption[]> {
  try {
    const scan = async (field: "name" | "description") => jsonFetch(
      "https://scanner.tradingview.com/america/scan",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter: [{ left: field, operation: "match", right: query }],
          markets: ["america"],
          columns: ["name", "description", "type", "exchange"],
          range: [0, 25],
        }),
      },
    ) as Promise<{ data?: TradingViewRow[] }>;
    const results = await Promise.allSettled([scan("name"), scan("description")]);
    const rows = results.flatMap((result) =>
      result.status === "fulfilled" && Array.isArray(result.value.data) ? result.value.data : []
    );
    const optionsBySymbol: Record<string, SymbolOption> = {};
    for (const row of rows) {
      const [symbol, description, type] = row.d ?? [];
      if (typeof symbol !== "string" || !["stock", "fund"].includes(String(type))) continue;
      const normalized = symbol.toUpperCase();
      const descriptionMatches = typeof description === "string"
        && description.toUpperCase().split(/[^A-Z0-9]+/).some((word) => word.startsWith(query));
      if (!normalized.includes(query) && !descriptionMatches) continue;
      const label = typeof description === "string" && description
        ? `${symbol} — ${description}`
        : symbol;
      optionsBySymbol[normalized] = {
        symbol: normalized,
        label,
        provider,
        market_type: marketType,
      };
    }
    const options = Object.values(optionsBySymbol);
    if (options.length > 0) {
      return options
        .sort((left, right) => compareSymbols(left.symbol, right.symbol, query))
        .slice(0, 25);
    }
  } catch {
    // A valid ticker remains selectable when the upstream catalog is unavailable.
  }
  return /^[A-Z0-9.\-^=]+$/.test(query)
    ? [{ symbol: query, label: query, provider, market_type: marketType }]
    : [];
}
async function queryHyperliquidSymbols(
  provider: Provider,
  marketType: MarketType,
  query: string,
): Promise<SymbolOption[]> {
  const request = (body: Record<string, string>) => jsonFetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const [midsResult, dexsResult] = await Promise.allSettled([
    request({ type: "allMids" }),
    request({ type: "perpDexs" }),
  ]);
  const symbols = new Set<string>();
  if (midsResult.status === "fulfilled" && typeof midsResult.value === "object" && midsResult.value !== null) {
    Object.keys(midsResult.value).forEach((symbol) => symbols.add(symbol));
  }
  if (dexsResult.status === "fulfilled" && Array.isArray(dexsResult.value)) {
    for (const dex of dexsResult.value) {
      if (typeof dex !== "object" || dex === null) continue;
      hyperliquidDexSymbols(dex).forEach((symbol) => symbols.add(symbol));
    }
  }
  return [...symbols]
    .filter((symbol) => symbol.toUpperCase().includes(query))
    .sort((left, right) => compareSymbols(left, right, query))
    .slice(0, 25)
    .map((symbol) => ({ symbol, label: symbol, provider, market_type: marketType }));
}

export async function querySymbols(
  provider: Provider,
  marketType: MarketType,
  query: string,
): Promise<SymbolOption[]> {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  if (provider === "yfinance") return queryYahooSymbols(provider, marketType, q);
  if (provider === "hyperliquid") return queryHyperliquidSymbols(provider, marketType, q);
  try {
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
    return rows.flatMap((row): SymbolOption[] => {
      const [name, currency] = row.d ?? [];
      if (typeof name !== "string" || !name.endsWith(".P")) return [];
      if (expectedCurrency === null ? currency !== "USDT" && currency !== "USDC" : currency !== expectedCurrency) return [];
      const symbol = `${name.slice(0, -2)}${marketType === "coin_m_futures" ? "_PERP" : ""}`;
      return symbol.includes(q) ? [{ symbol, label: symbol, provider, market_type: marketType }] : [];
    }).sort((left, right) => compareSymbols(left.symbol, right.symbol, q)).slice(0, 25);
  } catch {
    const symbol = marketType === "usd_m_futures" && !q.endsWith("USDT") ? `${q}USDT` : q;
    return [{ symbol, label: symbol, provider, market_type: marketType }];
  }
}
