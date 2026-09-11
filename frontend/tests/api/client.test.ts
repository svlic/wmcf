import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, serializeInstrumentLevelsForApi } from "../../src/api/client";

describe("ApiClient", () => {
  const client = new ApiClient();

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("throws ApiError on non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
    );

    await expect(client.getRuntime()).rejects.toThrow(ApiError);
  });

  it("throws ApiError on invalid response schema", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ invalid: "data" }), { status: 200 }),
    );

    await expect(client.getRuntime()).rejects.toThrow(ApiError);
  });

  it("sets no-store cache policy on API requests", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        scheduler_ready: true,
        providers_ready: true,
        telegram_ready: false,
        enabled_sources: 0,
        polled_sources: 0,
        observations_written: 0,
        source_errors: 0,
        alert_events_created: 0,
        telegram_deliveries_attempted: 0,
        last_tick_started_at: null,
        last_tick_finished_at: null,
      }), { status: 200 }),
    );

    await client.getRuntime();

    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("posts manual refresh and waits for its empty response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    await client.refreshPrices();

    expect(fetch).toHaveBeenCalledWith(
      "/api/prices/refresh",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
  });

  it("parses historical support and resistance crossing flags", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            instrument_id: 1,
            instrument_name: "Bitcoin",
            source_mapping_id: 1,
            provider: "binance",
            market_type: "usd_m_futures",
            symbol: "BTCUSDT",
            last_price: "100",
            last_observed_at: "2026-06-30T12:00:00Z",
            last_error: null,
            support_breached: true,
            resistance_broken: false,
          },
        ]),
        { status: 200 },
      ),
    );

    const result = await client.getLatestPrices();

    expect(result[0]).toMatchObject({ support_breached: true, resistance_broken: false });
  });

  it("returns parsed data on success", async () => {
    const mockData = {
      scheduler_ready: true,
      providers_ready: true,
      telegram_ready: false,
      enabled_sources: 2,
      polled_sources: 2,
      observations_written: 1,
      source_errors: 0,
      alert_events_created: 0,
      telegram_deliveries_attempted: 0,
      last_tick_started_at: "2026-06-30T12:00:00",
      last_tick_finished_at: "2026-06-30T12:00:01",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockData), { status: 200 }),
    );

    const result = await client.getRuntime();
    expect(result).toEqual(mockData);
  });

  it("serializeInstrumentLevelsForApi removes thresholds whose dependent levels are unavailable", () => {
    const payload = {
      name: "X",
      enabled: true,
      supports: [],
      resistances: ["200"],
      near_support_threshold: "invalid stale value",
      risk_reward_threshold: "2",
      source_mappings: [{ provider: "yfinance", market_type: "equity", symbol: "AAPL", enabled: true }],
    };
    expect(serializeInstrumentLevelsForApi(payload)).toMatchObject({
      supports: [],
      resistances: ["200"],
      near_support_threshold: null,
      risk_reward_threshold: null,
    });
  });

  it("createInstrument sends null for empty support", async () => {
    const created = {
      id: 1,
      name: "X",
      enabled: true,
      alert_mode: "static",
      supports: [],
      resistances: ["200.0000000000"],
      high_water: null,
      fixed_drawdown: null,
      near_support_threshold: null,
      risk_reward_threshold: null,
      source_mappings: [],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(created), { status: 201 }),
    );

    await client.createInstrument({
      name: "X",
      enabled: true,
      supports: [],
      resistances: ["200"],
      near_support_threshold: "0.02",
      risk_reward_threshold: "2",
      source_mappings: [{ provider: "yfinance", market_type: "equity", symbol: "AAPL", enabled: true }],
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      supports: string[];
      resistances: string[];
      near_support_threshold: string | null;
      risk_reward_threshold: string | null;
    };
    expect(body).toMatchObject({
      supports: [],
      resistances: ["200"],
      near_support_threshold: null,
      risk_reward_threshold: null,
    });
  });

  it("getInstrument resolves from list response", async () => {
    const list = [
      {
        id: 1,
        name: "Bitcoin",
        enabled: true,
        alert_mode: "static",
        supports: ["1"],
        resistances: ["2"],
        high_water: null,
        fixed_drawdown: null,
        near_support_threshold: "0.01",
        risk_reward_threshold: "1",
        source_mappings: [],
      },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(list), { status: 200 }),
    );

    const result = await client.getInstrument(1);
    expect(result.name).toBe("Bitcoin");
    expect(fetch).toHaveBeenCalledWith(
      "/api/instruments",
      expect.any(Object),
    );
  });

  it("always uses same-origin API paths", async () => {
    const runtimeResponse = {
      scheduler_ready: false,
      providers_ready: false,
      telegram_ready: false,
      enabled_sources: 0,
      polled_sources: 0,
      observations_written: 0,
      source_errors: 0,
      alert_events_created: 0,
      telegram_deliveries_attempted: 0,
      last_tick_started_at: null,
      last_tick_finished_at: null,
    };
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(runtimeResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const sameOriginClient = new ApiClient();

    await sameOriginClient.getRuntime();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime",
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("surfaces API error detail for failed telegram test requests", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Telegram delivery failed with HTTP 401." }), {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );
    const sameOriginClient = new ApiClient();

    await expect(sameOriginClient.testTelegram()).rejects.toEqual(
      new ApiError(502, "Telegram delivery failed with HTTP 401."),
    );
  });
});
