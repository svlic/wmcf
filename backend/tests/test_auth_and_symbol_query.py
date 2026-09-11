from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Final

import pytest
from fastapi.testclient import TestClient

from wavemonitor_backend.app import AppRuntime, create_app
from wavemonitor_backend.settings import Settings
from wavemonitor_backend.symbol_catalog import SymbolCatalog

AUTH_PASSWORD: Final[str] = "open-sesame"
AUTH_SECRET: Final[str] = "test-session-secret"


class FakeBinanceExchange:
    def exchange_info(self) -> dict[str, object]:
        return {
            "symbols": [
                {"symbol": "BTCUSDT", "status": "TRADING"},
                {"symbol": "ETHUSDT", "status": "TRADING"},
            ]
        }


def fake_symbol_catalog() -> SymbolCatalog:
    return SymbolCatalog(usd_m_client=FakeBinanceExchange(), coin_m_client=FakeBinanceExchange())


@pytest.fixture
def protected_client(tmp_path: Path) -> Iterator[TestClient]:
    # Given: web password auth is enabled for this test app.
    database_url = f"sqlite:///{tmp_path / 'auth.sqlite3'}"
    settings = Settings(web_password=AUTH_PASSWORD, session_secret=AUTH_SECRET)
    with TestClient(
        create_app(AppRuntime(settings=settings, database_url=database_url))
    ) as test_client:
        yield test_client


def test_auth_disabled_keeps_api_routes_public(tmp_path: Path) -> None:
    # Given: no web password is configured.
    database_url = f"sqlite:///{tmp_path / 'public.sqlite3'}"
    with TestClient(
        create_app(AppRuntime(settings=Settings(), database_url=database_url))
    ) as client:
        # When: a protected API route is requested.
        response = client.get("/api/runtime")

    # Then: existing deployments remain public by default.
    assert response.status_code == 200


def test_auth_enabled_protects_api_but_not_health(protected_client: TestClient) -> None:
    # Given: web password auth is enabled and the client has no session cookie.
    # When: health and API runtime are requested.
    health_response = protected_client.get("/health")
    runtime_response = protected_client.get("/api/runtime")

    # Then: health remains public while API data requires login.
    assert health_response.status_code == 200
    assert runtime_response.status_code == 401
    assert runtime_response.json() == {"detail": "Authentication required"}


def test_login_issues_persistent_httponly_cookie(protected_client: TestClient) -> None:
    # Given: auth is enabled.
    # When: the shared password is submitted.
    response = protected_client.post("/api/auth/login", json={"password": AUTH_PASSWORD})

    # Then: the API creates a persistent HttpOnly session cookie.
    cookie_header = response.headers["set-cookie"]
    assert response.status_code == 200
    assert response.json() == {"authenticated": True, "auth_enabled": True}
    assert "wavemonitor_session=" in cookie_header
    assert "HttpOnly" in cookie_header
    assert "Max-Age=604800" in cookie_header
    assert "samesite=lax" in cookie_header.lower()


def test_wrong_password_does_not_authenticate(protected_client: TestClient) -> None:
    # Given: auth is enabled.
    # When: the wrong password is submitted.
    login_response = protected_client.post("/api/auth/login", json={"password": "wrong"})
    runtime_response = protected_client.get("/api/runtime")

    # Then: no session is established.
    assert login_response.status_code == 401
    assert login_response.json() == {"detail": "Invalid password"}
    assert runtime_response.status_code == 401


def test_logout_clears_cookie_and_blocks_api_again(protected_client: TestClient) -> None:
    # Given: a logged-in browser session.
    protected_client.post("/api/auth/login", json={"password": AUTH_PASSWORD})

    # When: logout is requested.
    logout_response = protected_client.post("/api/auth/logout")
    runtime_response = protected_client.get("/api/runtime")

    # Then: the session cookie is cleared and protected routes require login again.
    assert logout_response.status_code == 200
    assert logout_response.json() == {"authenticated": False, "auth_enabled": True}
    assert "wavemonitor_session=" in logout_response.headers["set-cookie"]
    assert runtime_response.status_code == 401


def test_session_reports_auth_state(protected_client: TestClient) -> None:
    # Given: auth is enabled and the client starts without a session.
    before_login = protected_client.get("/api/auth/session")

    # When: the client logs in.
    protected_client.post("/api/auth/login", json={"password": AUTH_PASSWORD})
    after_login = protected_client.get("/api/auth/session")

    # Then: the session endpoint reports the browser auth state.
    assert before_login.json() == {"authenticated": False, "auth_enabled": True}
    assert after_login.json() == {"authenticated": True, "auth_enabled": True}


def test_symbol_query_requires_auth_when_auth_is_enabled(protected_client: TestClient) -> None:
    # Given: auth is enabled and no session cookie exists.
    # When: the realtime symbol query endpoint is requested.
    response = protected_client.get(
        "/api/symbols/query",
        params={"provider": "binance", "market_type": "usd_m_futures", "q": "btc"},
    )

    # Then: symbol suggestions are protected like other API routes.
    assert response.status_code == 401


def test_symbol_query_returns_provider_specific_realtime_options(tmp_path: Path):
    # Given: auth is disabled and Binance exchange_info is backed by a test catalog.
    database_url = f"sqlite:///{tmp_path / 'symbols.sqlite3'}"
    with TestClient(
        create_app(
            AppRuntime(
                settings=Settings(),
                database_url=database_url,
                symbol_catalog=fake_symbol_catalog(),
            )
        )
    ) as client:
        # When: the realtime symbol query endpoint is called.
        response = client.get(
            "/api/symbols/query",
            params={"provider": "binance", "market_type": "usd_m_futures", "q": "btc"},
        )

    # Then: matching TRADING symbols from the provider are returned for the dropdown.
    assert response.status_code == 200
    assert response.json() == {
        "options": [
            {
                "symbol": "BTCUSDT",
                "label": "BTCUSDT",
                "provider": "binance",
                "market_type": "usd_m_futures",
            }
        ]
    }

def test_symbol_queries_reuse_default_catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # Given: the production catalog factory is lazy and expensive to initialize.
    import wavemonitor_backend.app as app_module

    catalogs: list[SymbolCatalog] = []

    def fake_default_symbol_catalog() -> SymbolCatalog:
        catalog = fake_symbol_catalog()
        catalogs.append(catalog)
        return catalog

    monkeypatch.setattr(app_module, "default_symbol_catalog", fake_default_symbol_catalog)
    database_url = f"sqlite:///{tmp_path / 'cached-symbols.sqlite3'}"
    runtime = AppRuntime(settings=Settings(), database_url=database_url)
    with TestClient(create_app(runtime)) as client:
        first = client.get(
            "/api/symbols/query",
            params={"provider": "binance", "market_type": "usd_m_futures", "q": "btc"},
        )
        second = client.get(
            "/api/symbols/query",
            params={"provider": "binance", "market_type": "usd_m_futures", "q": "eth"},
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert len(catalogs) == 1


def test_symbol_query_rejects_blank_query(tmp_path: Path):
    # Given: auth is disabled.
    database_url = f"sqlite:///{tmp_path / 'blank-symbols.sqlite3'}"
    with TestClient(
        create_app(AppRuntime(settings=Settings(), database_url=database_url))
    ) as client:
        # When: the realtime symbol query endpoint receives a blank query.
        response = client.get(
            "/api/symbols/query",
            params={"provider": "binance", "market_type": "usd_m_futures", "q": " "},
        )

    # Then: the request is rejected at the API boundary.
    assert response.status_code == 422
    assert "q" in response.text
