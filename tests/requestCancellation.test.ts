import { afterEach, describe, expect, it, vi } from "vitest";

import { resetConfigForTests, withRequestContext } from "../src/config.js";
import { getAccount } from "../src/unifically.js";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
  resetConfigForTests();
  vi.unstubAllGlobals();
});

describe("upstream cancellation", () => {
  it("aborts an active API fetch when the MCP client disconnects", async () => {
    process.env.MCP_TRANSPORT = "http";
    process.env.UNIFICALLY_BASE_URL = "https://api.example.test";
    resetConfigForTests();

    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }));

    const client = new AbortController();
    const pending = withRequestContext(
      { apiKey: "sk-test", signal: client.signal },
      () => getAccount({}, { maxRetries: 0 }),
    );
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());

    client.abort(new Error("client disconnected"));

    await expect(pending).rejects.toThrow(/client disconnected/i);
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("does not wait through retry backoff after cancellation", async () => {
    process.env.MCP_TRANSPORT = "stdio";
    process.env.UNIFICALLY_BASE_URL = "https://api.example.test";
    resetConfigForTests();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ success: false, code: 429, message: "busy" }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    )));

    const client = new AbortController();
    const pending = withRequestContext(
      { apiKey: "sk-test", signal: client.signal },
      () => getAccount({}, { maxRetries: 3 }),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    client.abort(new Error("stop backoff"));

    await expect(pending).rejects.toThrow(/stop backoff/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
