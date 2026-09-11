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

describe("production symbol search", () => {
  it("returns Yahoo stock matches from the TradingView equity catalog", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { filter: Array<{ left: string }> };
      const descriptionSearch = body.filter[0]?.left === "description";
      const data = descriptionSearch
        ? [
            { s: "NASDAQ:MSTX", d: ["MSTX", "Defiance Daily Target 2x Long MSTR ETF", "fund", "NASDAQ"] },
            { s: "NASDAQ:MSTU", d: ["MSTU", "T-Rex 2X Long MSTR Daily Target ETF", "fund", "NASDAQ"] },
            { s: "OTC:AFIIQ", d: ["AFIIQ", "Armstrong Flooring, Inc.", "stock", "OTC"] },
          ]
        : [{ s: "NASDAQ:MSTR", d: ["MSTR", "Strategy Inc Class A", "stock", "NASDAQ"] }];
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(querySymbols("yfinance", "equity", "mstr")).resolves.toEqual([
      {
        symbol: "MSTR",
        label: "MSTR — Strategy Inc Class A",
        provider: "yfinance",
        market_type: "equity",
      },
      {
        symbol: "MSTU",
        label: "MSTU — T-Rex 2X Long MSTR Daily Target ETF",
        provider: "yfinance",
        market_type: "equity",
      },
      {
        symbol: "MSTX",
        label: "MSTX — Defiance Daily Target 2x Long MSTR ETF",
        provider: "yfinance",
        market_type: "equity",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://scanner.tradingview.com/america/scan",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          filter: [{ left: "name", operation: "match", right: "MSTR" }],
          markets: ["america"],
          columns: ["name", "description", "type", "exchange"],
          range: [0, 25],
        }),
      }),
    );
  });

  it("keeps an exact Yahoo ticker selectable when the catalog is rate limited", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })));

    await expect(querySymbols("yfinance", "equity", "CRCL")).resolves.toEqual([
      {
        symbol: "CRCL",
        label: "CRCL",
        provider: "yfinance",
        market_type: "equity",
      },
    ]);
  });

  it("returns HIP-3 MSTR and CRCL symbols from Hyperliquid DEX metadata", async () => {
    const mids = { BTC: "60000", HMSTR: "1" };
    const dexs = [
      null,
      {
        name: "xyz",
        assetToStreamingOiCap: [
          ["xyz:MSTR", "100000000.0"],
          ["xyz:CRCL", "150000000.0"],
        ],
        assetToFundingMultiplier: [["xyz:MSTR", "0.5"]],
      },
      {
        name: "flx",
        assetToFundingInterestRate: [["flx:CRCL", "0.0"]],
      },
    ];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { type: string };
      return new Response(JSON.stringify(body.type === "perpDexs" ? dexs : mids), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mstr = await querySymbols("hyperliquid", "perpetual", "MSTR");
    const crcl = await querySymbols("hyperliquid", "perpetual", "CRCL");

    expect(mstr.map((option) => option.symbol)).toEqual(["xyz:MSTR", "HMSTR"]);
    expect(crcl.map((option) => option.symbol)).toEqual(["flx:CRCL", "xyz:CRCL"]);
  });
});
