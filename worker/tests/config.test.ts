import { describe, expect, it, vi } from "vitest";

import { effectiveAuthConfig, loadTelegramCredentials, passwordMatches } from "../src/config";
import type { Env } from "../src/types";

function legacyEnv(): Env {
  const first = vi.fn().mockResolvedValue(null);
  const prepare = vi.fn().mockReturnValue({ first });
  return {
    DB: { prepare } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    WAVEMONITOR_WEB_PASSWORD: "legacy-password",
    WAVEMONITOR_SESSION_SECRET: "legacy-session-secret",
    TELEGRAM_BOT_TOKEN: "legacy-token",
    TELEGRAM_CHAT_ID: "legacy-chat",
  };
}

describe("legacy environment configuration", () => {
  it("provides authentication while D1 has no app configuration", async () => {
    const env = legacyEnv();
    const config = await effectiveAuthConfig(env);

    expect(config).toEqual({ enabled: true, sessionSecret: "legacy-session-secret", row: null });
    await expect(passwordMatches("legacy-password", env, config)).resolves.toBe(true);
  });

  it("provides Telegram credentials while D1 has no app configuration", async () => {
    await expect(loadTelegramCredentials(legacyEnv())).resolves.toEqual({
      token: "legacy-token",
      chatId: "legacy-chat",
    });
  });
});
