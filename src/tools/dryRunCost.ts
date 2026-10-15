import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveModel } from "../aliases.js";
import { toolError } from "../errors.js";
import { dryRunTask } from "../unifically.js";
import { screenPassthroughValues, type ToolResult } from "./_helpers.js";

const inputShape = {
  model: z.string().min(1).describe("Model id or alias, e.g. 'google/veo-3.1-fast' or 'veo'."),
  // A named `prompt` plus passthrough keeps a real `properties` block in the
  // JSON schema (strict function-calling clients reject a bare record), while
  // still accepting any model-specific field.
  input: z
    .object({ prompt: z.string().optional() })
    .passthrough()
    .describe(
      "The API 'input' payload to price — the RAW field names the model expects, which differ from the generation tools' parameters. Include prompt and any model-specific fields. " +
        "For a model's exact field names, read its page via https://docs.unifically.com/llms.txt (they change, so don't go from memory). " +
        "Translations this server applies on your behalf: music prompt→gpt_description_prompt (+ required mv:'chirp-bluejay', custom:false); TTS voice_id→voice; stt needs audio_url + duration; " +
        "the generation tools' image_url becomes whichever start-frame field the model wants. " +
        "A mis-shaped input prices the model's defaults, so keep it faithful to the real call.",
    ),
};

const inputSchema = z.object(inputShape).strict();

export function registerDryRunCost(server: McpServer): void {
  server.registerTool(
    "dry_run_cost",
    {
      title: "Preview cost",
      description:
        "Estimate the cost of a task without creating it or charging the account. Pass the model and the full input payload.",
      inputSchema: inputSchema,
      annotations: {
        title: "Preview cost",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawArgs): Promise<ToolResult> => {
      const args = inputSchema.parse(rawArgs);
      const model = resolveModel(args.model, args.model);
      // `input` is passthrough (it mirrors the raw API payload), so it is the
      // same open bag as provider_options: inline base64 and unscreened URLs
      // reached the API through it. Pricing a base64 blob is pointless anyway —
      // it only teaches the agent that base64 is a channel here.
      const unsafe = screenPassthroughValues(args.input as Record<string, unknown>, "input");
      if (unsafe) return unsafe;
      try {
        const { cost } = await dryRunTask({ model, input: args.input });
        if (typeof cost !== "number" || !Number.isFinite(cost)) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Dry run for ${model} returned no cost figure — the input may be mis-shaped for this model.` }],
          };
        }
        return {
          content: [
            { type: "text", text: `Estimated cost: $${cost.toFixed(4)} for ${model}.` },
          ],
          structuredContent: { model, cost_usd: cost },
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
