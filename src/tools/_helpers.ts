import { getConfig, modelBlockedReason } from "../config.js";
import { mapErrorToTextMessage, TaskFailedError, TaskTimeoutError, toolError, UnificallyError } from "../errors.js";
import { runCostGate } from "../cost.js";
import { looksLikeBase64 } from "../media.js";
import { assertSafeRemoteUrl } from "../urlSafety.js";
import { DIRECT_UPLOAD_HINT } from "../uploadHint.js";
import { fenceUntrusted, sanitizeUntrusted } from "../untrusted.js";
import {
  createTask,
  getAccount,
  waitForTask,
  type GetTaskResponse,
  type RequestContext,
  type TaskOutput,
} from "../unifically.js";

// Envelope keys of a task read: everything else on a completed task is its result.
const TASK_ENVELOPE_KEYS = new Set(["task_id", "status", "output", "cost", "cost_usd", "error_message", "error"]);

/**
 * The result of a completed task. Most models nest it under `output`, but some
 * shapes sit at the top level of the task: Suno songs (`audio_url1`,
 * `audio_url2`, `clips` with each clip's id), cover art (`images`), lyrics
 * (`lyrics_a`/`lyrics_b`), exports (`wav_url`). Reading only `output` dropped
 * all of those, so fall back to the top-level fields.
 */
export function taskOutput(task: GetTaskResponse): TaskOutput {
  if (task.output && typeof task.output === "object") return task.output;
  const rest: TaskOutput = {};
  for (const [key, value] of Object.entries(task)) {
    if (!TASK_ENVELOPE_KEYS.has(key)) rest[key] = value;
  }
  return rest;
}

export type ToolResult =
  | {
      isError?: false;
      content: Array<{ type: "text"; text: string }>;
      structuredContent: Record<string, unknown>;
    }
  | { isError: true; content: Array<{ type: "text"; text: string }> };

export type GenerationKind = "video" | "image" | "audio" | "upscale" | "transcription";

export interface RunGenerationArgs {
  kind: GenerationKind;
  model: string;
  input: Record<string, unknown>;
  callback_url?: string;
  confirm_cost?: boolean;
  /** Default true. When false, return the task_id right away instead of waiting. */
  wait?: boolean;
}

// Which url-key names carry the actual deliverable, per generation kind.
// Suno clips, for example, hold cover-art image_url and a video_url next to
// the audio_url — for an audio generation the audio one is the result.
const KIND_KEY_PREFERENCE: Partial<Record<GenerationKind, RegExp>> = {
  audio: /audio/i,
  video: /video/i,
  image: /image/i,
};

/**
 * Collect every https URL under url-ish keys in a task output (up to 3 levels
 * deep — Suno nests clips), deduped, with keys matching the expected kind
 * first so a cover-art image is never presented as the generated song.
 */
export function collectUrls(output: TaskOutput, kind?: GenerationKind): string[] {
  const hits: Array<{ key: string; url: string }> = [];
  walkForUrls(output, 0, hits);
  const seen = new Set<string>();
  const unique = hits.filter((h) => {
    if (seen.has(h.url)) return false;
    seen.add(h.url);
    return true;
  });
  const prefer = kind ? KIND_KEY_PREFERENCE[kind] : undefined;
  if (!prefer) return unique.map((h) => h.url);
  const preferred = unique.filter((h) => prefer.test(h.key));
  const rest = unique.filter((h) => !prefer.test(h.key));
  // When kind-matching URLs exist, they ARE the result — don't muddy the text
  // with thumbnails/covers.
  return (preferred.length > 0 ? preferred : rest).map((h) => h.url);
}

function walkForUrls(value: unknown, depth: number, hits: Array<{ key: string; url: string }>): void {
  if (value === null || value === undefined || depth > 3) return;
  if (Array.isArray(value)) {
    for (const item of value) walkForUrls(item, depth + 1, hits);
    return;
  }
  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (/url/i.test(key)) {
        if (typeof v === "string" && /^https?:\/\//i.test(v)) hits.push({ key, url: v });
        else if (Array.isArray(v)) {
          for (const item of v) {
            if (typeof item === "string" && /^https?:\/\//i.test(item)) hits.push({ key, url: item });
          }
        }
      }
      if (typeof v === "object" && v !== null) walkForUrls(v, depth + 1, hits);
    }
  }
}

export function primaryUrl(output: TaskOutput, kind?: GenerationKind): string | undefined {
  return collectUrls(output, kind)[0];
}

/**
 * When no URL can be recognized in a completed task's output, show the agent
 * the actual output instead of a bare "completed." — guessing file URLs is
 * exactly the trap this avoids.
 */
