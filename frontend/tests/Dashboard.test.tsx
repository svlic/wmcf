import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../src/pages/dashboard/Dashboard";
import { apiClient } from "../src/api/client";
import { bumpInstrumentRevision } from "../src/state/instrumentRevision";
import type { InstrumentWithMappings } from "../src/api/client";

vi.mock("../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/client")>();
  return {
    ...actual,
    apiClient: {
      getRuntime: vi.fn(),
      refreshPrices: vi.fn(),
      getLatestPrices: vi.fn(),
      getInstruments: vi.fn(),
    },
  };
});

const emptyRuntime = {
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
};

describe("Dashboard", () => {
  beforeEach(() => {
    vi.mocked(apiClient.getRuntime).mockClear();
    vi.mocked(apiClient.refreshPrices).mockClear();
    vi.mocked(apiClient.getLatestPrices).mockClear();
    vi.mocked(apiClient.getInstruments).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    vi.mocked(apiClient.getRuntime).mockImplementation(() => new Promise(() => {}));
    vi.mocked(apiClient.getLatestPrices).mockImplementation(() => new Promise(() => {}));
    vi.mocked(apiClient.getInstruments).mockImplementation(() => new Promise(() => {}));

    render(<Dashboard />);

    expect(screen.getByRole("status")).toHaveTextContent("正在加载仪表盘数据...");
  });

  it("shows error state when API fails", async () => {
    vi.mocked(apiClient.getRuntime).mockRejectedValue(new Error("Network error"));
    vi.mocked(apiClient.getLatestPrices).mockResolvedValue([]);
    vi.mocked(apiClient.getInstruments).mockResolvedValue([]);

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("发生未知错误。");
    });
  });

  it("shows empty state when no price data exists", async () => {
    vi.mocked(apiClient.getRuntime).mockResolvedValue(emptyRuntime);
    vi.mocked(apiClient.getLatestPrices).mockResolvedValue([]);
    vi.mocked(apiClient.getInstruments).mockResolvedValue([]);

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("暂无价格数据。")).toBeInTheDocument();
    });
    expect(screen.getByText("Cron 调度")).toBeInTheDocument();
    expect(screen.getByText("已运行")).toBeInTheDocument();
  });

  it("shows that Cloudflare Cron has not run yet", async () => {
    vi.mocked(apiClient.getRuntime).mockResolvedValue({ ...emptyRuntime, scheduler_ready: false });
    vi.mocked(apiClient.getLatestPrices).mockResolvedValue([]);
    vi.mocked(apiClient.getInstruments).mockResolvedValue([]);

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("等待首次触发")).toBeInTheDocument();
    });
    expect(screen.queryByText("暂无最近告警。")).not.toBeInTheDocument();
  });

  it("renders latest prices in the full-width table when data exists", async () => {
    vi.mocked(apiClient.getRuntime).mockResolvedValue({
      ...emptyRuntime,
      telegram_ready: true,
    });
    vi.mocked(apiClient.getInstruments).mockResolvedValue([
      {
        id: 1,
        name: "Bitcoin",
        enabled: true,
        alert_mode: "static",
        supports: ["90000"],
        resistances: ["100000"],
        high_water: null,
        fixed_drawdown: null,
        near_support_threshold: "0.01",
        risk_reward_threshold: "2.0",
        source_mappings: [
          {
            id: 1,
            provider: "binance",
            market_type: "usd_m_futures",
            symbol: "BTCUSDT",
            enabled: true,
          },
        ],
      },
    ] satisfies readonly InstrumentWithMappings[]);
    vi.mocked(apiClient.getLatestPrices).mockResolvedValue([
      {
        instrument_id: 1,
        instrument_name: "Bitcoin",
        source_mapping_id: 1,
        provider: "binance",
        market_type: "usd_m_futures",
        symbol: "BTCUSDT",
        last_price: "95000.50",
        last_observed_at: "2026-06-30T12:00:00Z",
        last_error: null,
        support_breached: false,
        resistance_broken: false,
      },
    ]);

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("价格每 2 分钟自动刷新")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /价格监控/ })).toBeInTheDocument();
      expect(screen.getByText("Bitcoin")).toBeInTheDocument();
      expect(screen.getByText("90000.00")).toBeInTheDocument();
      expect(screen.getByText("支撑")).toBeInTheDocument();
      expect(screen.getByText("Binance（TradingView 数据） · USD-M 合约 · BTCUSDT")).toBeInTheDocument();
      expect(screen.getByText("95000.50")).toBeInTheDocument();
      expect(screen.getAllByText("5.26%").length).toBe(2);
      expect(screen.getByText("1.00")).toBeInTheDocument();
    });
    expect(screen.queryByText("接近支撑")).not.toBeInTheDocument();
  });

  it("uses current instrument config when latest price metadata is stale", async () => {
    vi.mocked(apiClient.getRuntime).mockResolvedValue(emptyRuntime);
    vi.mocked(apiClient.getInstruments).mockResolvedValue([
      {
        id: 1,
        name: "Bitcoin Updated",
        enabled: true,
        alert_mode: "static",
        supports: ["91000"],
        resistances: ["101000"],
        high_water: null,
        fixed_drawdown: null,
        near_support_threshold: "0.01",
        risk_reward_threshold: "2.0",
        source_mappings: [
          {
            id: 2,
            provider: "hyperliquid",
            market_type: "perpetual",
            symbol: "BTC",
            enabled: true,
          },
        ],
      },
    ] satisfies readonly InstrumentWithMappings[]);
    vi.mocked(apiClient.getLatestPrices).mockResolvedValue([
      {
        instrument_id: 1,
        instrument_name: "Bitcoin Old",
        source_mapping_id: 1,
        provider: "binance",
        market_type: "usd_m_futures",
        symbol: "BTCUSDT",
        last_price: "95000.50",
        last_observed_at: "2026-06-30T12:00:00Z",
        last_error: null,
        support_breached: false,
        resistance_broken: false,
      },
      {
        instrument_id: 1,
        instrument_name: "Bitcoin Old",
        source_mapping_id: 2,
        provider: "binance",
        market_type: "usd_m_futures",
        symbol: "BTCUSDT",
        last_price: "95010.50",
        last_observed_at: "2026-06-30T12:01:00Z",
        last_error: null,
        support_breached: false,
        resistance_broken: false,
      },
    ]);

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("Bitcoin Updated")).toBeInTheDocument();
      expect(screen.getByText("Hyperliquid · 永续合约 · BTC")).toBeInTheDocument();
      expect(screen.getByText("95010.50")).toBeInTheDocument();
    });
    expect(screen.queryByText("Bitcoin Old")).not.toBeInTheDocument();
    expect(screen.queryByText("Binance（TradingView 数据） · USD-M 合约 · BTCUSDT")).not.toBeInTheDocument();
    expect(screen.queryByText("95000.50")).not.toBeInTheDocument();
  });

  it("hides paused instruments from price monitor", async () => {
    vi.mocked(apiClient.getRuntime).mockResolvedValue(emptyRuntime);
    vi.mocked(apiClient.getInstruments).mockResolvedValue([
      {
        id: 1,
        name: "Bitcoin",
        enabled: false,
        alert_mode: "static",
        supports: ["90000"],
        resistances: ["100000"],
        high_water: null,
        fixed_drawdown: null,
        near_support_threshold: "0.01",
        risk_reward_threshold: "2.0",
        source_mappings: [
          {
            id: 1,
            provider: "binance",
            market_type: "usd_m_futures",
            symbol: "BTCUSDT",
            enabled: true,
          },
        ],
      },
    ] satisfies readonly InstrumentWithMappings[]);
    vi.mocked(apiClient.getLatestPrices).mockResolvedValue([
      {
        instrument_id: 1,
        instrument_name: "Bitcoin",
        source_mapping_id: 1,
        provider: "binance",
        market_type: "usd_m_futures",
        symbol: "BTCUSDT",
        last_price: "95000.50",
        last_observed_at: "2026-06-30T12:00:00Z",
        last_error: null,
        support_breached: false,
        resistance_broken: false,
      },
    ]);

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("价格每 2 分钟自动刷新")).toBeInTheDocument();
      expect(screen.getByText("暂无价格数据。")).toBeInTheDocument();
    });
    expect(screen.queryByText("95000.50")).not.toBeInTheDocument();
    expect(screen.queryByText("Binance（TradingView 数据） · USD-M 合约 · BTCUSDT")).not.toBeInTheDocument();
  });

  it("refetches dashboard data when instrument configuration changes", async () => {
    vi.mocked(apiClient.getRuntime).mockResolvedValue(emptyRuntime);
    vi.mocked(apiClient.getInstruments).mockResolvedValue([]);
    vi.mocked(apiClient.getLatestPrices).mockResolvedValue([]);

    render(<Dashboard />);

    await waitFor(() => {
      expect(apiClient.getInstruments).toHaveBeenCalledTimes(1);
    });

    bumpInstrumentRevision();

    await waitFor(() => {
      expect(apiClient.getInstruments).toHaveBeenCalledTimes(2);
      expect(apiClient.getLatestPrices).toHaveBeenCalledTimes(2);
    });
  });
  it("polls providers before reloading prices when refresh is clicked", async () => {
    const instrument = {
      id: 1,
      name: "Bitcoin",
      enabled: true,
      alert_mode: "static" as const,
      supports: ["90"],
      resistances: ["110"],
      high_water: null,
      fixed_drawdown: null,
      near_support_threshold: "0.01",
      risk_reward_threshold: "2.0",
      source_mappings: [{
        id: 1,
        provider: "binance",
        market_type: "usd_m_futures",
        symbol: "BTCUSDT",
        enabled: true,
      }],
    } satisfies InstrumentWithMappings;
    const refreshedPrice = {
      instrument_id: 1,
      instrument_name: "Bitcoin",
      source_mapping_id: 1,
      provider: "binance",
      market_type: "usd_m_futures",
      symbol: "BTCUSDT",
      last_price: "101",
      last_observed_at: "2026-09-11T12:00:00Z",
      last_error: null,
      support_breached: false,
      resistance_broken: false,
    };
    vi.mocked(apiClient.getRuntime).mockResolvedValue(emptyRuntime);
    vi.mocked(apiClient.getInstruments).mockResolvedValue([instrument]);
    vi.mocked(apiClient.getLatestPrices)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([refreshedPrice]);
    vi.mocked(apiClient.refreshPrices).mockResolvedValue();

    render(<Dashboard />);
    const refreshButton = await screen.findByRole("button", { name: "刷新数据" });

    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(apiClient.refreshPrices).toHaveBeenCalledOnce();
      expect(screen.getByText("101.00")).toBeInTheDocument();
    });
    expect(vi.mocked(apiClient.refreshPrices).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(apiClient.getLatestPrices).mock.invocationCallOrder[1]!,
    );
  });

});