import { getConfig, getRequestApiKey, getRequestSignal } from "./config.js";
import { isUnknownTaskMessage, TaskFailedError, TaskTimeoutError, UnificallyError } from "./errors.js";

export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskOutput {
  video_url?: string;
  image_url?: string;
  audio_url?: string;
  image_urls?: string[];
  audio_urls?: string[];
  text?: string;
  [key: string]: unknown;
}

export interface CreateTaskParams {
  model: string;
  input: Record<string, unknown>;
  callback_url?: string;
}

export interface CreateTaskResponse {
  task_id: string;
  status: TaskStatus;
}

export interface GetTaskResponse {
  task_id: string;
  status: TaskStatus;
  output?: TaskOutput;
  cost_usd?: number;
  error_message?: string;
  [key: string]: unknown;
}

export interface DryRunResponse {
  cost: number;
}

export interface AccountResponse {
  user_id: number;
  balance_usd: number;
  email: string;
  created_at?: number;
  updated_at?: number;
  [key: string]: unknown;
}

export interface Voice {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
  [key: string]: unknown;
}

export interface VoicesResponse {
  voices: Voice[];
}

interface EnvelopeOk<T> {
  success: true;
  code: number;
  data: T;
}

interface EnvelopeErr {
  success: false;
  code: number;
  data?: { message?: string };
  message?: string;
}

type Envelope<T> = EnvelopeOk<T> | EnvelopeErr;

export interface RequestContext {
  apiKey?: string;
  signal?: AbortSignal;
}

/**
 * HTTP callers must always supply their own key. The environment key is a local
 * stdio convenience only; never let an HTTP request silently spend it.
 */
export function resolveApiKey(ctx: RequestContext): string {
  const cfg = getConfig();
  return ctx.apiKey ?? getRequestApiKey() ?? (cfg.transport === "stdio" ? cfg.apiKey : "");
}

/**
 * The keyless failure, worded for whoever actually hit it. On stdio the user
 * forgot an env var; over HTTP the caller reached a tool without a credential —
 * possible only if the discovery allowlist ever let a non-discovery method
 * through, which is exactly when a truthful message matters most.
 */
