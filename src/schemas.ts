import { z } from "zod";

import { assertSafeRemoteUrl } from "./urlSafety.js";

export const callbackUrl = z
  .string()
  .trim()
  .superRefine((u, ctx) => {
    // The backend POSTs the result to this URL server-side — screen it for
    // SSRF (scheme, credentials, private/loopback/link-local hosts) just like
    // any other fetcher-fed URL.
    try {
      assertSafeRemoteUrl(u, "callback_url");
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    }
  })
  .optional()
  .describe(
    "Optional webhook URL. When set, the tool returns immediately with the task_id and UnificAlly POSTs the result to this URL when the task finishes. " +
      "Webhook body: { task_id, status: 'completed'|'failed', data: { video_url | image_url | audio_url | ... }, error_message? } — note the media arrives under 'data', not 'output'. Use for long jobs instead of waiting.",
  );

export const confirmCost = z
  .boolean()
  .optional()
  .describe(
    "Only relevant if the operator enabled a spend guard. When a call exceeds the configured confirm threshold it returns a quote; retry with confirm_cost: true to proceed. Safe to ignore otherwise.",
  );

export const wait = z
  .boolean()
  .optional()
  .describe(
    "Default true: wait for the job and return the finished result. Set false to get the task_id back immediately and poll with get_task — use for long jobs (high-quality video, full songs) or when the connection might time out.",
  );

export const providerOptions = z
  .record(z.unknown())
  .optional()
  .describe(
    "Escape hatch for model-specific fields not exposed as named parameters (e.g. Kling multi_shots, Flux steps). Merged into the API 'input' payload. Rejected: fields the tool already manages (prompt, media URLs, task_id, ...) and reserved routing/billing/auth keys (model, callback_url, dry_run, api_key, authorization) — switch models with the 'model' parameter, not here. See https://docs.unifically.com for per-model fields.",
  );

export const seed = z
  .number()
  .int()
  .optional()
  .describe("Optional seed for reproducible output. Same seed + same input gives the same result on supported models.");

export const negativePrompt = z
  .string()
  .optional()
  .describe("Optional description of what to avoid in the output (supported by Qwen, Wan and some others).");

export const taskIdSchema = z
  .string()
  .trim()
  .min(1)
  .describe("The task_id returned by a previous generation call.");

/** A required free-text field that must contain something beyond whitespace. */
export const nonBlankText = z.string().trim().min(1);

/**
 * A media reference field. Must be a public https URL — local paths and inline
 * base64 are rejected with an error naming the direct upload, which returns a
 * CDN URL to pass here.
 */
export function mediaRef(what: string) {
  return z
    .string()
    .min(1)
    .describe(
      `${what} Must be a public https URL — never a local path, never inline base64. For a local file, upload it first with a direct PUT to files.unifically.com/upload and pass the returned file_url.`,
    );
}
