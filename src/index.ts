#!/usr/bin/env node
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  admitStream,
  consumeAnonymousDiscoveryTokens,
  consumePrincipalRequestToken,
  consumePrincipalRequestTokens,
  sessionLimitFor,
} from "./admission.js";
import { forwardedClientIp } from "./trustedProxy.js";
import { getConfig, hasApiKey, withRequestContext } from "./config.js";
import { isPublicDiscoveryBody } from "./publicDiscovery.js";
import { CONFIG_SCHEMA } from "./configSchema.js";
import { createServer, serverCard, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { MessageConcurrencyGate, releaseOnResponseClose, SseRequestLeaseTracker } from "./concurrency.js";

// MCP requests contain JSON, not media bytes. A 512 KiB envelope leaves ample
// room for prompts and provider options while preventing multi-megabyte JSON
// parsing/allocation attacks. Media must use upload_file/direct upload.
const MAX_BODY_BYTES = 512 * 1024;

// A JSON-RPC batch can repeat the same registered tool many times. Tool-name
// validation still applies to every item, but without this cap one HTTP request
// could create hundreds of otherwise-valid calls at once.
const MAX_BATCH_MESSAGES = 16;

// Cap on concurrent legacy SSE streams. Each pins an MCP server instance, a
// keepalive timer, and a socket until the client disconnects; without a bound
// one keyholder could open unlimited streams and exhaust memory/FDs.
const MAX_SSE_SESSIONS = 512;

// The spec suggests rotating/expiring session ids. The 25s keepalive keeps a
// stream alive indefinitely otherwise, so a connect-and-go-quiet bot holds its
// slot forever. Idle sweep + absolute ceiling bound both cases.
const SESSION_IDLE_TIMEOUT_MS = 10 * 60_000; // no POST in 10 min -> reclaim
const SESSION_MAX_LIFETIME_MS = 4 * 60 * 60_000; // 4h absolute, however chatty

// Ceiling on concurrent in-flight MCP requests. Each holds an McpServer, so this
// bounds the box even when every caller is individually within its own rate limit.
const MAX_INFLIGHT_MESSAGES = 256;
const MAX_INFLIGHT_PER_KEY = 16;
const MAX_INFLIGHT_PER_USER = 16;

// Unauthenticated discovery shares ONE identity in the concurrency gate's user
// dimension, so every keyless caller in aggregate holds at most
// MAX_INFLIGHT_PER_USER slots. Discovery is in-memory and momentary, so this is
// ample for real scanners while guaranteeing a keyless flood can never occupy
// the slots paying callers need.
const ANON_CONCURRENCY_USER = "anon";

// Slowloris defense. Node's defaults (headers 60s, request 5min) let a trickle of
// idle sockets tie the server up for free. These bound how long an UNFINISHED
// request may occupy a socket; they do not limit how long a response may take, so
// a wait:true generation (~85s) is unaffected.
const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;
const KEEPALIVE_TIMEOUT_MS = 10_000;
const MAX_SOCKETS = 2048;

function log(msg: string): void {
  // stdout is reserved for the JSON-RPC stream on stdio transport; log to stderr.
  console.error(`[${SERVER_NAME}] ${msg}`);
}

async function startStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`v${SERVER_VERSION} ready on stdio.`);
  if (!hasApiKey()) {
    log("WARNING: no API key found. Set UNIFICALLY_API_KEY in your MCP client config (get one at https://unifically.com/api-keys).");
  }
}

/**
 * Resolve the caller's API key from, in order of preference:
 *   1. `Authorization: Bearer <key>` header (recommended)
 *   2. `X-API-Key: <key>` header
 *   3. `?api_key=<key>` (or `?key=`) query parameter — for integrations that
 *      can only be configured with a URL. Note: query strings often end up in
 *      proxy logs, so prefer a header when the client supports one.
 */
function extractApiKey(req: IncomingMessage): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const headerKey = req.headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.trim()) return headerKey.trim();
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const queryKey = url.searchParams.get("api_key") ?? url.searchParams.get("key");
    if (queryKey?.trim()) return queryKey.trim();
  } catch {
    // unparseable URL — fall through
  }
  return undefined;
}