export function missingApiKeyError(): UnificallyError {
  return new UnificallyError(
    401,
    getConfig().transport === "stdio"
      ? "UNIFICALLY_API_KEY is not configured"
      : "This tool needs an API key. Send 'Authorization: Bearer <key>' with the request (get one at https://unifically.com/api-keys); listing tools works without one, running them does not.",
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(done, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    function done(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// 429 and 5xx are transient; a network hiccup throws before we get a status.
function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

interface RequestOptions {
  /**
   * "full" (default): retry 429/408/5xx and network errors — safe for reads
   * and idempotent calls. "create": the request spends money and the server
   * may have accepted it even when we saw a timeout or 5xx, so retry ONLY
   * 429 (a rate limiter rejects before creating anything). Prevents duplicate
   * paid tasks.
   */
  retryMode?: "full" | "create";
  /** Per-call override of the request timeout (e.g. budgeted status polls). */
  timeoutMs?: number;
  /** Per-call override of the retry count. */
  maxRetries?: number;
}

const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_RESPONSE_BYTES = 1024 * 1024;

class ResponseTooLargeError extends Error {}

/** Read a response body under the same AbortSignal as fetch, with a byte cap. */
export async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ResponseTooLargeError(`Response exceeded ${Math.round(maxBytes / 1024)}KB.`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(`Response exceeded ${Math.round(maxBytes / 1024)}KB.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function request<T>(
  path: string,
  init: RequestInit & { body?: string } = {},
  ctx: RequestContext = {},
  opts: RequestOptions = {},
): Promise<T> {
  const cfg = getConfig();
  const apiKey = resolveApiKey(ctx);
  if (!apiKey) {
    throw missingApiKeyError();
  }
  const url = `${cfg.baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": "unifically-mcp",
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (init.body !== undefined && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = "application/json";
  }

  const timeoutMs = Math.max(1000, opts.timeoutMs ?? cfg.requestTimeoutMs);
  const maxRetries = opts.maxRetries ?? cfg.maxRetries;
  const callerSignal = ctx.signal ?? getRequestSignal();
  if (callerSignal?.aborted) {
    throw new Error("Request cancelled because the MCP client disconnected.");
  }
  const start = Date.now();
  // On the hosted HTTP transport a proxy (Cloudflare) kills any response near
  // ~100s. Left unbounded, a degraded upstream lets one read tool burn
  // maxRetries × timeout (~240s) server-side long after the client already got
  // a 524. Cap the TOTAL wall-clock across attempts to the HTTP wait budget so
  // the work stops when the client's connection would already be dead. Skip
  // callers that set their own timeout (budgeted status polls manage it), and
  // stdio has no such proxy so it keeps the full per-attempt budget.
  const overallDeadline =
    cfg.transport === "http" && opts.timeoutMs === undefined
      ? start + cfg.httpWaitBudgetMs
      : undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const remainingBudget = overallDeadline === undefined ? Infinity : overallDeadline - Date.now();
    if (remainingBudget <= 0) break;
    const attemptTimeout =
      overallDeadline === undefined ? timeoutMs : Math.max(1000, Math.min(timeoutMs, remainingBudget));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeout);
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, { ...init, headers, signal: controller.signal });
      // fetch() resolves as soon as headers arrive. Keep the timeout active until
      // the final body byte is received, and bound memory even for chunked data.
      text = await readResponseTextLimited(response, MAX_API_RESPONSE_BYTES);
    } catch (err) {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      if (err instanceof ResponseTooLargeError) {
        throw new UnificallyError(502, `Oversized response from ${path}; refused for safety.`);
      }
      const aborted = (err as Error)?.name === "AbortError";
      const callerAborted = callerSignal?.aborted === true;
      lastError = callerAborted
        ? new Error("Request cancelled because the MCP client disconnected.")
        : aborted
        ? new Error(`Request to ${path} timed out after ${attemptTimeout}ms`)
        : new Error(`Network error calling ${path}: ${(err as Error).message}`);
      if (callerAborted) throw lastError;
      // A timed-out/failed create may still have been accepted server-side —
      // never blind-retry it into a duplicate paid task.
      if (opts.retryMode !== "create" && attempt < maxRetries) {
        const wait = backoffMs(attempt);
        // Don't sleep past the proxy deadline just to retry into a dead socket.
        if (overallDeadline !== undefined && Date.now() + wait >= overallDeadline) throw lastError;
        await sleep(wait, callerSignal);
        continue;
      }
      throw lastError;
    }
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);

    let payload: Envelope<T> | undefined;
    if (text) {
      try {
        payload = JSON.parse(text) as Envelope<T>;
      } catch {
        throw new UnificallyError(response.status, `Non-JSON response: ${text.slice(0, 200)}`);
      }
    }

    if (!response.ok || !payload || payload.success === false) {
      const code = payload?.code ?? response.status;
      const message =
        (payload && payload.success === false && (payload.data?.message ?? payload.message)) ||
        response.statusText ||
        "Unknown error";
      // "Unknown task id" masquerades as a 500 — retrying can't help it.
      // In "create" mode only a 429 is provably side-effect-free to retry.
      const retriable = opts.retryMode === "create" ? code === 429 : isRetriableStatus(code);
      if (retriable && attempt < maxRetries && !isUnknownTaskMessage(message)) {
        const wait = retryAfterMs(response) ?? backoffMs(attempt);
        // Respect the proxy deadline: a Retry-After of 30s near the cutoff is
        // wasted server work the client will never see.
        if (overallDeadline !== undefined && Date.now() + wait >= overallDeadline) {
          throw new UnificallyError(code, message);
        }
        await sleep(wait, callerSignal);
        continue;
      }
      throw new UnificallyError(code, message);
    }
    return payload.data;
  }
  // Loop always returns or throws, but TypeScript needs a terminal throw.
  throw lastError ?? new Error(`Request to ${path} failed`);
}

function backoffMs(attempt: number): number {
  // 0.5s, 1s, 2s ... with light jitter, capped.
  const base = Math.min(500 * 2 ** attempt, 8000);
  return base + Math.floor(base * 0.2 * Math.random());
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30000);
  return undefined;
}

