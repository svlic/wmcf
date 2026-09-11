import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../api/client";
import { SymbolInput } from "../pages/instruments/SymbolInput";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual("../api/client");
  return {
    ...actual,
    apiClient: {
      querySymbols: vi.fn(),
    },
  };
});

describe("SymbolInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.querySymbols).mockResolvedValue([
      {
        symbol: "BTCUSDT",
        label: "BTCUSDT",
        provider: "binance",
        market_type: "usd_m_futures",
      },
    ]);
  });

  async function runDebounce() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
  }

  it("keeps existing symbol suggestions closed until the input is focused", async () => {
    vi.useFakeTimers();
    render(
      <SymbolInput
        id="symbol-0"
        provider="binance"
        marketType="usd_m_futures"
        value="BTCUSDT"
        onChange={vi.fn()}
      />,
    );

    const input = screen.getByRole("combobox", { name: "" });
    expect(apiClient.querySymbols).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-expanded", "false");

    fireEvent.focus(input);
    expect(apiClient.querySymbols).not.toHaveBeenCalled();
    await runDebounce();

    expect(apiClient.querySymbols).toHaveBeenCalledWith(
      "binance",
      "usd_m_futures",
      "BTCUSDT",
      expect.any(AbortSignal),
    );
    expect(screen.getByRole("listbox", { name: "Symbol 候选项" })).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "true");
    vi.useRealTimers();
  });

  it("queries only the final Yahoo symbol after rapid typing", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender } = render(
      <SymbolInput
        id="symbol-0"
        provider="yfinance"
        marketType="equity"
        value=""
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("combobox", { name: "" });
    fireEvent.focus(input);

    for (const value of ["M", "MS", "MST", "MSTR"]) {
      fireEvent.change(input, { target: { value } });
      rerender(
        <SymbolInput
          id="symbol-0"
          provider="yfinance"
          marketType="equity"
          value={value}
          onChange={onChange}
        />,
      );
    }

    expect(apiClient.querySymbols).not.toHaveBeenCalled();
    await runDebounce();

    expect(apiClient.querySymbols).toHaveBeenCalledTimes(1);
    expect(apiClient.querySymbols).toHaveBeenCalledWith(
      "yfinance",
      "equity",
      "MSTR",
      expect.any(AbortSignal),
    );
    vi.useRealTimers();
  });

  it("shows the Hyperliquid HIP-3 symbol returned for MSTR", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.querySymbols).mockResolvedValue([
      {
        symbol: "xyz:MSTR",
        label: "xyz:MSTR",
        provider: "hyperliquid",
        market_type: "perpetual",
      },
    ]);
    const { rerender } = render(
      <SymbolInput
        id="symbol-1"
        provider="hyperliquid"
        marketType="perpetual"
        value=""
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", { name: "" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "MSTR" } });
    rerender(
      <SymbolInput
        id="symbol-1"
        provider="hyperliquid"
        marketType="perpetual"
        value="MSTR"
        onChange={vi.fn()}
      />,
    );

    await runDebounce();

    expect(screen.getByRole("option", { name: "xyz:MSTR" })).toBeInTheDocument();
    vi.useRealTimers();
  });
});