/**
 * Caller IP for the per-IP validation budget.
 *
 * Behind Cloudflare/Traefik the socket address is the proxy, so the real client
 * is only in a forwarded header — but those headers are CLIENT-SUPPLIED. Trusting
 * them unconditionally doesn't weaken the budget, it DELETES it: a caller that
 * reaches the origin directly sets a fresh CF-Connecting-IP per request and every
 * request gets a brand-new budget (measured: 200 spoofed IPs, 0 throttled).
 *
 * "It only gates a rate budget, never authorization" is not a defense here — the
 * rate budget IS the thing being attacked.
 *
 * So: honour forwarded headers only when the peer is our own infrastructure — a
 * configured address (loopback only by default; private ranges only when the
 * isolated Docker deployment opts in). A public peer is a direct caller whose
 * headers are ignored in favor of its authenticated TCP socket address.
 *
 * X-Forwarded-For is read RIGHT to left (the rightmost entry is the one appended
 * by our own proxy; the left is whatever the client made up). CF-Connecting-IP
 * is disabled unless the deployment explicitly opts into it.
 */
function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const cf = req.headers["cf-connecting-ip"];
  const fwd = req.headers["x-forwarded-for"];
  return forwardedClientIp(
    peer,
    typeof cf === "string" ? cf : undefined,
    typeof fwd === "string" ? fwd : undefined,
  );
}

/**
 * Reject cross-origin browser requests (spec: "Servers MUST validate the Origin
 * header on all incoming connections to prevent DNS rebinding attacks").
 *
 * Only requests that actually carry an Origin are checked — real MCP clients are
 * not browsers and send none, so this cannot break them. It exists for the case
 * where a page in a victim's browser tries to drive a local/env-key server.
 */
function originAllowed(req: IncomingMessage, allowed: string): boolean {
  const origin = req.headers["origin"];
  if (typeof origin !== "string" || !origin) return true; // non-browser caller
  if (allowed === "*") return true; // operator opted out explicitly
  return allowed.split(",").some((o) => o.trim() === origin);
}

/**
 * Constant-time equality for two API keys. Both must be present and identical.
 * Absent/empty on either side is a non-match — the gate fails CLOSED.
 */
function keysMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch; compare lengths first. Length is
  // not the secret here, so leaking it via the early return is acceptable.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function secretHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class HttpError extends Error {
  readonly statusCode: number;
  readonly errorName: string;
  constructor(statusCode: number, errorName: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorName = errorName;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const succeed = (value: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Reject BEFORE destroying so the caller can still write a 413;
        // pause stops further data events while the response goes out.
        req.pause();
        fail(
          new HttpError(
            413,
            "Payload Too Large",
            `Request body exceeds ${Math.round(MAX_BODY_BYTES / 1024)}KB. MCP bodies are JSON only; upload media with upload_file/direct upload and pass its URL instead.`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return succeed(undefined);
      try {
        succeed(JSON.parse(raw));
      } catch {
        fail(new HttpError(400, "Bad Request", "Request body is not valid JSON."));
      }
    };
    const onAborted = (): void => fail(new HttpError(400, "Bad Request", "Request body was aborted before completion."));
    const onError = (error: Error): void => fail(error);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });
}

/** Count messages before admission/rate/concurrency accounting. */
function mcpMessageCount(body: unknown): number {
  if (!Array.isArray(body)) return 1;
  if (body.length === 0) {
    throw new HttpError(400, "Bad Request", "An MCP JSON-RPC batch cannot be empty.");
  }
  if (body.length > MAX_BATCH_MESSAGES) {
    throw new HttpError(
      400,
      "Bad Request",
      `MCP JSON-RPC batches are limited to ${MAX_BATCH_MESSAGES} messages; received ${body.length}. Split this into smaller requests.`,
    );
  }
  return body.length;
}

