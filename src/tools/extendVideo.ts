import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveModel } from "../aliases.js";
import { callbackUrl, confirmCost, providerOptions, taskIdSchema, wait } from "../schemas.js";
import { providerOptionsClash, runGeneration, type ToolResult } from "./_helpers.js";

const VEO_EXTEND = "google/veo-3.1-extend";
const GROK_EXTEND = "xai/grok-imagine-video-extend";

const inputShape = {
  task_id: taskIdSchema.describe("task_id of the completed generation to extend. Extenders are model-internal: Veo extend works on Veo generations, Grok extend on Grok Imagine generations."),
  model: z
    .string()
    .optional()
    .describe(
      "Which extender, as an alias or full id: 'veo' / 'google/veo-3.1-extend' (default, adds 8s) or 'grok' / 'xai/grok-imagine-video-extend'. " +
        "Each only continues its OWN model's generations: Grok extend needs a task_id from xai/grok-imagine-video — NOT from xai/grok-imagine-1.5-video, which cannot be extended. See list_models.",
    ),
  prompt: z
    .string()
    .optional()
    .describe("What should happen in the extended segment. Required for Veo, and for Grok custom mode (i.e. when video_preset is not set)."),
  base_model: z
    .string()
    .optional()
    .describe("Veo only: base model variant. Default 'fast'."),
  video_preset: z
    .string()
    .optional()
    .describe("Grok only: preset mode. When set, prompt/extend_at/extend_duration are ignored."),
  extend_at: z
    .number()
    .nonnegative()
    .optional()
    .describe("Grok custom mode: seconds into the source video where the extension begins. Required with prompt."),
  extend_duration: z
    .number()
    .positive()
    .optional()
    .describe("Grok custom mode: extension length in seconds. Required with prompt."),
  seed: z.number().int().optional().describe("Reproducibility seed (Veo)."),
  wait,
  callback_url: callbackUrl,
  confirm_cost: confirmCost,
  provider_options: providerOptions,
};

const inputSchema = z.object(inputShape).strict();

export function registerExtendVideo(server: McpServer): void {
  server.registerTool(
    "extend_video",
    {
      title: "Extend video",
      description:
        "Extend a previously generated video by its own model's extender (pass the task_id of the completed generation). " +
        "Veo (default): requires prompt; aspect ratio is inherited. For a longer extension, try extending the extend-result's task_id again — chaining is not officially documented, so if it fails, regenerate at the target length instead. " +
        "Grok: extends a Grok Imagine video — either preset mode (video_preset) or custom mode (prompt + extend_at + extend_duration). " +
        "Extenders only work on their own model's generations.",
      inputSchema: inputSchema,
      annotations: {
        title: "Extend video",
        // Irreversible spend — see generate_video for the reasoning.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (rawArgs): Promise<ToolResult> => {
      const args = inputSchema.parse(rawArgs);
      // Resolve to a full extender id (aliases and full ids both work).
      const resolved = resolveModel(args.model ?? "veo", VEO_EXTEND);
      const isGrok = /grok/.test(resolved);

      const fail = (text: string): ToolResult => ({
        isError: true as const,
        content: [{ type: "text" as const, text }],
      });

      if (!isGrok && resolved !== VEO_EXTEND && !/veo/.test(resolved)) {
        return fail(`'${args.model}' is not a video extender. Use 'veo' / '${VEO_EXTEND}' or 'grok' / '${GROK_EXTEND}'.`);
      }

      if (isGrok) {
        let input: Record<string, unknown>;
        if (args.video_preset !== undefined) {
          input = { task_id: args.task_id, video_preset: args.video_preset };
        } else {
          if (!args.prompt?.trim() || args.extend_at === undefined || args.extend_duration === undefined) {
            return fail("Grok extend custom mode requires prompt, extend_at, and extend_duration — or pass video_preset instead for preset mode. See the Grok extend docs page for the allowed values.");
          }
          input = {
            task_id: args.task_id,
            prompt: args.prompt,
            extend_at: args.extend_at,
            extend_duration: args.extend_duration,
          };
        }
        const clash = providerOptionsClash(input, args.provider_options);
        if (clash) return clash;
        Object.assign(input, args.provider_options ?? {});
        return runGeneration({
          kind: "video",
          model: GROK_EXTEND,
          input,
          callback_url: args.callback_url,
          confirm_cost: args.confirm_cost,
          wait: args.wait,
        });
      }

      if (!args.prompt?.trim()) {
        return fail("Veo extend requires a prompt describing what happens in the extended segment.");
      }
      const input: Record<string, unknown> = {
        task_id: args.task_id,
        prompt: args.prompt,
        // `model` (the Veo variant) is REQUIRED by the extend endpoint, so a
        // default has to exist here. `duration` is not: it is optional upstream
        // and already defaults to 8, so pinning 8 would just be another number to
        // go stale. Omit it and let the API decide.
        model: args.base_model ?? "fast",
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      };
      const clash = providerOptionsClash(input, args.provider_options);
      if (clash) return clash;
      Object.assign(input, args.provider_options ?? {});
      return runGeneration({
        kind: "video",
        model: VEO_EXTEND,
        input,
        callback_url: args.callback_url,
        confirm_cost: args.confirm_cost,
        wait: args.wait,
      });
    },
  );
}