export function outputFallbackText(output: TaskOutput): string {
  const json = JSON.stringify(output);
  const snippet = json.length > 800 ? `${json.slice(0, 800)}…` : json;
  return `No standard URL field recognized — raw output: ${snippet}`;
}

/**
 * provider_options exists to pass provider-specific fields the named
 * parameters can't express — NOT to override fields the tool computed and
 * validated (media URLs, prompt, task routing). A silent override defeats
 * every guard upstream of it, so collisions are rejected with the exact key
 * names.
 */
// Keys that control model routing, billing, or auth — never overridable via
// provider_options, even when the tool didn't write them into `input` itself.
// Without this, `provider_options: { model: <blocked-model> }` slips past the
// operator's blockedModels/allowedModels gate (which only sees the resolved
// top-level model) and into the API payload.
const RESERVED_PROVIDER_OPTION_KEYS = new Set([
  "model",
  "callback_url",
  "dry_run",
  "api_key",
  "apikey",
  "authorization",
]);

export function providerOptionsClash(
  input: Record<string, unknown>,
  providerOptions: Record<string, unknown> | undefined,
): ToolResult | null {
  if (!providerOptions) return null;
  const reserved = Object.keys(providerOptions).filter((k) => RESERVED_PROVIDER_OPTION_KEYS.has(k.toLowerCase()));
  if (reserved.length > 0) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: `provider_options cannot set reserved field(s): ${reserved.join(", ")}. These control model routing, billing, and auth and are managed by the tool/server — choose the model via the tool's "model" parameter.`,
        },
      ],
    };
  }
  const clash = Object.keys(providerOptions).filter((k) => k in input);
  if (clash.length > 0) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: `provider_options would override field(s) this tool already set: ${clash.join(", ")}. Set these through the tool's own parameters instead; provider_options is only for fields the tool does not manage.`,
        },
      ],
    };
  }
  return screenPassthroughValues(providerOptions, "provider_options");
}

/**
 * Screen every http(s) URL nested anywhere in provider_options through the same
 * SSRF check the named media params get.
 *
 * The tool's own URL params are screened by resolveMediaRef, but provider_options
 * is merged into the payload verbatim — so a URL under a key the tool doesn't
 * manage (e.g. image_url on a text-to-video call) would otherwise reach the
 * backend fetcher unscreened. The caller holds an API key and could POST that
 * payload directly, so this is not a privilege boundary; it is defense-in-depth
 * against a prompt-injected agent, which is exactly why the other screens exist.
 */
export function screenPassthroughValues(
  bag: Record<string, unknown>,
  label: string,
): ToolResult | null {
  const maxItems = 1_000;
  const maxDepth = 16;
  const problems: string[] = [];
  let visited = 0;
  let tooComplex = false;
  const walk = (value: unknown, path: string, depth: number): void => {
    // Budget nodes, not depth. A depth cap is trivially evaded by burying the URL
    // one level deeper (arrays each cost a level, so a realistic
    // clips[].tracks[].layers[].source.media.image_url slipped past a cap of 6),
    // while a node budget still bounds the walk.
    if (tooComplex) return;
    visited++;
    if (depth > maxDepth || visited > maxItems) {
      tooComplex = true;
      return;
    }
    if (typeof value === "string") {
      const v = value.trim();
      // Inline file data. The named media params reject this, but this bag is
      // merged into the payload verbatim — so `provider_options: { image_b64 }`
      // was a working base64 upload that bypassed every gate, which is exactly
      // the channel we removed for making agents degrade the user's file.
      if (/^data:/i.test(v) || looksLikeBase64(v)) {
        if (problems.length < 5) {
          problems.push(
            `${path} looks like inline file data (base64/data: URI). That is not an upload channel — it burns tokens and forces the file to be shrunk to fit. Upload the real file and pass its URL: ${DIRECT_UPLOAD_HINT}`,
          );
        }
        return;
      }
      // Screen anything with a URL scheme, NOT just "scheme://". WHATWG happily
      // normalizes `http:/169.254.169.254/` and `http:\\169.254.169.254\` to the
      // real thing, so requiring "//" let the exact IMDS payload this exists to
      // stop walk straight through. assertSafeRemoteUrl rejects non-http(s).
      // The digit-pair exclusion keeps legitimate values like "16:9" out.
      if (/^\d+:\d+$/.test(v) || !/^[a-z][a-z0-9+.-]*:/i.test(v)) return;
      try {
        assertSafeRemoteUrl(v, path);
      } catch (err) {
        if (problems.length < 5) problems.push(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, `${path}.${k}`, depth + 1);
      }
    }
  };
  for (const [k, v] of Object.entries(bag)) walk(v, `${label}.${k}`, 0);
  if (tooComplex) {
    problems.push(
      `${label} is too large or deeply nested to validate safely (maximum ${maxItems} items and ${maxDepth} nesting levels). Split or simplify the advanced options.`,
    );
  }
  if (problems.length === 0) return null;
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: problems.join(" ") }],
  };
}

