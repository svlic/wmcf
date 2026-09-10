# Backend API contract

This file mirrors the backend MVP routes from `.omo/plans/stock-data-monitor-build.md` and the Todo 9 operational surfaces.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Returns `{ status: "ok", telegram_ready: boolean }` without requiring optional Telegram env. |
| GET | `/api/auth/session` | Returns `{ authenticated, auth_enabled }`; the Workers implementation also returns `setup_required` and `configuration_available` so a fresh deployment can show the GUI setup flow. Auth endpoints stay public. |
| POST | `/api/auth/login` | Accepts `{ password }`, validates the configured shared password, and issues a 7-day `HttpOnly` `wavemonitor_session` cookie when valid. |
| POST | `/api/auth/logout` | Clears the `wavemonitor_session` cookie. |
| POST | `/api/setup` | Workers only. One-time unauthenticated initialization when no password exists. Accepts `{ password, telegram_bot_token?, telegram_chat_id? }`; password must contain at least 8 characters and Telegram fields must be supplied together. Returns **409** after initialization. |
| GET | `/api/settings` | Workers only and authenticated. Returns configuration readiness flags; never returns password material, session secret, Bot Token, or Chat ID. |
| PUT | `/api/settings` | Workers only and authenticated. Optionally changes the password and enables, replaces, or disables Telegram credentials. Blank Telegram fields retain existing credentials when enabled. |
| GET | `/api/symbols/query` | Query params: `provider`, `market_type`, `q` (non-blank). Queries the configured provider: Binance USD-M / coin-M via `exchange_info()` (TRADING symbols only, substring match, up to 25), Hyperliquid perpetual via `all_mids()`, Yahoo Finance equity via `yfinance.Search`. Returns `{ options: [{ symbol, label, provider, market_type }] }`; empty when no match or provider failure (manual symbol entry still allowed in the UI). |
| GET | `/api/instruments` | Lists configured instruments with source mappings. |
| POST | `/api/instruments` | Creates an instrument and source mappings, then requests an immediate monitoring tick so the first price does not wait for Cron. `supports` and `resistances` are arrays of decimal strings; an unset side is `[]`, never `null`. `alert_mode` is `static` (default) or `fixed_drawdown`. In `static` mode, at least one array must be non-empty, every level must be positive, `max(supports) < min(resistances)` when both sides are set, and `high_water` / `fixed_drawdown` must be omitted. In `fixed_drawdown` mode, `high_water` and `fixed_drawdown` are required absolute price amounts, `supports` must be omitted or empty because the single support is derived as `high_water - fixed_drawdown`, and `resistances` accepts at most one level. `near_support_threshold` is required when support exists (including derived support); `risk_reward_threshold` is required when both sides exist. Each source uses `{ provider, market_type, symbol, enabled }`; only `yfinance+equity`, `binance+usd_m_futures`, `binance+coin_m_futures`, and `hyperliquid+perpetual` are valid. Duplicate `(instrument_id, provider, market_type, symbol)` returns **409**. |
| PUT | `/api/instruments/{instrument_id}` | Replaces instrument fields and source mappings atomically, then requests an immediate monitoring tick. Uses the same conditional level/threshold contract and **409** semantics as create; failed updates do not partially apply field changes. A successful replacement starts a new rule-evaluation cycle for the instrument. |
| PATCH | `/api/instruments/{instrument_id}` | Body `{ enabled: boolean }` only. Toggles monitoring pause/resume without replacing source mappings, rule fields, or the current rule-evaluation cycle, then requests an immediate monitoring tick. |
| DELETE | `/api/instruments/{instrument_id}` | Deletes an instrument and its source mappings. |
| GET | `/api/instruments/{instrument_id}/status` | Returns the instrument enabled flag, per-source latest price/error/`last_invalid_state` (rule invalid reason when price is not above support), and recent alerts for that instrument. |
| GET | `/api/prices/latest` | Returns latest successful price observations for **enabled** instruments and **enabled** source mappings only (paused instruments are omitted). Required boolean fields `support_breached` / `resistance_broken` are sticky per source only within the instrument's current edit cycle: events before the latest successful `PUT /api/instruments/{instrument_id}` are ignored, while a post-edit breach/breakout sets its flag for the rest of that cycle. Empty when none qualify. |
| GET | `/api/alerts` | Returns recent alert events. Empty when no alerts exist. |
| GET | `/api/source-errors` | Returns collection-level latest source mappings whose most recent observation is an error. Empty when no source errors exist. |
| GET | `/api/runtime` | Returns scheduler/provider/Telegram readiness, polling counters, alert/delivery counters, and last tick timestamps. |
| GET | `/api/telegram/readiness` | Returns Telegram readiness only; secrets are never exposed. |
| POST | `/api/telegram/test` | Sends a Telegram test only when credentials are configured; response/logs redact secrets. |

## Source mapping identity

- Uniqueness is **per instrument**: `(instrument_id, provider, market_type, symbol)` where `symbol` is normalized to uppercase on input.
- Different instruments may share the same global source triple (e.g. two strategies both monitoring Binance `BTCUSDT`).
- Within one create/update payload, two mappings that normalize to the same triple are rejected with **409** on create (via DB) and should not be sent on update; the scheduler only polls sources whose **instrument** and **source mapping** are both `enabled`.

## Authentication

When `WAVEMONITOR_WEB_PASSWORD` is unset, `/api/*` remains public for local/development compatibility. When it is set, every `/api/*` route requires the signed `wavemonitor_session` cookie except `/api/auth/session`, `/api/auth/login`, and `/api/auth/logout`. `/health` is always public.

The cookie is signed with `WAVEMONITOR_SESSION_SECRET` when set; otherwise the backend generates a random secret on first start and persists it beside the SQLite database file (`session_secret` next to the DB path, or `/data/session_secret` in the default Docker layout).

## Cloudflare Workers runtime

`worker/` implements the HTTP surface on Cloudflare Workers. D1 replaces SQLite, Workers Static Assets serves the frontend, and a `*/2 * * * *` Cron Trigger replaces the in-process scheduler. `scheduler_ready` becomes true after the first completed Cron tick.

A fresh Workers deployment is initialized through `POST /api/setup`; afterward all non-auth `/api/*` routes require the signed session cookie. The password is stored as a salted PBKDF2-SHA256 derivation, the session secret is generated by the Worker, and Telegram credentials are stored in D1 without any read API exposing them. Existing Wrangler secrets remain a compatibility fallback until GUI-managed configuration is saved. The Workers implementation does not support `BINANCE_HTTPS_PROXY`.