export function createTask(
  params: CreateTaskParams,
  ctx: RequestContext = {},
): Promise<CreateTaskResponse> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: params.input,
  };
  if (params.callback_url) body.callback_url = params.callback_url;
  return request<CreateTaskResponse>(
    "/v1/tasks",
    { method: "POST", body: JSON.stringify(body) },
    ctx,
    { retryMode: "create" },
  );
}

export function dryRunTask(
  params: CreateTaskParams,
  ctx: RequestContext = {},
): Promise<DryRunResponse> {
  const body = {
    model: params.model,
    input: params.input,
    dry_run: true,
  };
  return request<DryRunResponse>(
    "/v1/tasks",
    // Same POST /v1/tasks path as createTask, so inherit its no-blind-retry rule:
    // safe today only because dry_run:true is honored upstream, and a retry that
    // ever lost that flag would create real paid tasks. Defense in depth.
    { method: "POST", body: JSON.stringify(body) },
    ctx,
    { retryMode: "create" },
  );
}

export function getTask(
  taskId: string,
  ctx: RequestContext = {},
  opts: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<GetTaskResponse> {
  return request<GetTaskResponse>(
    `/v1/tasks/${encodeURIComponent(taskId)}`,
    { method: "GET" },
    ctx,
    opts,
  );
}

export function getAccount(ctx: RequestContext = {}, opts: RequestOptions = {}): Promise<AccountResponse> {
  // opts lets admission probe with maxRetries:0 — that call is a liveness check
  // on a hot path, not a user's read, and the default 3 retries would multiply
  // an upstream wobble by 4x exactly when upstream is already struggling.
  return request<AccountResponse>("/account", { method: "GET" }, ctx, opts);
}

export interface ListTasksParams {
  page?: number;
  page_size?: number;
  status?: "processing" | "completed" | "failed";
  model?: string;
  /** CSV of llm, video, image, audio, text. */
  category?: string;
  /** CSV of provider slugs (the part of the model id before the slash). */
  provider?: string;
  /** Unix seconds, inclusive. */
  created_after?: number;
  /** Unix seconds, inclusive. */
  created_before?: number;
}

export interface TaskListItem {
  task_id: string;
  model: string;
  status: "processing" | "completed" | "failed";
  cost: number;
  created_at: number;
  error_message?: string;
  /** The original request, shaped { model, input: {...} }; null for some tasks. */
  input?: { model?: string; input?: Record<string, unknown> } | null;
  output?: TaskOutput | null;
  [key: string]: unknown;
}

export interface ListTasksResponse {
  tasks: TaskListItem[];
  /** Present only if the API sends a pagination wrapper; the live API returns a bare array. */
  pagination?: {
    page?: number;
    page_size?: number;
    total?: number;
    total_pages?: number;
    has_next?: boolean;
    has_previous?: boolean;
    [key: string]: unknown;
  };
}

export async function listTasks(
  params: ListTasksParams = {},
  ctx: RequestContext = {},
): Promise<ListTasksResponse> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const qs = query.toString();
  const data = await request<unknown>(`/v1/tasks${qs ? `?${qs}` : ""}`, { method: "GET" }, ctx);
  // Live API: data is a bare array. Tolerate a { tasks, pagination } wrapper too.
  if (Array.isArray(data)) return { tasks: data as TaskListItem[] };
  const obj = data as { tasks?: TaskListItem[]; pagination?: ListTasksResponse["pagination"] };
  return { tasks: obj?.tasks ?? [], pagination: obj?.pagination };
}

export interface PresignedUpload {
  /** PUT the raw file here. Requires NO credential — that is the entire point. */
  upload_url: string;
  /** Where the file will be served once uploaded. Known before the upload runs. */
  file_url: string;
  expires_at: number;
}

/**
 * Mint a keyless, single-use upload URL.
 *
 * This is what closes the hole that had agents shipping users' private photos to
 * tmpfiles.org: the MCP holds the API key but cannot see the caller's files, and
 * the agent holds the file but has no key (it lives in the MCP client's config
 * and never reaches the agent's shell). Uploading to files.unifically.com needs a
 * key — verified, a keyless PUT returns 401 — so the agent literally could not
 * comply, and improvised to a host that needed no auth.
 *
 * So the MCP spends its key HERE, on the caller's behalf, and hands back a URL
 * that needs no credential. Minting is authenticated; the resulting URL is
 * signed, single-use ("Upload URL already used" on replay) and short-lived.
 *
 * The endpoint also accepts an optional `size`, deliberately not sent: it is not
 * enforced (a declared 75 accepts 5,075 bytes), so it would only be a field for
 * the agent to guess at and get wrong.
 */
