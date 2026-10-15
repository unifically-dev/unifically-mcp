import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end proof of the listing/using split: a client with NO credential can
 * complete the MCP handshake and read the tool list, and cannot do anything
 * else. This runs the real binary because the property being tested lives in
 * the HTTP request pipeline, not in any single function.
 */

let child: ChildProcess | undefined;
let upstream: Server | undefined;
/** Every request the MCP server made to the UnificAlly API during a test. */
let upstreamHits: string[] = [];

afterEach(async () => {
  child?.kill();
  child = undefined;
  upstreamHits = [];
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream?.close(() => done()));
  }
  upstream = undefined;
});

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

async function waitForHealth(url: string, logs: () => string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      // process is still starting
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`MCP server did not become healthy. Logs:\n${logs()}`);
}

async function startServer(env: Record<string, string> = {}): Promise<string> {
  upstream = createServer((req, res) => {
    upstreamHits.push(req.url ?? "");
    if (req.url === "/account") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, code: 200, data: { user_id: 42, balance_usd: 10, email: "test@example.com" } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => upstream?.listen(0, "127.0.0.1", done));
  const upstreamAddress = upstream.address();
  const upstreamPort = typeof upstreamAddress === "object" && upstreamAddress ? upstreamAddress.port : 0;

  const mcpPort = await freePort();
  const mcpUrl = `http://127.0.0.1:${mcpPort}`;
  const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
  let logs = "";
  child = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      PORT: String(mcpPort),
      UNIFICALLY_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      UNIFICALLY_MAX_RETRIES: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { logs += String(chunk); });
  child.stderr?.on("data", (chunk) => { logs += String(chunk); });
  await waitForHealth(mcpUrl, () => logs);
  return mcpUrl;
}

const ANON_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "MCP-Protocol-Version": "2025-06-18",
};

const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${url}/mcp`, { method: "POST", headers: { ...ANON_HEADERS, ...headers }, body: JSON.stringify(body) });

describe("unauthenticated MCP discovery", () => {
  it("serves the tool list to a keyless client but refuses to run a tool", { timeout: 30_000 }, async () => {
    const url = await startServer();

    const handshake = await post(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "registry-scanner", version: "0" } },
    });
    expect(handshake.status, await handshake.clone().text()).toBe(200);

    const listed = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(listed.status).toBe(200);
    const payload = await listed.json();
    const names = payload.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("generate_video");
    expect(names).toContain("check_balance");
    expect(names.length).toBeGreaterThanOrEqual(13);

    // Discovery must never touch the UnificAlly API — no key to spend, and no
    // way for a keyless flood to turn into upstream load.
    expect(upstreamHits).toEqual([]);

    const called = await post(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "check_balance", arguments: {} },
    });
    expect(called.status).toBe(401);
    expect(called.headers.get("www-authenticate")).toContain("Bearer");
    const error = await called.json();
    expect(error.error_message).toMatch(/api key/i);
    expect(upstreamHits).toEqual([]);
  });

  it("tells a keyless client which credential it will need", { timeout: 30_000 }, async () => {
    // The hazard of a free tool list is a listing that looks like it needs no
    // setup. Both unauthenticated metadata endpoints must name the key.
    const url = await startServer();

    const config = await fetch(`${url}/.well-known/mcp-config`);
    expect(config.status).toBe(200);
    expect(config.headers.get("content-type")).toContain("application/json");
    const schema = await config.json();
    expect(schema.required).toEqual(["api_key"]);
    expect(schema.properties.api_key.description).toContain("https://unifically.com/api-keys");

    const card = await (await fetch(`${url}/.well-known/mcp/server-card.json`)).json();
    expect(card.authentication.required).toBe(true);
    expect(card.authentication.publicMethods).toContain("tools/list");
    expect(card.authentication.publicMethods).not.toContain("tools/call");
    expect(card.configSchema.required).toEqual(["api_key"]);
  });

  it("refuses a batch that hides a tool call behind a listing", { timeout: 30_000 }, async () => {
    const url = await startServer();
    const response = await post(url, [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_balance", arguments: {} } },
    ]);
    expect(response.status).toBe(401);
    expect(upstreamHits).toEqual([]);
  });

  it("still requires a key to open a legacy SSE stream", { timeout: 30_000 }, async () => {
    const url = await startServer();
    // A stream makes the server hold resources before anything is proven, which
    // is the one thing anonymous access must not be able to do.
    const response = await fetch(`${url}/sse`, { headers: { Accept: "text/event-stream" } });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it("can be switched off entirely for a private deployment", { timeout: 30_000 }, async () => {
    const url = await startServer({ UNIFICALLY_PUBLIC_DISCOVERY: "0" });
    const listed = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(listed.status).toBe(401);
  });

  it("throttles a keyless flood from one address", { timeout: 30_000 }, async () => {
    const url = await startServer({ UNIFICALLY_ANON_RATE_BURST: "3", UNIFICALLY_ANON_RATE_PER_MIN: "1" });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const response = await post(url, { jsonrpc: "2.0", id: i, method: "tools/list", params: {} });
      statuses.push(response.status);
      await response.text();
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);
  });
});
