import { marketTypeLabel } from "./marketTypes";

const PROVIDER_LABELS: Record<string, string> = {
  yfinance: "Yahoo Finance",
  binance: "Binance（TradingView 数据）",
  hyperliquid: "Hyperliquid",
};

const ALERT_KIND_LABELS: Record<string, string> = {
  near_support: "接近支撑",
  risk_reward: "风险回报",
  resistance_breakout: "突破阻力",
  support_breach: "跌破支撑",
};


export function formatSourceLabel(provider: string, marketType: string, symbol: string): string {
  return `${PROVIDER_LABELS[provider] ?? provider} · ${marketTypeLabel(marketType)} · ${symbol}`;
}

export function formatAlertKindLabel(kind: string): string {
  return ALERT_KIND_LABELS[kind] ?? kind;
}

export const DISPLAY_TIME_ZONE = "Asia/Shanghai";
const TIME_ZONE_SUFFIX = /(Z|[+-]\d{2}:\d{2})$/i;

export function formatDecimal(value: string, fractionDigits = 2): string {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return value;
  }
  return numericValue.toFixed(fractionDigits);
}

export function formatOptionalLevel(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "未设置";
  }
  return formatDecimal(value);
}

export function formatLevels(values: readonly string[]): string {
  return values.length === 0 ? "未设置" : values.map((value) => formatDecimal(value)).join("、");
}

export function formatDateTime(iso: string): string {
  const date = new Date(TIME_ZONE_SUFFIX.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return iso;
  const formatted = date.toLocaleString("zh-CN", {
    timeZone: DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${formatted} UTC+8`;
}