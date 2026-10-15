import { AsyncLocalStorage } from "node:async_hooks";

import { resolveModel } from "./aliases.js";

interface RequestExecutionContext {
  apiKey?: string;
  signal?: AbortSignal;
}

const requestStorage = new AsyncLocalStorage<RequestExecutionContext>();

export function withRequestContext<T>(
  ctx: RequestExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return requestStorage.run(ctx, fn);
}

export function getRequestApiKey(): string | undefined {
  return requestStorage.getStore()?.apiKey;
}

export function getRequestSignal(): AbortSignal | undefined {
  return requestStorage.getStore()?.signal;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got: ${raw}`);
  }
  return parsed;
}

function truthy(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Like truthy(), but for a switch that defaults ON — an unset/garbage value keeps the default. */
function enabled(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return fallback;
}

// Accept several common spellings so setup "just works" no matter what the
// user pasted into their client config.
const API_KEY_ENV_NAMES = [
  "UNIFICALLY_API_KEY",
  "UNIFICALLY_KEY",
  "UNIFICALLY_TOKEN",
  "UNIFICALLY_API_TOKEN",
] as const;

function readApiKey(): string {
  for (const name of API_KEY_ENV_NAMES) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return "";
}

export interface Config {
  apiKey: string;
  baseUrl: string;
  /** Base URL of the file storage service used by upload_file / auto-upload. */
  filesBaseUrl: string;
  pollTimeoutMs: number;
  pollStartMs: number;
  pollMaxMs: number;
  /**
   * HTTP transport only: max time a tool call blocks waiting for a task
   * before returning a "still processing, poll get_task" result. Cloudflare
   * and most proxies kill silent responses at ~100s; staying under that means
   * the client always receives the task_id instead of a 524.
   */
  httpWaitBudgetMs: number;
  /**
   * stdio transport: max blocking wait before returning the task_id. MCP
   * clients enforce their own per-tool-call timeouts (often 1-5 min); if we
   * outlast them, the client aborts and the task_id is lost with it.
   */
  stdioWaitBudgetMs: number;
  /** Timeout for storage uploads/imports (bigger files, server-side fetches). */
  uploadTimeoutMs: number;
  /**
   * When set, generation calls whose dry-run cost exceeds this many USD return a
   * confirmation prompt instead of running, unless confirm_cost=true is passed.
   * `null` (the default) disables the gate entirely so generations run in one
   * step — use dry_run_cost when you want a price up front.
   */
  confirmCostAbove: number | null;
  requestTimeoutMs: number;
  maxRetries: number;
  transport: "stdio" | "http";
  port: number;
  /** Value for Access-Control-Allow-Origin (default "*"). */
  corsOrigin: string;
  /**
   * HTTP transport: let an unauthenticated caller run the discovery methods
   * (initialize, tools/list, resources/list, ping) so registries and clients
   * can see the tool surface without a key. Calling a tool always needs one.
   * Set UNIFICALLY_PUBLIC_DISCOVERY=0 to require a key for every request.
   */
  publicDiscovery: boolean;
  /**
   * Hard per-task spend ceiling in USD. A generation whose dry-run cost
   * exceeds this is rejected outright — unlike confirmCostAbove, confirm_cost
   * cannot bypass it. `null` (default) disables the cap.
   */
  maxCostPerTask: number | null;
  /** Lowercased resolved model ids the operator has blocked. Empty = none. */
  blockedModels: string[];
  /** Lowercased resolved model ids — if non-null, ONLY these may run. */
  allowedModels: string[] | null;
  /** When true, paid generation tools refuse to run (read-only server). */
  disableGeneration: boolean;
}

let cached: Config | undefined;

function readConfirmCostAbove(): number | null {
  // Prefer the clearer new name; fall back to the legacy one for compatibility.
  const raw =
    process.env.UNIFICALLY_CONFIRM_COST_ABOVE ??
    process.env.UNIFICALLY_DRY_RUN_THRESHOLD;
  if (raw === undefined || raw === "") return null; // gate off by default
  const lowered = raw.toLowerCase();
  if (lowered === "off" || lowered === "none" || lowered === "false") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`UNIFICALLY_CONFIRM_COST_ABOVE must be a non-negative number or "off", got: ${raw}`);
  }
  return parsed;
}

function readMaxCostPerTask(): number | null {
  const raw = process.env.UNIFICALLY_MAX_COST_PER_TASK;
  if (raw === undefined || raw === "") return null;
  const lowered = raw.toLowerCase();
  if (lowered === "off" || lowered === "none" || lowered === "false") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`UNIFICALLY_MAX_COST_PER_TASK must be a non-negative number or "off", got: ${raw}`);
  }
  return parsed;
}

// Parse a CSV of model aliases/ids into lowercased resolved model ids so the
// operator can write "veo" and it gates google/veo-3.1-fast.
function readModelList(name: string): string[] {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => resolveModel(entry, entry).toLowerCase());
}

export function getConfig(): Config {
  if (cached) return cached;

  const apiKey = readApiKey();
  const baseUrl = (process.env.UNIFICALLY_BASE_URL ?? "https://api.unifically.com").replace(/\/+$/, "");
  const filesBaseUrl = (process.env.UNIFICALLY_FILES_BASE_URL ?? "https://files.unifically.com").replace(/\/+$/, "");
  const transportRaw = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  const transport: "stdio" | "http" = transportRaw === "http" ? "http" : "stdio";

  const pollStartMs = Math.max(1000, num("UNIFICALLY_POLL_START_MS", 2000));
  const pollMaxMs = Math.max(pollStartMs, num("UNIFICALLY_POLL_MAX_MS", 10000));
  const pollTimeoutMs = Math.max(pollStartMs, num("UNIFICALLY_POLL_TIMEOUT_MS", 600000));

  cached = {
    apiKey,
    baseUrl,
    filesBaseUrl,
    pollTimeoutMs,
    pollStartMs,
    pollMaxMs,
    httpWaitBudgetMs: Math.max(5000, num("UNIFICALLY_HTTP_WAIT_BUDGET_MS", 85000)),
    stdioWaitBudgetMs: Math.max(5000, num("UNIFICALLY_STDIO_WAIT_BUDGET_MS", 240000)),
    // Uploads (especially { url } imports the storage service must download
    // first) can far outlast a normal API call.
    uploadTimeoutMs: Math.max(10000, num("UNIFICALLY_UPLOAD_TIMEOUT_MS", 300000)),
    confirmCostAbove: readConfirmCostAbove(),
    requestTimeoutMs: Math.max(1000, num("UNIFICALLY_REQUEST_TIMEOUT_MS", 60000)),
    maxRetries: Math.max(0, Math.trunc(num("UNIFICALLY_MAX_RETRIES", 3))),
    transport,
    port: num("PORT", 8787),
    // HTTP always requires the caller's own API key. A permissive browser origin
    // therefore does not expose a host-side billing credential (there is none).
    corsOrigin: process.env.UNIFICALLY_CORS_ORIGIN?.trim() || "*",
    publicDiscovery: enabled("UNIFICALLY_PUBLIC_DISCOVERY", true),
    maxCostPerTask: readMaxCostPerTask(),
    blockedModels: readModelList("UNIFICALLY_BLOCKED_MODELS"),
    allowedModels: process.env.UNIFICALLY_ALLOWED_MODELS?.trim() ? readModelList("UNIFICALLY_ALLOWED_MODELS") : null,
    disableGeneration: truthy("UNIFICALLY_DISABLE_GENERATION"),
  };
  return cached;
}

/**
 * Operator model gate. Returns a caller-facing reason string if the resolved
 * model id is not permitted, or null if it may run.
 */
export function modelBlockedReason(modelId: string): string | null {
  const cfg = getConfig();
  const id = modelId.toLowerCase();
  if (cfg.blockedModels.includes(id)) {
    return `Model '${modelId}' is disabled on this server. Call list_models for the available catalog.`;
  }
  if (cfg.allowedModels && !cfg.allowedModels.includes(id)) {
    return `Model '${modelId}' is not permitted on this server. Call list_models to see which models are available.`;
  }
  return null;
}

export function hasApiKey(): boolean {
  return readApiKey() !== "" || getRequestApiKey() !== undefined;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