function summarize(kind: GenerationKind, model: string, output: TaskOutput, taskId: string): string {
  if (kind === "transcription") {
    const text = typeof output.text === "string" ? output.text : "";
    if (!text) return `Transcription complete (${model}). ${outputFallbackText(output)}`;
    const preview = text.length > 280 ? `${text.slice(0, 280)}…` : text;
    const extras: string[] = [];
    if (text.length > 280) extras.push(`full ${text.length}-char text in output.text`);
    if (Array.isArray(output.words)) extras.push("per-word timestamps/speakers in output.words");
    if (typeof output.language_code === "string") extras.push(`language: ${sanitizeUntrusted(output.language_code, 20)}`);
    // Whoever authored the audio wrote these words — not the user. Fence them so
    // a spoken "ignore previous instructions" reads as data, not as a directive.
    return `Transcript${extras.length ? ` (${extras.join("; ")})` : ""}:\n${fenceUntrusted("transcript", sanitizeUntrusted(preview, 300))}`;
  }
  // Include the task_id so an agent can hand it to extend_video / upscale_media
  // (veo/grok) without a list_tasks lookup — many clients only show this text.
  // Suno results list their clips; the clip ids are what stems/wav and every
  // other clip-based Suno operation take, so surface them in the text too.
  const clipIds = Array.isArray(output.clips)
    ? (output.clips as Array<Record<string, unknown>>)
        .map((c) => (typeof c?.id === "string" ? sanitizeUntrusted(c.id, 64) : ""))
        .filter(Boolean)
    : [];
  const idNote = ` [task_id: ${taskId}${clipIds.length ? `; clip_ids: ${clipIds.join(", ")}` : ""}]`;
  const urls = collectUrls(output, kind);
  const noun = kind === "upscale" ? "Upscaled media" : `Generated ${kind}`;
  if (urls.length === 1) return `${noun} with ${model}. Result: ${urls[0]}${idNote}`;
  if (urls.length > 1) {
    const shown = urls.slice(0, 6);
    const more = urls.length > shown.length ? ` (+${urls.length - shown.length} more in output)` : "";
    return `${noun} with ${model}. ${urls.length} outputs:\n${shown.join("\n")}${more}${idNote}`;
  }
  return `${noun} with ${model}. ${outputFallbackText(output)}${idNote}`;
}

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

/**
 * createTask, but on an AMBIGUOUS failure (network/timeout/5xx — the API may
 * have accepted the task even though we saw an error) rethrow with a warning
 * to check before re-running. A definitive client rejection (4xx) means nothing
 * was created, so it stays a plain fix-and-retry error.
 */
async function createTaskGuarded(
  params: Parameters<typeof createTask>[0],
  ctx: RequestContext,
): ReturnType<typeof createTask> {
  try {
    return await createTask(params, ctx);
  } catch (err) {
    const code = err instanceof UnificallyError ? err.code : undefined;
    const ambiguous = code === undefined || code === 408 || code >= 500;
    if (ambiguous) {
      throw new Error(
        `${mapErrorToTextMessage(err)} The request MAY have been created despite this error — check list_tasks (newest first) or a recent get_task BEFORE re-running, to avoid a duplicate charge.`,
      );
    }
    throw err;
  }
}

// Providers sometimes reject with "Insufficient credits" / quota / points
// wording that has NOTHING to do with the user's UnificAlly balance — genuine
// balance failures are a 402. Left alone, that message sends agents (and
// users) topping up for no reason.
function looksLikeCreditsMessage(message: string): boolean {
  return /insufficient credit|no credit|not enough credit|quota|insufficient point|not enough point|insufficient balance|credit balance/i.test(message);
}