export function presignUpload(
  params: { content_type: string },
  ctx: RequestContext = {},
): Promise<PresignedUpload> {
  const cfg = getConfig();
  const apiKey = resolveApiKey(ctx);
  if (!apiKey) throw missingApiKeyError();
  return requestAbsolute<PresignedUpload>(
    `${cfg.filesBaseUrl}/presign`,
    apiKey,
    { content_type: params.content_type },
    ctx.signal ?? getRequestSignal(),
  );
}

/**
 * POST JSON to an absolute URL on the files host. The files service is a separate
 * origin from the API, so it does not go through request(), which is bound to
 * cfg.baseUrl.
 */
async function requestAbsolute<T>(url: string, apiKey: string, body: unknown, callerSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        // Cloudflare 403s a bare/absent UA — send the same one as every other call.
        "User-Agent": "unifically-mcp",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await readResponseTextLimited(res, MAX_UPLOAD_RESPONSE_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (!res.ok) {
      const msg =
        (payload as { message?: string } | undefined)?.message ?? res.statusText ?? `HTTP ${res.status}`;
      throw new UnificallyError(res.status, msg);
    }
    return payload as T;
  } catch (err) {
    if (err instanceof UnificallyError) throw err;
    if (err instanceof ResponseTooLargeError) {
      throw new UnificallyError(502, "Upload service returned an oversized response; refused for safety.");
    }
    if ((err as { name?: string }).name === "AbortError") {
      if (callerSignal?.aborted) throw new Error("Request cancelled because the MCP client disconnected.");
      throw new UnificallyError(504, "Timed out asking for an upload URL. Retry.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

// No base64 member, deliberately. The upload API accepts one, but exposing it
// through an MCP tool made agents re-encode the user's file down to a size that
// fits a token-by-token channel. Raw bytes (`data`) or a URL cover every real
// case at full quality — see src/tools/uploadFile.ts.
export interface UploadSource {
  /** Publicly accessible URL to import into storage. */
  url?: string;
  /** Raw file bytes (e.g. read from a local path). Requires `filename`. */
  data?: Uint8Array;
  filename?: string;
}

export interface UploadResult {
  file_url: string;
}

/**
 * Upload a file to UnificAlly storage and get back a public URL, so media that
 * lives on disk or in memory can be handed to the generation models (which only
 * accept public URLs). The storage service returns a flat `{ success, file_url }`
 * body — not the standard `{ success, code, data }` envelope — so this uses its
 * own fetch rather than `request()`.
 */
export async function uploadFile(
  source: UploadSource,
  ctx: RequestContext = {},
): Promise<UploadResult> {
  const cfg = getConfig();
  const apiKey = resolveApiKey(ctx);
  if (!apiKey) {
    throw missingApiKeyError();
  }
  const endpoint = `${cfg.filesBaseUrl}/upload`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": "unifically-mcp",
  };

  let body: BodyInit;
  if (source.data !== undefined) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(source.data)]), source.filename ?? "upload");
    body = form; // fetch sets the multipart Content-Type + boundary automatically.
  } else if (source.url !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ file_url: source.url });
  } else {
    throw new Error("uploadFile requires one of: data or url");
  }

  // On the hosted HTTP transport the proxy kills the connection near ~100s, so
  // waiting the full 300s import budget is wasted work the client never sees —
  // clamp to the HTTP wait budget there. stdio (local, no proxy) keeps 300s.
  const uploadTimeoutMs =
    cfg.transport === "http" ? Math.min(cfg.uploadTimeoutMs, cfg.httpWaitBudgetMs) : cfg.uploadTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), uploadTimeoutMs);
  const callerSignal = ctx.signal ?? getRequestSignal();
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  let response: Response;
  let text: string;
  try {
    response = await fetch(endpoint, { method: "PUT", headers, body, signal: controller.signal });
    // Do not stop the timeout at headers: a server can send headers promptly and
    // then trickle an unlimited body forever.
    text = await readResponseTextLimited(response, MAX_UPLOAD_RESPONSE_BYTES);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      throw new UnificallyError(502, "Upload service returned an oversized response; refused for safety.");
    }
    const aborted = (err as Error)?.name === "AbortError";
    throw new Error(
      callerSignal?.aborted
        ? "File upload cancelled because the MCP client disconnected."
        : aborted
        ? `File upload timed out after ${Math.round(uploadTimeoutMs / 1000)}s. Large url-imports may still complete server-side — retry once; if it keeps timing out, upload the file directly with curl to ${cfg.filesBaseUrl}/upload.`
        : `Network error uploading file: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }

  let payload: { success?: boolean; file_url?: string; message?: string; data?: { message?: string } } = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new UnificallyError(response.status, `Non-JSON upload response: ${text.slice(0, 200)}`);
    }
  }
  if (!response.ok || payload.success === false || !payload.file_url) {
    const message = payload.message ?? payload.data?.message ?? response.statusText ?? "Upload failed";
    throw new UnificallyError(response.status, message);
  }
  return { file_url: payload.file_url };
}

export function listVoices(ctx: RequestContext = {}): Promise<VoicesResponse> {
  return request<VoicesResponse>("/v1/resources/elevenlabs/voices", { method: "GET" }, ctx);
}

/**
 * Fetch any provider resource under /v1/resources/*. The endpoints return
 * different shapes (a bare array for Kling/Veo voices, an object for the Suno
 * verification phrase, { voices: [] } for ElevenLabs), so the caller types the
 * returned `data` itself. `path` must start with the /v1/resources/ segment.
 */
export function getProviderResource<T = unknown>(path: string, ctx: RequestContext = {}): Promise<T> {
  return request<T>(path, { method: "GET" }, ctx);
}

/**
 * Live model catalog from GET /v1/models (OpenAI-style list).
 *
 * The item shape is in flux, so models.ts tolerates all of it rather than
 * pinning one version:
 *   - { id, owned_by, display_name, input_modalities, output_modalities } —
 *     current: no category; the kind is inferred from output_modalities.
 *   - { id, ..., category } — incoming: an explicit llm|video|image|audio,
 *     with the modality arrays dropped.
 *   - { key, provider, ... } — legacy.
 * Returns the raw item array; models.ts normalizes it.
 */
export function getModelCatalog(ctx: RequestContext = {}): Promise<unknown> {
  return request<unknown>("/v1/models", { method: "GET" }, ctx);
}

export async function waitForTask(
  taskId: string,
  ctx: RequestContext = {},
  budgetMs?: number,
): Promise<GetTaskResponse> {
  const cfg = getConfig();
  const budget = budgetMs ?? cfg.pollTimeoutMs;
  const start = Date.now();
  let delay = cfg.pollStartMs;

  while (Date.now() - start < budget) {
    // Cap the sleep to the remaining budget so we don't overshoot by a full
    // poll interval right at the deadline.
    await sleep(
      Math.min(delay, Math.max(0, budget - (Date.now() - start))),
      ctx.signal ?? getRequestSignal(),
    );
    let task: GetTaskResponse;
    try {
      // Cap each poll to the remaining budget so one hung request can't blow
      // past the deadline; the loop is the retry mechanism, so no inner retries.
      const remaining = budget - (Date.now() - start);
      if (remaining <= 0) break;
      task = await getTask(taskId, ctx, {
        timeoutMs: Math.min(cfg.requestTimeoutMs, remaining),
        maxRetries: 0,
      });
    } catch (err) {
      // The task exists and is still running server-side; one flaky status
      // poll must not abort a paid generation. Only a definitive "no such
      // task" ends the wait — anything else keeps polling until the budget.
      if (err instanceof UnificallyError && isUnknownTaskMessage(err.apiMessage)) throw err;
      delay = Math.min(Math.round(delay * 1.5), cfg.pollMaxMs);
      continue;
    }
    if (task.status === "completed") return task;
    if (task.status === "failed") {
      throw new TaskFailedError(taskId, task.error_message ?? "Task failed");
    }
    delay = Math.min(Math.round(delay * 1.5), cfg.pollMaxMs);
  }
  throw new TaskTimeoutError(taskId, budget);
}
