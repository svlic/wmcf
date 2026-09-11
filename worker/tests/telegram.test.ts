import { afterEach, describe, expect, it, vi } from "vitest";

import { sendTelegram } from "../src/telegram";

afterEach(() => vi.unstubAllGlobals());

describe("sendTelegram", () => {
  it("retries transient failures before reporting success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 500 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { message_id: 42 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendTelegram({ token: "token", chatId: "chat" }, "message")).resolves.toEqual({
      status: "sent",
      messageId: "42",
      safeError: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
