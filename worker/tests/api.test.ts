import { applyD1Migrations, createExecutionContext, env, SELF, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
declare global {
  namespace Cloudflare {
    interface Env { DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
  }
}

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
afterEach(() => vi.unstubAllGlobals());

describe("worker API", () => {
  it("reports health and empty runtime", async () => {
    const health = await SELF.fetch("https://example.com/health");
    expect(await health.json()).toEqual({ status: "ok", telegram_ready: false });
    const runtime = await SELF.fetch("https://example.com/api/runtime");
    expect(await runtime.json()).toMatchObject({ scheduler_ready: false, enabled_sources: 0, last_tick_finished_at: null });
  });

  it("creates, lists, patches, replaces, and deletes an instrument", async () => {
    const payload = { name: "Bitcoin", enabled: true, supports: ["90000.10"], resistances: ["110000.25"], near_support_threshold: "0.02", risk_reward_threshold: "3.5", source_mappings: [{ provider: "binance", market_type: "usd_m_futures", symbol: "btcusdt", enabled: false }] };
    const createdResponse = await SELF.fetch("https://example.com/api/instruments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ id: number; supports: string[]; source_mappings: Array<{ id: number; symbol: string }> }>();
    expect(created.supports).toEqual(["90000.1000000000"]);
    expect(created.source_mappings[0]?.symbol).toBe("BTCUSDT");
    await vi.waitFor(async () => {
      const runtime = await SELF.fetch("https://example.com/api/runtime");
      expect(await runtime.json()).toMatchObject({
        scheduler_ready: true,
        enabled_sources: 0,
        last_tick_finished_at: expect.any(String),
      });
    });
    const sourceId = created.source_mappings[0]!.id;
    const patched = await SELF.fetch(`https://example.com/api/instruments/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    expect((await patched.json<{ enabled: boolean }>()).enabled).toBe(false);
    const replaced = await SELF.fetch(`https://example.com/api/instruments/${created.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, name: "Bitcoin setup" }) });
    const replacement = await replaced.json<{ name: string; source_mappings: Array<{ id: number }> }>();
    expect(replacement.name).toBe("Bitcoin setup");
    expect(replacement.source_mappings[0]?.id).toBe(sourceId);
    const deleted = await SELF.fetch(`https://example.com/api/instruments/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await (await SELF.fetch("https://example.com/api/instruments")).json()).toEqual([]);
  });

  it("polls enabled sources before completing a manual price refresh", async () => {
    const now = new Date().toISOString();
    const instrument = await env.DB.prepare("INSERT INTO instrument(name,enabled,alert_mode,supports,resistances,created_at,updated_at,rule_cycle_started_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id")
      .bind("Manual refresh", 1, "static", "[]", "[]", now, now, now)
      .first<{ id: number }>();
    const source = await env.DB.prepare("INSERT INTO source_mapping(instrument_id,provider,market_type,symbol,enabled) VALUES(?,?,?,?,?) RETURNING id")
      .bind(instrument!.id, "binance", "usd_m_futures", "BTCUSDT", 1)
      .first<{ id: number }>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ s: "BINANCE:BTCUSDT.P", d: [65432.1] }],
    }), { status: 200 })));
    const context = createExecutionContext();

    const response = await worker.fetch(
      new Request("https://example.com/api/prices/refresh", { method: "POST" }),
      env,
      context,
    );

    expect(response.status).toBe(204);
    expect(await env.DB.prepare("SELECT price FROM price_observation WHERE source_mapping_id=? ORDER BY id DESC LIMIT 1")
      .bind(source!.id)
      .first<{ price: string }>()).toEqual({ price: "65432.1000000000" });
    await env.DB.prepare("DELETE FROM instrument WHERE id=?").bind(instrument!.id).run();
  });

  it("alerts when a price falls below every configured support", async () => {
    const now = new Date().toISOString();
    const instrument = await env.DB.prepare("INSERT INTO instrument(name,enabled,alert_mode,supports,resistances,near_support_threshold,created_at,updated_at,rule_cycle_started_at) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id")
      .bind("Support breach", 1, "static", '["100.0000000000","110.0000000000"]', "[]", "0.0200000000", now, now, now)
      .first<{ id: number }>();
    const source = await env.DB.prepare("INSERT INTO source_mapping(instrument_id,provider,market_type,symbol,enabled) VALUES(?,?,?,?,?) RETURNING id")
      .bind(instrument!.id, "binance", "usd_m_futures", "BREACHUSDT", 1)
      .first<{ id: number }>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ s: "BINANCE:BREACHUSDT.P", d: [90] }],
    }), { status: 200 })));

    await worker.fetch(
      new Request("https://example.com/api/prices/refresh", { method: "POST" }),
      env,
      createExecutionContext(),
    );

    expect(await env.DB.prepare("SELECT alert_kind,support FROM alert_event WHERE source_mapping_id=?")
      .bind(source!.id)
      .first<{ alert_kind: string; support: string }>()).toEqual({
        alert_kind: "support_breach",
        support: "100.0000000000",
      });
    await env.DB.prepare("DELETE FROM instrument WHERE id=?").bind(instrument!.id).run();
  });

  it("rejects invalid provider-market pairs", async () => {
    const response = await SELF.fetch("https://example.com/api/instruments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Bad", supports: ["1"], near_support_threshold: "0.1", source_mappings: [{ provider: "yfinance", market_type: "perpetual", symbol: "BTC" }] }) });
    expect(response.status).toBe(422);
  });

  it("initializes GUI settings and protects subsequent API access", async () => {
    const initial = await SELF.fetch("https://example.com/api/auth/session");
    expect(await initial.json()).toMatchObject({
      authenticated: false,
      auth_enabled: false,
      setup_required: true,
      configuration_available: true,
    });

    const setup = await SELF.fetch("https://example.com/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: "correct-horse",
        telegram_bot_token: "123456:token",
        telegram_chat_id: "-100123456",
      }),
    });
    expect(setup.status).toBe(201);
    expect(await setup.json()).toMatchObject({ authenticated: true, setup_required: false });
    const storedConfig = await env.DB.prepare("SELECT password_iterations FROM app_config WHERE singleton=1")
      .first<{ password_iterations: number }>();
    expect(storedConfig?.password_iterations).toBe(20_000);
    const cookie = setup.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const duplicate = await SELF.fetch("https://example.com/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "another-password" }),
    });
    expect(duplicate.status).toBe(409);
    expect((await SELF.fetch("https://example.com/api/settings")).status).toBe(401);

    const settings = await SELF.fetch("https://example.com/api/settings", {
      headers: { cookie: cookie! },
    });
    expect(await settings.json()).toEqual({
      telegram_enabled: true,
      password_configured: true,
      managed_in_gui: true,
    });

    const updated = await SELF.fetch("https://example.com/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({
        new_password: "replacement-password",
        telegram_enabled: false,
        telegram_bot_token: "",
        telegram_chat_id: "",
      }),
    });
    expect(await updated.json()).toMatchObject({ telegram_enabled: false, managed_in_gui: true });
    expect(updated.headers.get("set-cookie")).toContain("wavemonitor_session=");

    const oldLogin = await SELF.fetch("https://example.com/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct-horse" }),
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await SELF.fetch("https://example.com/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "replacement-password" }),
    });
    expect(newLogin.status).toBe(200);
  });
});
