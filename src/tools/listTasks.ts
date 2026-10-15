import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveModel } from "../aliases.js";
import { annotateProviderCredit, toolError } from "../errors.js";
import { listTasks, type TaskListItem } from "../unifically.js";
import { collectUrls, type ToolResult } from "./_helpers.js";
import { sanitizeUntrusted } from "../untrusted.js";

/**
 * The only categories GET /v1/tasks accepts. Validated here rather than left to
 * the API so a wrong value returns a self-healing message naming the valid set,
 * instead of costing a round-trip and a bare 400.
 */
const TASK_CATEGORIES = ["llm", "video", "image", "audio"] as const;

const splitCategories = (v: string): string[] =>
  v.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);

const inputShape = {
  page: z.number().int().min(1).optional().describe("1-indexed page number. Default 1."),
  page_size: z
    .union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)])
    .optional()
    .describe("Items per page: 10, 25, 50, or 100. Default 25."),
  status: z
    .enum(["processing", "completed", "failed"])
    .optional()
    .describe("Filter by task status. Omit for all. (Tasks the generation tools report as 'pending' appear here as 'processing'.)"),
  model: z.string().optional().describe("Filter by exact model id, e.g. 'google/veo-3.1-fast'."),
  category: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || splitCategories(v).every((c) => (TASK_CATEGORIES as readonly string[]).includes(c)),
      (v) => ({
        message: `category must be a comma-separated list of: ${TASK_CATEGORIES.join(", ")}. Got '${v}'. (Transcription tasks have no category of their own — list without a category filter and match on model.)`,
      }),
    )
    .describe(
      "Filter by output type, comma-separated from: llm, video, image, audio. E.g. 'video,image'. Note: there is no 'upscale' category — upscales are recorded under video/image.",
    ),
  provider: z
    .string()
    .optional()
    .describe("Filter by provider slug(s), comma-separated — the part of the model id before the '/', e.g. 'google,elevenlabs'."),
  created_after: z.number().int().optional().describe("Unix timestamp in seconds, inclusive lower bound on creation time."),
  created_before: z.number().int().optional().describe("Unix timestamp in seconds, inclusive upper bound. Must be >= created_after when both are given."),
};

const inputSchema = z.object(inputShape).strict();

function formatCost(cost: number): string {
  // Image/TTS tasks cost fractions of a cent — two decimals would render $0.00.
  return cost > 0 && cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2);
}

function line(t: TaskListItem): string {
  const when = new Date(t.created_at * 1000).toISOString();
  const cost = typeof t.cost === "number" ? ` $${formatCost(t.cost)}` : "";
  const rawPrompt = t.input?.input?.prompt ?? t.input?.input?.gpt_description_prompt ?? t.input?.input?.text;
  // A stored prompt is replayed text: on a shared key another party authored it,
  // and the unescaped quotes below would otherwise let it break out of them.
  const prompt =
    typeof rawPrompt === "string" && rawPrompt.trim()
      ? `  "${sanitizeUntrusted(rawPrompt, 60)}"`
      : "";
  const url = t.output ? collectUrls(t.output)[0] : undefined;
  const result = url ? `  → ${url}` : "";
  const err = t.status === "failed" && t.error_message ? ` — ${annotateProviderCredit(t.error_message)}` : "";
  return `${t.task_id}  ${t.model}  ${t.status}${cost}  ${when}${prompt}${result}${err}`;
}

export function registerListTasks(server: McpServer): void {
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List the account's past generation tasks, newest first, with pagination. " +
        "Filter by status (processing/completed/failed), model id, category (video/image/audio/text/llm), provider, or a created_after/created_before time window. " +
        "Use it to find an earlier generation's task_id (for get_task, extend_video, or the veo/grok upscalers) or to review recent spend. " +
        "Within one filter, comma-separated values are OR'd; different filters are AND'd.",
      inputSchema: inputSchema,
      annotations: {
        title: "List tasks",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawArgs): Promise<ToolResult> => {
      const args = inputSchema.parse(rawArgs);
      // Resolve a model alias to its id so filtering by "veo" matches the
      // stored google/veo-3.1-fast, same as the generation tools.
      const query = args.model ? { ...args, model: resolveModel(args.model, args.model) } : args;
      try {
        const { tasks, pagination } = await listTasks(query);
        const page = pagination?.page ?? args.page ?? 1;
        const pageSize = pagination?.page_size ?? args.page_size ?? 25;
        // The live API returns a bare array without totals — infer "more" from a full page.
        const hasNext = pagination?.has_next ?? tasks.length >= pageSize;
        const header = `Page ${page}: ${tasks.length} task(s)${hasNext ? ` — more available, request page ${page + 1}` : ""}:`;
        const body = tasks.length
          ? tasks.map(line).join("\n")
          : `No tasks on this page${page > 1 ? " — you may be past the last page" : " match the filters"}.`;
        return {
          content: [{ type: "text", text: `${header}\n${body}` }],
          structuredContent: { tasks, page, page_size: pageSize, has_next: hasNext, ...(pagination ? { pagination } : {}) } as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
