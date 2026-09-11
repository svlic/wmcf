import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiError } from "../../api/client";
import type {
  InstrumentWithMappings,
  RecentAlert,
  RuntimeResponse,
  SourceError,
} from "../../api/client";
import {
  formatAlertKindLabel,
  formatDateTime,
  formatDecimal,
  formatSourceLabel,
} from "../../utils/format";

type OpsState = "loading" | "ready" | "error";

async function fetchOpsBundle(signal?: AbortSignal) {
  const [runtimeData, errorsData, alertsData, instrumentsData] = await Promise.all([
    apiClient.getRuntime(signal),
    apiClient.getSourceErrors(signal),
    apiClient.getRecentAlerts(signal),
    apiClient.getInstruments(signal),
  ]);
  return {
    runtime: runtimeData,
    errors: errorsData,
    alerts: alertsData,
    instruments: instrumentsData,
  };
}

export function OpsPanel() {
  const [state, setState] = useState<OpsState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeResponse | null>(null);
  const [errors, setErrors] = useState<readonly SourceError[]>([]);
  const [alerts, setAlerts] = useState<readonly RecentAlert[]>([]);
  const [instruments, setInstruments] = useState<readonly InstrumentWithMappings[]>([]);

  const [testStatus, setTestStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const loadData = useCallback(async (signal?: AbortSignal, options?: { refresh?: boolean }) => {
    const isRefresh = options?.refresh === true;
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setState("loading");
    }
    try {
      const bundle = await fetchOpsBundle(signal);
      if (signal?.aborted) return;
      setRuntime(bundle.runtime);
      setErrors(bundle.errors);
      setAlerts(bundle.alerts);
      setInstruments(bundle.instruments);
      setState("ready");
      setErrorMessage(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setState("error");
      if (error instanceof ApiError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage("发生未知错误。");
      }
    } finally {
      if (!signal?.aborted) {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  const handleRefresh = () => {
    void loadData(undefined, { refresh: true });
  };

  const handleTestTelegram = async () => {
    setTestStatus("sending");
    setTestMessage(null);
    try {
      const response = await apiClient.testTelegram();
      if (response.sent) {
        setTestStatus("success");
        setTestMessage("测试消息已发送。");
      } else {
        setTestStatus("error");
        setTestMessage(response.detail || "测试消息发送失败。");
      }
    } catch (error) {
      setTestStatus("error");
      if (error instanceof ApiError) {
        setTestMessage(error.message);
      } else {
        setTestMessage("发生未知错误。");
      }
    }
  };

  if (state === "loading") {
    return (
      <section className="panel loading-panel" aria-labelledby="ops-loading-title">
        <h2 id="ops-loading-title" className="visually-hidden">
          告警与诊断
        </h2>
        <div role="status" aria-live="polite" className="muted-text">
          正在加载...
        </div>
        <div className="skeleton skeleton-line skeleton-line--medium" aria-hidden="true" />
        <div className="skeleton skeleton-line" aria-hidden="true" />
        <div className="skeleton skeleton-block" aria-hidden="true" />
      </section>
    );
  }

  if (state === "error") {
    return (
      <section className="panel" aria-labelledby="ops-error-title">
        <h2 id="ops-error-title" className="visually-hidden">
          告警与诊断
        </h2>
        <div className="error-banner" role="alert">
          <p className="error-text">{errorMessage ?? "加载失败。"}</p>
        </div>
        <button type="button" className="button primary" onClick={handleRefresh}>
          重试加载
        </button>
      </section>
    );
  }

  return (
    <div className="ops-layout">
      <header className="ops-layout__toolbar">
        <p className="muted-text ops-layout__hint">
          最近告警、Telegram 测试与各数据源最近错误。
        </p>
        <button
          type="button"
          className="button small"
          onClick={handleRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          {refreshing ? "刷新中..." : "刷新数据"}
        </button>
      </header>

      <section className="panel ops-panel--wide" aria-labelledby="recent-alerts-title">
        <h2 id="recent-alerts-title" className="panel-title">
          最近告警
        </h2>
        <p className="muted-text panel-title-sub">
          规则触发后写入的近期告警记录。
        </p>
        {alerts.length === 0 ? (
          <p className="empty-state">暂无最近告警。</p>
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>标的</th>
                  <th>规则</th>
                  <th>价格</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => (
                  <tr key={alert.id}>
                    <td>{formatDateTime(alert.triggered_at)}</td>
                    <td>
                      {instruments.find((item) => item.id === alert.instrument_id)?.name ??
                        String(alert.instrument_id)}
                    </td>
                    <td>{formatAlertKindLabel(alert.alert_kind)}</td>
                    <td className="price-cell">{formatDecimal(alert.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel ops-panel--wide" aria-labelledby="telegram-test-title">
        <h2 id="telegram-test-title" className="panel-title">
          测试告警
        </h2>
        <p className="muted-text panel-title-sub">
          向已配置的 Telegram 会话发送一条测试消息，确认推送通道可用。
        </p>
        {!runtime?.telegram_ready ? (
          <p className="muted-text">
            尚未配置。请在“系统设置”中启用并填写 Telegram 凭据。
          </p>
        ) : (
          <div className="test-actions">
            <button
              className="button primary"
              onClick={() => handleTestTelegram()}
              disabled={testStatus === "sending"}
            >
              {testStatus === "sending" ? "发送中..." : "发送测试告警"}
            </button>
            {testStatus === "success" && (
              <p className="success-text" role="status">
                {testMessage}
              </p>
            )}
            {testStatus === "error" && (
              <p className="error-text" role="alert">
                {testMessage}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="panel ops-panel--wide" aria-labelledby="source-errors-title">
        <h2 id="source-errors-title" className="panel-title">
          数据源错误
        </h2>
        {errors.length === 0 ? (
          <p className="empty-state">暂无数据源错误。</p>
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>标的</th>
                  <th>来源</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((error) => (
                  <tr key={error.source_mapping_id}>
                    <td>{formatDateTime(error.last_observed_at)}</td>
                    <td>{error.instrument_name}</td>
                    <td>{formatSourceLabel(error.provider, error.market_type, error.symbol)}</td>
                    <td className="error-cell">{error.last_error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}