function pathOf(url: string | undefined): string {
  if (!url) return "/";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

function applyCors(res: ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  if (origin !== "*") res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, X-API-Key, Content-Type, Accept, mcp-session-id, mcp-protocol-version, last-event-id",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function unauthorized(res: ServerResponse): void {
  res.setHeader("WWW-Authenticate", 'Bearer realm="unifically", error="invalid_token"');
  sendJson(res, 401, {
    status_code: 401,
    error: "Unauthorized",
    error_message:
      "Missing API key. Send 'Authorization: Bearer <key>', an 'X-API-Key' header, or '?api_key='. Get a key at https://unifically.com/api-keys.",
  });
}

/**
 * 401 for a keyless caller that asked for more than discovery.
 *
 * Separate from unauthorized() because the situation is different and the
 * agent's next move is different: it already HAS the tool list, so the message
 * must say the listing was free and the call is not, rather than implying the
 * whole server was unreachable.
 */
function authRequiredForCall(res: ServerResponse): void {
  res.setHeader("WWW-Authenticate", 'Bearer realm="unifically", error="invalid_token"');
  sendJson(res, 401, {
    status_code: 401,
    error: "Unauthorized",
    error_message:
      "Listing this server's tools needs no key, but running one does. Send your UnificAlly API key as 'Authorization: Bearer <key>', an 'X-API-Key' header, or '?api_key='. Get a key at https://unifically.com/api-keys.",
  });
}

function landingBody(): Record<string, unknown> {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description:
      "UnificAlly MCP server — generate video, images, audio/music/speech, transcription, and upscales through one API key.",
    endpoints: {
      mcp: "POST /mcp — MCP Streamable HTTP (the modern transport; any path works). tools/list needs no key; calling a tool does.",
      sse: "GET /sse — legacy MCP SSE transport (messages go to POST /messages)",
      health: "GET /health — unauthenticated health check",
      server_card: "GET /.well-known/mcp/server-card.json — unauthenticated tool list for registries",
      config_schema: "GET /.well-known/mcp-config — unauthenticated JSON Schema of the credential a caller must supply",
    },
    authentication:
      "Pass your UnificAlly API key per request: 'Authorization: Bearer <key>' header (recommended), 'X-API-Key: <key>' header, or '?api_key=<key>' query parameter for URL-only integrations.",
    public_discovery: getConfig().publicDiscovery
      ? "POST /mcp serves initialize, tools/list, resources/list, and ping without a key, so any client or registry can read the tool surface first. Calling a tool requires the key."
      : "Disabled on this deployment: every request needs an API key.",
    get_a_key: "https://unifically.com/api-keys",
    docs: "https://docs.unifically.com",
  };
}

interface SseSession {
  transport: SSEServerTransport;
  /** Requests accepted by POST /messages but still executing asynchronously. */
  requestLeases: SseRequestLeaseTracker;
  /** Aborted when the stream expires, disconnects, fails, or the server stops. */
  abortSignal: AbortSignal;
  apiKey: string;
  /** sha256 prefix of the opening key — never the raw secret. Used for the per-key cap. */
  keyId: string;
  /** Stable account id returned by authenticated /account validation. */
  userId: string;
  /** Hash of a random URL-only continuation token; the raw token is never retained. */
  continuationTokenHash?: string;
  /** Refreshed on every POST; drives the idle sweep. */
  lastSeen: number;
  /** Idempotent teardown shared by disconnect, expiry, failure, and shutdown. */
  close: (why: string) => void;
}

