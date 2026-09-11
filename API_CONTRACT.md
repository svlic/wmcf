# Cloudflare Worker API contract

WaveMonitor exposes the React application, HTTP API, health endpoint, and scheduled monitoring from one Cloudflare Worker origin. D1 is the only persistence backend.

## Routes

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Returns `{ status: "ok", telegram_ready: boolean }`. Public. |
| GET | `/api/auth/session` | Returns `{ authenticated, auth_enabled, setup_required, configuration_available: true }`. Public. |
| POST | `/api/auth/login` | Accepts `{ password }`, validates the configured shared password, and issues a 7-day `HttpOnly`, `Secure`, `SameSite=Lax` `wavemonitor_session` cookie. Public. |
| POST | `/api/auth/logout` | Clears the session cookie. Public. |
| POST | `/api/setup` | Performs one-time initialization while no password is configured. Accepts `{ password, telegram_bot_token?, telegram_chat_id? }`; the password must contain at least 8 characters and Telegram fields must be supplied together. Returns **409** after initialization. Public. |
| GET | `/api/settings` | Returns configuration readiness flags without password material, the session secret, Bot Token, or Chat ID. Authenticated. |
| PUT | `/api/settings` | Optionally changes the password and enables, replaces, or disables Telegram credentials. Blank Telegram fields retain existing credentials when Telegram remains enabled. Authenticated. |
| GET | `/api/symbols/query` | Accepts non-blank `provider`, `market_type`, and `q` query parameters. Queries TradingView for Yahoo-compatible equities and Binance perpetual contracts, or Hyperliquid metadata for perpetual contracts. Returns at most 25 `{ symbol, label, provider, market_type }` options. Authenticated. |
| GET | `/api/instruments` | Lists configured instruments with source mappings. Authenticated. |
| POST | `/api/instruments` | Creates an instrument and its source mappings, then requests an immediate monitoring tick. Authenticated. |
| PUT | `/api/instruments/{instrument_id}` | Atomically replaces instrument fields and source mappings, starts a new rule-evaluation cycle, then requests an immediate monitoring tick. Authenticated. |
| PATCH | `/api/instruments/{instrument_id}` | Accepts `{ enabled: boolean }`, toggles monitoring without replacing rules or source mappings, then requests an immediate monitoring tick. Authenticated. |
| DELETE | `/api/instruments/{instrument_id}` | Deletes the instrument and its source mappings. Authenticated. |
| GET | `/api/instruments/{instrument_id}/status` | Returns the enabled flag, per-source latest state, and up to 10 recent alerts for the instrument. Authenticated. |
| POST | `/api/prices/refresh` | Runs one monitoring tick synchronously and returns **204** after fresh observations and runtime state have been persisted. Authenticated. |
| GET | `/api/prices/latest` | Returns the latest successful observation for each enabled instrument and enabled source mapping. Crossing flags are sticky within the current rule-evaluation cycle. Authenticated. |
| GET | `/api/alerts` | Returns up to 50 recent alert events. Authenticated. |
| GET | `/api/source-errors` | Returns enabled source mappings whose latest observation failed. Authenticated. |
| GET | `/api/runtime` | Returns scheduler, provider, Telegram, polling, alert, delivery, and tick state. Authenticated. |
| GET | `/api/telegram/readiness` | Returns `{ telegram_ready: boolean }`. Authenticated. |
| POST | `/api/telegram/test` | Sends a test message when Telegram credentials exist. Responses and logs do not expose secrets. Authenticated. |

Unknown non-API paths are delegated to Workers Static Assets. Static Assets uses SPA fallback routing.

## Instrument rules

`supports` and `resistances` are arrays of decimal strings. An unset side is `[]`, never `null`.

- `alert_mode` is `static` by default or `fixed_drawdown`.
- In `static` mode, at least one level array must be non-empty, every level must be positive, and `max(supports) < min(resistances)` when both sides exist. `high_water` and `fixed_drawdown` must be omitted.
- In `fixed_drawdown` mode, `high_water` and `fixed_drawdown` are required positive absolute price amounts. `supports` must be omitted or empty because support is derived as `high_water - fixed_drawdown`. `resistances` accepts at most one level.
- `near_support_threshold` is required whenever support exists, including derived support.
- `risk_reward_threshold` is required whenever both support and resistance exist.

Each source mapping contains `{ provider, market_type, symbol, enabled }`. Valid pairs are:

- `yfinance + equity`
- `binance + usd_m_futures`
- `binance + coin_m_futures`
- `hyperliquid + perpetual`

Symbols are normalized to uppercase. Source identity is unique per instrument by `(instrument_id, provider, market_type, symbol)`. Different instruments may share the same global source triple. Duplicate mappings return **409**.

## Authentication and configuration

A fresh deployment has no authentication configuration. Before initialization, API routes remain available so the UI can load readiness data and complete setup. `POST /api/setup` stores a salted PBKDF2-SHA256 password derivation, a generated session secret, and optional Telegram credentials in the singleton D1 `app_config` row. It never stores the plain-text password.

After initialization, every `/api/*` route requires the signed session cookie except `/api/auth/session`, `/api/auth/login`, `/api/auth/logout`, and `/api/setup`. `/health` remains public. Changing the password rotates the session secret.

Existing Cloudflare deployments may supply `WAVEMONITOR_WEB_PASSWORD`, `WAVEMONITOR_SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` as Wrangler secrets. They are compatibility fallbacks only while no D1 `app_config` row exists; GUI-managed D1 configuration takes precedence.

## Cloudflare runtime

`worker/wrangler.jsonc` binds D1 as `DB`, Static Assets as `ASSETS`, and a `*/2 * * * *` Cron Trigger. The scheduled handler runs one monitoring tick. Instrument creates, replacements, and enabled-state changes also queue an immediate tick with `ExecutionContext.waitUntil`. Manual price refreshes run a monitoring tick synchronously so the caller can reload persisted prices only after polling finishes.

`scheduler_ready` becomes true after the first completed tick. Price observations older than three days are pruned during monitoring.