async function creditsAwareToolError(err: unknown, ctx: RequestContext): Promise<ToolResult> {
  const message =
    err instanceof UnificallyError && err.code !== 402
      ? err.apiMessage
      : err instanceof TaskFailedError
        ? err.apiMessage
        : undefined;
  if (message && looksLikeCreditsMessage(message)) {
    let balanceNote = "";
    try {
      const account = await getAccount(ctx);
      balanceNote = ` Your UnificAlly balance is $${account.balance_usd.toFixed(2)}, so this is NOT a balance problem`;
    } catch {
      // Balance unavailable — still flag the likely upstream origin.
    }
    const taskNote = err instanceof TaskFailedError ? ` (task ${err.taskId})` : "";
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text:
            `The model provider rejected this upstream${taskNote}: "${message}".${balanceNote} — genuine UnificAlly balance errors return 402/payment-required. ` +
            "This usually means the provider's own capacity/quota is exhausted right now: retry in a bit, or switch to a different model. Do not ask the user to top up.",
        },
      ],
    };
  }
  return toolError(err);
}

export async function runGeneration(
  args: RunGenerationArgs,
  ctx: RequestContext = {},
): Promise<ToolResult> {
  // Operator guardrails, checked before any spend.
  if (getConfig().disableGeneration) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: "Generation is disabled on this server (read-only mode). list_models, list_resources, dry_run_cost, and check_balance still work." }],
    };
  }
  const blocked = modelBlockedReason(args.model);
  if (blocked) {
    return { isError: true as const, content: [{ type: "text" as const, text: blocked }] };
  }

  const startedAt = Date.now();
  try {
    const quote = await runCostGate(
      { model: args.model, input: args.input, confirm_cost: args.confirm_cost },
      ctx,
    );
    if (quote) {
      return ok(quote.message, quote as unknown as Record<string, unknown>);
    }

    if (args.callback_url) {
      const created = await createTaskGuarded(
        { model: args.model, input: args.input, callback_url: args.callback_url },
        ctx,
      );
      return ok(
        `Task ${created.task_id} accepted. The result will be POSTed to ${args.callback_url} when it finishes. ` +
          `You can also poll it with get_task task_id="${created.task_id}".`,
        {
          task_id: created.task_id,
          status: created.status ?? "processing",
          model: args.model,
          callback_url: args.callback_url,
        },
      );
    }

    if (args.wait === false) {
      const created = await createTaskGuarded({ model: args.model, input: args.input }, ctx);
      return ok(
        `Task ${created.task_id} started (${args.model}). ` +
          `Poll get_task with task_id="${created.task_id}" until status is "completed" — the result URL will be in output.`,
        { task_id: created.task_id, status: created.status ?? "processing", model: args.model },
      );
    }

    const created = await createTaskGuarded({ model: args.model, input: args.input }, ctx);

    // On the hosted HTTP transport, proxies (Cloudflare) kill silent
    // responses at ~100s — return the task_id before that happens rather
    // than lose it with the connection. stdio has no proxy, so it can wait
    // the full poll timeout.
    // The proxy's (or MCP client's) clock started at tool entry, not after
    // createTask — count cost-gate and create time against the budget.
    const cfg = getConfig();
    const elapsed = Date.now() - startedAt;
    const budgetCap = cfg.transport === "http" ? cfg.httpWaitBudgetMs : cfg.stdioWaitBudgetMs;
    const budget = Math.max(5000, Math.min(budgetCap, cfg.pollTimeoutMs) - elapsed);

    let finished;
    try {
      finished = await waitForTask(created.task_id, ctx, budget);
    } catch (err) {
      if (err instanceof TaskTimeoutError) {
        // Not an error: the job is a long one and still running.
        return ok(
          `Task ${created.task_id} is still processing (${args.model} — long job, this is normal). ` +
            `Poll get_task with task_id="${created.task_id}" until status is "completed"; the result URL will be in output. Do NOT re-run the generation.`,
          { task_id: created.task_id, status: "processing", model: args.model },
        );
      }
      // A definitive failure already names its task_id and re-running (with
      // fixed inputs) is the right recovery — but disambiguate provider
      // credit/quota wording from real balance errors first.
      if (err instanceof TaskFailedError) return creditsAwareToolError(err, ctx);
      // The task was created (money committed) — never let the error hide
      // the handle to it, or the agent re-runs the generation and double-spends.
      return {
        isError: true as const,
        content: [
          {
            type: "text" as const,
            text: `${mapErrorToTextMessage(err)} Note: task ${created.task_id} was already created — check get_task task_id="${created.task_id}" before re-running, to avoid a duplicate charge.`,
          },
        ],
      };
    }
    const output: TaskOutput = taskOutput(finished);
    return ok(summarize(args.kind, args.model, output, finished.task_id), {
      task_id: finished.task_id,
      status: finished.status,
      output,
      model: args.model,
      ...(typeof finished.cost_usd === "number" ? { cost_usd: finished.cost_usd } : {}),
    });
  } catch (err) {
    return creditsAwareToolError(err, ctx);
  }
}
