import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPrice, querySymbols } from "../src/providers";

afterEach(() => vi.unstubAllGlobals());

const SOURCE = {
  id: 1,
  instrument_id: 1,
  provider: "binance" as const,
  market_type: "usd_m_futures" as const,
  symbol: "BTCUSDT",
  enabled: 1,
  instrument_name: "Bitcoin",
  alert_mode: "static" as const,
  supports: "[]",
  resistances: "[]",
  high_water: null,
  fixed_drawdown: null,
  near_support_threshold: null,
  risk_reward_threshold: null,
  rule_cycle_started_at: "2026-09-11T00:00:00Z",
};

describe("TradingView-backed Binance mappings", () => {
  it("fetches the Binance USD-M quote through TradingView", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ s: "BINANCE:BTCUSDT.P", d: [60321.42] }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPrice(SOURCE);

    expect(result).toEqual({ ok: true, price: "60321.4200000000", path: "tradingview.close" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://scanner.tradingview.com/crypto/scan",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          symbols: { tickers: ["BINANCE:BTCUSDT.P"], query: { types: [] } },
          columns: ["close"],
        }),
      }),
    );
  });

  it("maps TradingView Binance inverse swaps to the existing COIN-M symbol form", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { s: "BINANCE:BTCUSDT.P", d: ["BTCUSDT.P", "USDT"] },
        { s: "BINANCE:BTCUSD.P", d: ["BTCUSD.P", "USD"] },
      ],
    }), { status: 200 })));

    await expect(querySymbols("binance", "coin_m_futures", "btc")).resolves.toEqual([
      { symbol: "BTCUSD_PERP", label: "BTCUSD_PERP", provider: "binance", market_type: "coin_m_futures" },
    ]);
  });
});