async function startHttp(): Promise<void> {
  const cfg = getConfig();

  // Request and close paths catch their own expected failures. An error that
  // reaches these process-level backstops is different: session/concurrency
  // state may now be inconsistent, so continuing can permanently strand slots.
  // Fail fast and let the container supervisor restart from clean memory.
  process.on("unhandledRejection", (reason) => {
    console.error(`[${SERVER_NAME}] unhandledRejection:`, reason);
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[${SERVER_NAME}] uncaughtException:`, err);
    process.exit(1);
  });
  // Legacy SSE sessions are stateful by design: GET /sse opens the stream,
  // subsequent POST /messages calls are routed back to it by sessionId.
  const sseSessions = new Map<string, SseSession>();
  const messageConcurrency = new MessageConcurrencyGate(
    MAX_INFLIGHT_MESSAGES,
    MAX_INFLIGHT_PER_KEY,
    MAX_INFLIGHT_PER_USER,
  );
  /** Slots reserved by an in-progress open that has not inserted yet. */
  let pendingOpens = 0;

  function reserveMessages(keyIdent: string, userId: string, count: number, res: ServerResponse): (() => void) | undefined {
    const reservation = messageConcurrency.reserve(keyIdent, userId, count);
    if (reservation.ok) return reservation.release;

    if (reservation.scope === "key") {
      res.setHeader("Retry-After", "2");
      sendJson(res, 429, {
        status_code: 429,
        error: "Too Many Requests",
        error_message: `This API key may run at most ${reservation.limit} MCP messages concurrently. Retry shortly.`,
      });
      return undefined;
    }
    if (reservation.scope === "user") {
      res.setHeader("Retry-After", "2");
      sendJson(res, 429, {
        status_code: 429,
        error: "Too Many Requests",
        error_message: `One user account may run at most ${reservation.limit} MCP messages concurrently across all of its API keys. Retry shortly.`,
      });
      return undefined;
    }
    res.setHeader("Retry-After", "2");
    sendJson(res, 503, {
      status_code: 503,
      error: "Service Unavailable",
      error_message: "Server is at capacity. Retry shortly.",
    });
    return undefined;
  }

  const httpServer = createHttpServer({
    // Node enforces headersTimeout/requestTimeout on a sweep whose default is
    // 30s, so a 15s headersTimeout actually fired at ~31s. Sweep more often so
    // the advertised bounds are the real ones. Constructor-only option.
    connectionsCheckingInterval: 5_000,
  }, (req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch((err) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) {
          sendJson(res, err.statusCode, { status_code: err.statusCode, error: err.errorName, error_message: err.message });
        }
        res.end();
        req.destroy();
        return;
      }
      console.error(`[${SERVER_NAME}] request error:`, err);
      if (!res.headersSent) {
        sendJson(res, 500, { status_code: 500, error: "Internal Server Error", error_message: "Unexpected server error." });
      } else {
        res.end();
      }
    });
  });

  async function handleSseOpen(req: IncomingMessage, res: ServerResponse, apiKey: string): Promise<void> {
    // RESERVE the slot before any await. Checking sseSessions.size here and
    // inserting after the admission await is a check/act window: concurrent opens
    // all see size<max and pass, so the cap never binds (measured: 900 concurrent
    // opens against a cap of 512). `pendingOpens` counts slots promised but not
    // yet inserted; every early return below must release it.
    if (sseSessions.size + pendingOpens >= MAX_SSE_SESSIONS) {
      sendJson(res, 503, {
        status_code: 503,
        error: "Service Unavailable",
        error_message: "Too many open SSE sessions. Retry shortly, or use the Streamable HTTP transport at POST /mcp.",
      });
      return;
    }
    pendingOpens++;
    try {
      await openStream(req, res, apiKey);
    } finally {
      pendingOpens--;
    }
  }

  async function openStream(req: IncomingMessage, res: ServerResponse, apiKey: string): Promise<void> {
    // Admission performs upstream I/O. Remember a disconnect before awaiting it;
    // EventEmitter does not replay `close` to a listener installed afterwards.
    let disconnected = req.destroyed || res.destroyed;
    const markDisconnected = (): void => {
      disconnected = true;
    };
    res.once("close", markDisconnected);
    const stopWatchingEarlyClose = (): void => {
      res.off("close", markDisconnected);
    };

    // Admission control. Opening a stream makes the server hold resources, so
    // prove the key is real BEFORE allocating any — otherwise a credential-free
    // bot squats all 512 slots and real users get 503s.
    const verdict = await admitStream(apiKey, clientIp(req));
    if (disconnected || req.destroyed || res.destroyed) {
      stopWatchingEarlyClose();
      return;
    }
    if (!verdict.ok) {
      stopWatchingEarlyClose();
      sendJson(res, verdict.status, {
        status_code: verdict.status,
        error: verdict.status === 429 ? "Too Many Requests" : verdict.status === 503 ? "Service Unavailable" : "Unauthorized",
        error_message: verdict.message,
      });
      return;
    }
    // A stream open is a request too — meter it, or /sse is an unmetered door
    // (and the one that lets a validation stampede through).
    const streamToken = consumePrincipalRequestToken(verdict.keyId, verdict.userId);
    if (!streamToken.ok) {
      stopWatchingEarlyClose();
      res.setHeader("Retry-After", String(Math.ceil(streamToken.retryAfterMs / 1000)));
      sendJson(res, 429, {
        status_code: 429,
        error: "Too Many Requests",
        error_message: `Rate limit exceeded for this API key or user account. Retry in ${Math.ceil(streamToken.retryAfterMs / 1000)}s.`,
      });
      return;
    }
    const keyIdent = verdict.keyId;
    const limit = sessionLimitFor(verdict.funded);
    // Per-key ceiling: the global cap alone lets ONE keyholder starve everyone.
    // A $0 key is admitted but on a tighter allowance — it still needs
    // check_balance/get_task/dry_run_cost to top up and collect paid work.
    let open = 0;
    let openForUser = 0;
    for (const s of sseSessions.values()) {
      if (s.keyId === keyIdent) open++;
      if (s.userId === verdict.userId) openForUser++;
    }
    if (open >= limit) {
      stopWatchingEarlyClose();
      sendJson(res, 429, {
        status_code: 429,
        error: "Too Many Requests",
        error_message: `This API key already has ${open} open SSE stream(s) (limit ${limit}). Close one, or use POST /mcp which holds no session.`,
      });
      return;
    }
    if (openForUser >= limit) {
      stopWatchingEarlyClose();
      sendJson(res, 429, {
        status_code: 429,
        error: "Too Many Requests",
        error_message: `This user account already has ${openForUser} open SSE stream(s) across all API keys (limit ${limit}). Close one, or use POST /mcp which holds no session.`,
      });
      return;
    }
    // A session id is NOT a credential. Header-capable clients resend their key
    // on each POST; URL-only clients receive a random continuation credential in
    // the endpoint event. SSEServerTransport preserves it and appends sessionId.
    const arrivedViaQuery = !req.headers["authorization"] && !req.headers["x-api-key"];
    // URL-only clients need a credential in the endpoint event, but repeating
    // the billing key puts that long-lived secret into another URL/log. Use a
    // random session-scoped continuation token instead.
    const continuationToken = arrivedViaQuery ? randomBytes(32).toString("base64url") : undefined;
    const endpoint = continuationToken
      ? `/messages?session_token=${encodeURIComponent(continuationToken)}`
      : "/messages";
    const transport = new SSEServerTransport(endpoint, res);
    const server = createServer();
    const requestLeases = new SseRequestLeaseTracker();
    const sessionAbort = new AbortController();
    const sendSseMessage = transport.send.bind(transport);
    transport.send = async (message): Promise<void> => {
      try {
        await sendSseMessage(message);
      } finally {
        // POST /messages returns 202 before the MCP handler completes. Its
        // concurrency lease ends only when the matching result/error is sent.
        requestLeases.complete(message);
      }
    };
    let closed = false;
    let ping: NodeJS.Timeout | undefined;
    let maxLife: NodeJS.Timeout | undefined;
    let idleCheck: NodeJS.Timeout | undefined;

    const close = (why: string): void => {
      if (closed) return;
      closed = true;
      if (ping) clearInterval(ping);
      if (maxLife) clearTimeout(maxLife);
      if (idleCheck) clearInterval(idleCheck);
      sseSessions.delete(transport.sessionId);
      requestLeases.releaseAll();
      sessionAbort.abort(new Error(`SSE session closed: ${why}`));
      if (!res.destroyed && !res.writableEnded) {
        try {
          res.write(`: closed (${why})\n\n`);
        } catch {
          // socket already gone
        }
      }
      void server.close().catch((err) => log(`SSE close failed (${why}): ${String(err)}`));
    };

    sseSessions.set(transport.sessionId, {
      transport,
      requestLeases,
      abortSignal: sessionAbort.signal,
      apiKey,
      keyId: keyIdent,
      userId: verdict.userId,
      continuationTokenHash: continuationToken ? secretHash(continuationToken) : undefined,
      lastSeen: Date.now(),
      close,
    });

    // Comment-frame keepalive so idle streams survive proxy timeouts.
    ping = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        close("connection unavailable");
        return;
      }
      try {
        res.write(": keepalive\n\n");
      } catch {
        close("keepalive failed");
      }
    }, 25000);

    // The spec recommends rotating or expiring session ids. The keepalive above
    // would otherwise hold a stream open forever, so a bot that connects and goes
    // quiet keeps its slot indefinitely. Expire on idle and on absolute age.
    maxLife = setTimeout(() => close("max session lifetime"), SESSION_MAX_LIFETIME_MS);
    idleCheck = setInterval(() => {
      const s = sseSessions.get(transport.sessionId);
      if (s && Date.now() - s.lastSeen > SESSION_IDLE_TIMEOUT_MS) close("idle timeout");
    }, 60_000);

    // Hand off from the early sentinel to permanent teardown synchronously.
    res.once("close", () => close("client disconnected"));
    stopWatchingEarlyClose();

    try {
      await server.connect(transport); // sends the SSE headers + endpoint event
    } catch (err) {
      close("connection setup failed");
      throw err;
    }
  }

  async function handleSseMessage(req: IncomingMessage, res: ServerResponse, apiKey?: string): Promise<void> {
    let sessionId: string | null = null;
    let continuationToken: string | null = null;
    try {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      sessionId = params.get("sessionId");
      continuationToken = params.get("session_token");
    } catch {
      // fall through to the 400 below
    }
    const session = sessionId ? sseSessions.get(sessionId) : undefined;
    if (!session) {
      sendJson(res, 404, {
        status_code: 404,
        error: "Not Found",
        error_message: "Unknown or expired SSE session. Reconnect to GET /sse.",
      });
      return;
    }
    // The auth gate runs before /sse but not /messages — enforce it here.
    // A session id travels in URLs (proxy logs, Referer) and is therefore NOT
    // proof of identity: the MCP spec requires servers not to treat it as such.
    // Demand a key on this POST and require it to MATCH the one that opened the
    // stream, so a leaked session id can neither spend the opener's balance nor
    // inject attacker-chosen tool results into the opener's SSE stream.
    const keyAuthenticated = keysMatch(apiKey, session.apiKey);
    const tokenAuthenticated = Boolean(
      continuationToken &&
        session.continuationTokenHash &&
        keysMatch(secretHash(continuationToken), session.continuationTokenHash),
    );
    if (!keyAuthenticated && !tokenAuthenticated) {
      sendJson(res, 401, {
        status_code: 401,
        error: "Unauthorized",
        error_message: "Missing or mismatched credentials. Send the same API key used to open GET /sse, or use the session_token from its endpoint event.",
      });
      return;
    }
    // Same per-key budget as POST /mcp — a stream is not a bypass for it.
    const body = await readJsonBody(req);
    const messageCount = mcpMessageCount(body);
    const token = consumePrincipalRequestTokens(session.keyId, session.userId, messageCount);
    if (!token.ok) {
      res.setHeader("Retry-After", String(Math.ceil(token.retryAfterMs / 1000)));
      sendJson(res, 429, {
        status_code: 429,
        error: "Too Many Requests",
        error_message: `Rate limit exceeded for this API key or user account. Retry in ${Math.ceil(token.retryAfterMs / 1000)}s.`,
      });
      return;
    }
    const release = reserveMessages(session.keyId, session.userId, messageCount, res);
    if (!release) return;
    const tracking = session.requestLeases.track(body, release);
    if (tracking === "duplicate") {
      release();
      sendJson(res, 409, {
        status_code: 409,
        error: "Conflict",
        error_message: "This SSE session already has an in-flight request with the same JSON-RPC id.",
      });
      return;
    }
    session.lastSeen = Date.now(); // keep the idle sweep from reclaiming an active stream
    // Never fall back to the session's key: the caller proved it above.
    try {
      await withRequestContext({ apiKey: session.apiKey, signal: session.abortSignal }, async () => {
        await session.transport.handlePostMessage(req, res, body);
      });
      if (tracking === "tracked" && res.statusCode !== 202) {
        // The legacy SDK reports parse/validation failures directly on the POST
        // and never emits an SSE result for them.
        session.requestLeases.cancel(body);
      }
    } catch (err) {
      session.requestLeases.cancel(body);
      throw err;
    } finally {
      // Notifications and client responses have no future server result/error.
      // Requests stay reserved until transport.send observes that response.
      if (tracking === "notification") release();
    }
  }

  /**
   * The keyless door: MCP discovery without a credential.
   *
   * A registry that gets 401 on tools/list lists this server with no tools, and
   * a client whose key never got attached cannot tell its user what it was
   * missing. So initialize/tools/list/resources/list/ping run for anyone, and
   * every method that costs money or reads the account stays behind the key
   * (publicDiscovery.ts owns that allowlist and fails closed).
   *
   * Order matters here, because unlike every other path in this file there is
   * no key to validate and therefore no admitStream() to lean on:
   *   1. Method — only a POST carries a body we can classify.
   *   2. IP budget — charged BEFORE the body is read. Metering afterwards would
   *      hand an anonymous flood unlimited 512KB JSON.parse() calls for free.
   *   3. Classify — one privileged message anywhere in the body sends the whole
   *      request to 401.
   *   4. Concurrency — capped in aggregate, so keyless traffic cannot crowd out
   *      the paying callers.
   * No API key enters the request context, so even a classifier bug cannot
   * spend anything: the UnificAlly client refuses a keyless HTTP call outright.
   */
  async function handleAnonymousDiscovery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!cfg.publicDiscovery || req.method !== "POST") {
      unauthorized(res);
      return;
    }

    const ip = clientIp(req);
    const tooManyDiscoveries = (retryAfterMs: number): void => {
      res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      sendJson(res, 429, {
        status_code: 429,
        error: "Too Many Requests",
        error_message: `Too many unauthenticated discovery requests from this address. Retry in ${Math.ceil(retryAfterMs / 1000)}s, or send an API key for the full rate limit.`,
      });
    };

    // One token buys the right to be parsed at all; the rest of a batch is
    // charged once its size is known.
    const entry = consumeAnonymousDiscoveryTokens(ip, 1);
    if (!entry.ok) {
      tooManyDiscoveries(entry.retryAfterMs);
      return;
    }
    const body = await readJsonBody(req);
    const messageCount = mcpMessageCount(body);
    if (messageCount > 1) {
      const rest = consumeAnonymousDiscoveryTokens(ip, messageCount - 1);
      if (!rest.ok) {
        tooManyDiscoveries(rest.retryAfterMs);
        return;
      }
    }
    if (!isPublicDiscoveryBody(body)) {
      authRequiredForCall(res);
      return;
    }

    const reservation = reserveMessages(`anon:${ip}`, ANON_CONCURRENCY_USER, messageCount, res);
    if (!reservation) return;
    const release = releaseOnResponseClose(res, reservation);
    try {
      await handleMcpRequest(req, res, undefined, body);
    } finally {
      release();
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(res, cfg.corsOrigin);
    // Authentication may be supplied in a URL for URL-only clients. Do not let
    // browsers/proxies cache these responses or forward their URL as a Referer.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");

    // DNS-rebinding defense (spec MUST). Checked before auth: a browser page
    // driving this server is out of scope regardless of what key it presents.
    if (!originAllowed(req, cfg.corsOrigin)) {
      sendJson(res, 403, {
        status_code: 403,
        error: "Forbidden",
        error_message: "Origin not allowed. Set UNIFICALLY_CORS_ORIGIN to permit this origin.",
      });
      return;
    }

    // CORS preflight — never needs auth.
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const path = pathOf(req.url);

    // Health check for the platform (Coolify/Traefik) — never needs auth.
    if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    // Static MCP server card for registry scanners — unauthenticated so a
    // scanner can read the tool list without an API key.
    if (req.method === "GET" && path === "/.well-known/mcp/server-card.json") {
      sendJson(res, 200, serverCard());
      return;
    }

    // The credential this server needs, machine-readably. A listing built from
    // a free tools/list must still prompt the user for a key, or they land on a
    // 401 the first time they call something. Never authenticated: a client
    // that has no key yet is exactly who this is for.
    if (req.method === "GET" && (path === "/.well-known/mcp-config" || path === "/.well-known/mcp-config.json")) {
      sendJson(res, 200, CONFIG_SCHEMA);
      return;
    }

    // Humans and integrations probing the base URL get connect instructions.
    if (req.method === "GET" && path === "/") {
      sendJson(res, 200, landingBody());
      return;
    }

    const apiKey = extractApiKey(req);

    // Legacy SSE transport for older MCP clients.
    if (req.method === "GET" && path === "/sse") {
      if (!apiKey) return unauthorized(res);
      await handleSseOpen(req, res, apiKey);
      return;
    }
    if (req.method === "POST" && path === "/messages") {
      await handleSseMessage(req, res, apiKey);
      return;
    }
    // No key: discovery only, on its own tight budget. Everything else 401s.
    if (!apiKey) {
      await handleAnonymousDiscovery(req, res);
      return;
    }

    // POST /mcp is the primary transport and was the cheapest thing to attack:
    // it built a full McpServer per request behind a presence-only key check, and
    // tools/list never touches upstream — so junk keys bought unlimited CPU. Gate
    // it exactly like a stream open (format -> cache -> upstream, all memoized),
    // then rate-limit both the concrete key and its owning user account.
    const verdict = await admitStream(apiKey, clientIp(req));
    if (!verdict.ok) {
      sendJson(res, verdict.status, {
        status_code: verdict.status,
        error: verdict.status === 429 ? "Too Many Requests" : verdict.status === 503 ? "Service Unavailable" : "Unauthorized",
        error_message: verdict.message,
      });
      return;
    }
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    const messageCount = mcpMessageCount(body);
    const token = consumePrincipalRequestTokens(verdict.keyId, verdict.userId, messageCount);
    if (!token.ok) {
      res.setHeader("Retry-After", String(Math.ceil(token.retryAfterMs / 1000)));
      sendJson(res, 429, {
        status_code: 429,
        error: "Too Many Requests",
        error_message: `Rate limit exceeded for this API key or user account. Retry in ${Math.ceil(token.retryAfterMs / 1000)}s.`,
      });
      return;
    }
    const reservation = reserveMessages(verdict.keyId, verdict.userId, messageCount, res);
    if (!reservation) return;
    // A dead client must not leave its account charged forever. Normal response
    // completion and the surrounding finally share this idempotent release.
    const release = releaseOnResponseClose(res, reservation);
    try {
      await handleMcpRequest(req, res, apiKey, body);
    } finally {
      release();
    }
  }

  /**
   * `apiKey` is undefined only on the anonymous discovery path. It is passed
   * through to the request context as-is rather than falling back to anything:
   * a keyless context makes every UnificAlly call throw, which is the backstop
   * behind the method allowlist.
   */
  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, apiKey: string | undefined, body: unknown): Promise<void> {
    const clientAbort = new AbortController();
    const abortOnDisconnect = (): void => clientAbort.abort(new Error("MCP client disconnected"));
    res.once("close", abortOnDisconnect);
    try {
      await withRequestContext({ apiKey, signal: clientAbort.signal }, async () => {
        // Stateless: a fresh server + transport per request. No session state to
        // track, so the deployment scales horizontally behind any proxy.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = createServer();
        await server.connect(transport);
        let closing: Promise<void> | undefined;
        const closeServer = (): Promise<void> => {
          // Protocol owns its transport after connect(); closing both separately
          // races two transport.close() calls and can fire onclose twice.
          closing ??= server.close().catch((err) => {
            log(`Streamable HTTP close failed: ${String(err)}`);
          });
          return closing;
        };
        const onResponseClose = (): void => {
          void closeServer();
        };
        res.once("close", onResponseClose);
        try {
          await transport.handleRequest(req, res, body);
        } finally {
          res.off("close", onResponseClose);
          await closeServer();
        }
      });
    } finally {
      res.off("close", abortOnDisconnect);
    }
  }

  // Bound how long an unfinished request may hold a socket (slowloris), and how
  // many sockets exist at all. SSE responses stream for a long time, but these
  // govern REQUEST receipt, so long-lived streams are unaffected.
  httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpServer.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
  httpServer.maxConnections = MAX_SOCKETS;

  httpServer.listen(cfg.port, "0.0.0.0", () => {
    const mode = cfg.publicDiscovery
      ? "per-request API key required to call a tool (Bearer / X-API-Key / ?api_key=); tools/list is public"
      : "per-request API key required (Bearer / X-API-Key / ?api_key=)";
    log(`v${SERVER_VERSION} http listening on 0.0.0.0:${cfg.port} — ${mode}. Endpoints: /mcp (streamable), /sse (legacy), /health.`);
  });

  // Node often runs as PID 1 in the container; without this, docker stop /
  // every redeploy hangs for the grace period and then SIGKILLs mid-request.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received — shutting down.`);
    // httpServer.close() waits for long-lived SSE sockets. Close them explicitly
    // so timers, leases, transports, and session credentials are reclaimed.
    for (const session of [...sseSessions.values()]) {
      session.close("server shutdown");
    }
    httpServer.close(() => process.exit(0));
    // In-flight generations can hold the server open past any proxy's
    // patience; force-exit after a short drain window.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function printHelp(): void {
  process.stdout.write(
    `${SERVER_NAME} v${SERVER_VERSION} — MCP server for the UnificAlly generative-media API.\n\n` +
      `Usage:\n` +
      `  UNIFICALLY_API_KEY=sk-... npx -y @unifically/mcp-server\n\n` +
      `Transports:\n` +
      `  stdio (default) — for Cursor, Claude Desktop, Cline, Windsurf, Zed, etc.\n` +
      `  http            — set MCP_TRANSPORT=http. Serves Streamable HTTP on any path,\n` +
      `                    legacy SSE at /sse, health at /health. API key per request via\n` +
      `                    Bearer / X-API-Key / ?api_key=.\n\n` +
      `Get an API key: https://unifically.com/api-keys\n` +
      `Docs: https://docs.unifically.com\n`,
  );
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") {
    printHelp();
    return;
  }
  if (arg === "--version" || arg === "-v") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const cfg = getConfig();
  if (cfg.transport === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, err);
  process.exit(1);
});
