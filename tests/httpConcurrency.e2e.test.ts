import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let child: ChildProcess | undefined;
let upstream: Server | undefined;

afterEach(async () => {
  child?.kill();
  child = undefined;
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

describe("HTTP concurrency lifecycle", () => {
  it("releases all 16 account slots when clients disconnect from hanging calls", { timeout: 20_000 }, async () => {
    let hangingRequests = 0;
    upstream = createServer((req, res) => {
      if (req.url === "/account") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, code: 200, data: { user_id: 42, balance_usd: 10, email: "test@example.com" } }));
        return;
      }
      if (req.url === "/v1/tasks/hang") {
        hangingRequests++;
        // Deliberately never respond. Disconnect propagation must abort these.
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
        UNIFICALLY_REQUEST_TIMEOUT_MS: "15000",
        UNIFICALLY_MAX_RETRIES: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { logs += String(chunk); });
    child.stderr?.on("data", (chunk) => { logs += String(chunk); });
    await waitForHealth(mcpUrl, () => logs);

    const headers = {
      Authorization: "Bearer sk-e2e",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
    };
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const calls = controllers.map((controller, id) => fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "get_task", arguments: { task_id: "hang" } },
      }),
    }).catch((error) => error));

    await vi.waitFor(() => expect(hangingRequests).toBe(16), { timeout: 8_000, interval: 25 });
    controllers.forEach((controller) => controller.abort());
    await Promise.all(calls);

    const response = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list", params: {} }),
    });
    expect(response.status, await response.text()).toBe(200);
  });
});
