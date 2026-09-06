import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Route, Switch, Link, useLocation } from "wouter";
import { apiClient, ApiError } from "./api/client";
import { InstrumentList } from "./pages/instruments/InstrumentList";
import { InstrumentCreate } from "./pages/instruments/InstrumentForm";
import { InstrumentEdit } from "./pages/instruments/InstrumentEdit";
import { Dashboard } from "./pages/dashboard/Dashboard";
import { OpsPanel } from "./pages/ops/OpsPanel";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { SetupPage } from "./pages/settings/SetupPage";
import "./styles.css";

type AuthState = "checking" | "authenticated" | "password-required" | "setup-required";

type PageMeta = {
  title: string;
  description: string;
};

function getPageMeta(path: string): PageMeta {
  if (path === "/") {
    return {
      title: "仪表盘",
      description: "运行状态与全宽价格监控表格。",
    };
  }
  if (path === "/diagnostics") {
    return {
      title: "告警与诊断",
      description: "最近告警、Telegram 测试与各数据源最近错误。",
    };
  }
  if (path === "/settings") {
    return {
      title: "系统设置",
      description: "更新访问密码与 Telegram 告警凭据。",
    };
  }
  if (path === "/instruments") {
    return {
      title: "标的管理",
      description: "配置监控标的、支撑/阻力与多数据源映射。",
    };
  }
  if (path === "/instruments/new") {
    return {
      title: "新增标的",
      description: "创建标的并绑定至少一个行情数据源。",
    };
  }
  if (/^\/instruments\/\d+\/edit$/.test(path)) {
    return {
      title: "编辑标的",
      description: "更新规则阈值与数据源映射。",
    };
  }
  return {
    title: "WaveMonitor",
    description: "价格与告警监控后台。",
  };
}

function NavLink({
  href,
  children,
  onNavigate,
}: {
  href: string;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  const [location] = useLocation();
  const isActive =
    href === "/"
      ? location === "/"
      : location === href || location.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      className={isActive ? "nav-link nav-link--active" : "nav-link"}
      onClick={onNavigate}
    >
      {children}
    </Link>
  );
}

function LoginGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const status = await apiClient.login(password);
      if (status.authenticated) {
        onAuthenticated();
        return;
      }
      setError("密码验证未启用或未通过。");
    } catch (loginError) {
      setError(loginError instanceof ApiError ? loginError.message : "验证失败，请重试。");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="auth-layout">
      <form className="panel auth-panel" onSubmit={handleSubmit}>
        <p className="eyebrow">WaveMonitor</p>
        <h1>访问验证</h1>
        <p className="summary">请输入共享访问密码，验证后即可进入监控后台。</p>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="form-group">
          <label htmlFor="access-password">访问密码</label>
          <input
            id="access-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </div>
        <button type="submit" className="button primary" disabled={isSubmitting || password.length === 0}>
          {isSubmitting ? "验证中..." : "进入"}
        </button>
      </form>
    </main>
  );
}

type AppShellProps = {
  authEnabled: boolean;
  configurationAvailable: boolean;
  onLogout: () => void;
  logoutPending: boolean;
};

function AppShell({ authEnabled, configurationAvailable, onLogout, logoutPending }: AppShellProps) {
  const [location] = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const page = getPageMeta(location);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location]);

  return (
    <div className={`app-layout${mobileNavOpen ? " app-layout--nav-open" : ""}`}>
      <nav className="sidebar" aria-label="主导航">
        <div className="sidebar-top">
          <div className="sidebar-header">
            <span className="brand-mark" aria-hidden="true" />
            <div className="brand-copy">
              <h2 className="brand-title">WaveMonitor</h2>
              <p className="brand-tagline">价格与告警监控</p>
            </div>
          </div>
          <button
            type="button"
            className="nav-toggle button small"
            aria-expanded={mobileNavOpen}
            aria-controls="primary-nav"
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            {mobileNavOpen ? "收起菜单" : "打开菜单"}
          </button>
        </div>
        <ul id="primary-nav" className="nav-links">
          <li>
            <NavLink href="/" onNavigate={() => setMobileNavOpen(false)}>
              仪表盘
            </NavLink>
          </li>
          <li>
            <NavLink href="/diagnostics" onNavigate={() => setMobileNavOpen(false)}>
              告警与诊断
            </NavLink>
          </li>
          <li>
            <NavLink href="/instruments" onNavigate={() => setMobileNavOpen(false)}>
              标的管理
            </NavLink>
          </li>
          {configurationAvailable && (
            <li>
              <NavLink href="/settings" onNavigate={() => setMobileNavOpen(false)}>
                系统设置
              </NavLink>
            </li>
          )}
        </ul>
        {authEnabled && (
          <div className="sidebar-footer">
            <button
              type="button"
              className="button small sidebar-logout"
              onClick={onLogout}
              disabled={logoutPending}
            >
              {logoutPending ? "退出中..." : "退出登录"}
            </button>
          </div>
        )}
      </nav>
      <div className="main-column">
        <header
          className={`page-header${location === "/" ? " page-header--dashboard" : ""}`}
        >
          <div className="page-header__copy">
            {location !== "/" && <p className="eyebrow">监控后台</p>}
            <h1 className="page-title">{page.title}</h1>
            {location !== "/" && <p className="page-description">{page.description}</p>}
          </div>
        </header>
        <main className="main-content">
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/diagnostics" component={OpsPanel} />
            <Route path="/settings" component={SettingsPage} />
            <Route path="/instruments" component={InstrumentList} />
            <Route path="/instruments/new" component={InstrumentCreate} />
            <Route path="/instruments/:id/edit">
              {(params) => <InstrumentEdit id={params.id} />}
            </Route>
            <Route>
              <div className="panel panel--centered">
                <p className="eyebrow">404</p>
                <h1>页面未找到</h1>
                <p className="summary">你访问的页面不存在。</p>
                <Link href="/" className="button primary">
                  返回仪表盘
                </Link>
              </div>
            </Route>
          </Switch>
        </main>
      </div>
    </div>
  );
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authEnabled, setAuthEnabled] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [configurationAvailable, setConfigurationAvailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSession() {
      try {
        const status = await apiClient.getAuthSession(controller.signal);
        setAuthEnabled(status.auth_enabled);
        setConfigurationAvailable(status.configuration_available === true);
        setAuthState(status.setup_required ? "setup-required" : status.auth_enabled && !status.authenticated ? "password-required" : "authenticated");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setAuthEnabled(true);
        setAuthState("password-required");
      }
    }

    loadSession();
    return () => controller.abort();
  }, []);

  const handleLogout = async () => {
    setLogoutPending(true);
    try {
      await apiClient.logout();
    } catch {
      // Still clear local session UX if network fails.
    } finally {
      setLogoutPending(false);
      setAuthState("password-required");
    }
  };

  if (authState === "checking") {
    return (
      <main className="auth-layout">
        <div className="panel auth-panel" role="status" aria-live="polite">
          <h1>正在验证访问状态...</h1>
        </div>
      </main>
    );
  }
  if (authState === "setup-required") {
    return <SetupPage onConfigured={() => {
      setAuthEnabled(true);
      setAuthState("authenticated");
    }} />;
  }


  if (authState === "password-required") {
    return <LoginGate onAuthenticated={() => setAuthState("authenticated")} />;
  }

  return (
    <AppShell authEnabled={authEnabled} configurationAvailable={configurationAvailable} onLogout={handleLogout} logoutPending={logoutPending} />
  );
}
