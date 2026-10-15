import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveModel, unknownModelError } from "../aliases.js";
import { toolError } from "../errors.js";
import { resolveMediaRefs } from "../media.js";
import { callbackUrl, confirmCost, negativePrompt, nonBlankText, providerOptions, seed, wait } from "../schemas.js";
import { providerOptionsClash, runGeneration, type ToolResult } from "./_helpers.js";

const UPSCALE_MODELS = new Set([
  "topaz-labs/image-upscale",
  "topaz-labs/image-generative",
  "topaz-labs/video-upscale",
  "google/veo-3.1-upscale",
  "xai/grok-imagine-upscale",
]);

const inputShape = {
  prompt: nonBlankText.describe("Text prompt describing the image (or the edit to apply to image_urls)."),
  model: z
    .string()
    .optional()
    .describe(
      "Model, as a short alias or full id. Aliases: 'nano-banana-pro' (default), 'nano-banana', 'nano-banana-2', 'nano-banana-2-lite', 'flux', 'gpt-image', 'qwen', 'kling-image', 'grok-image', 'seedream'. Full ids also work. See list_models. (Upscaling lives in upscale_media, not here.)",
    ),
  resolution: z
    .string()
    .optional()
    .describe(
      "Output resolution; omit for the model's default. Per-model: some take sizes like '2k', some megapixels, some have no resolution field.",
    ),
  aspect_ratio: z
    .string()
    .optional()
    .describe("Output aspect ratio, e.g. '1:1'. Per-model: some accept different sets, some have none."),
  image_urls: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Reference/source images for editing and multi-reference generation — each must be a public https URL. Upload a local file first and pass the returned file_url; never a local path, and never inline base64. The max count is per-model.",
    ),
  image_url: z
    .string()
    .min(1)
    .optional()
    .describe("Convenience: a single reference/source image (same as image_urls with one entry)."),
  negative_prompt: negativePrompt,
  seed,
  wait,
  callback_url: callbackUrl,
  confirm_cost: confirmCost,
  provider_options: providerOptions,
};

const inputSchema = z.object(inputShape).strict();

export function registerGenerateImage(server: McpServer): void {
  server.registerTool(
    "generate_image",
    {
      title: "Generate image",
      description:
        "Generate or edit an image from a text prompt. " +
        "Defaults to Google Nano Banana Pro. Pass image_urls to edit or use reference images. " +
        "Returns the image URL. (To upscale an existing image, use upscale_media instead.)",
      inputSchema: inputSchema,
      annotations: {
        title: "Generate image",
        // Irreversible spend — see generate_video for the reasoning.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (rawArgs): Promise<ToolResult> => {
      const args = inputSchema.parse(rawArgs);
      const model = resolveModel(args.model, "google/nano-banana-pro");

      const fail = (text: string): ToolResult => ({
        isError: true as const,
        content: [{ type: "text" as const, text }],
      });

      const unknown = unknownModelError(model, "image");
      if (unknown) return fail(unknown);
      if (UPSCALE_MODELS.has(model) || /upscale/.test(model)) {
        return fail(`'${model}' is an upscaler — use the upscale_media tool instead (image_url for Topaz image upscale, video_url for video, task_id for veo/grok upscalers).`);
      }
      if (/video|veo-|seedance|hailuo|minimax/.test(model)) {
        return fail(`'${model}' is a video model — use generate_video.`);
      }
      if (/suno|elevenlabs|speech|audio|music/.test(model)) {
        return fail(`'${model}' is an audio model — use generate_audio or generate_music.`);
      }

      // Accept the singular image_url as a convenience synonym so an agent that
      // learned generate_video's param name doesn't get it silently dropped.
      const refs = args.image_urls ?? (args.image_url ? [args.image_url] : undefined);

      // Reject non-URL refs early with a clear fix instead of an upstream 400.
      let imageUrls: string[] | undefined;
      try {
        imageUrls = await resolveMediaRefs(refs);
      } catch (err) {
        return toolError(err);
      }

      // Everything the caller passed goes through as-is. There is no per-model
      // strip list here any more: it silently dropped fields (SeeDream lost
      // aspect_ratio/negative_prompt/seed), so a caller who asked for something
      // the list was wrong about paid for a render that quietly ignored it. An
      // unsupported field costs a free provider 400 instead. Which fields a model
      // takes is on its docs page.
      const input: Record<string, unknown> = {
        prompt: args.prompt,
        ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
        ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
        ...(imageUrls !== undefined ? { image_urls: imageUrls } : {}),
        ...(args.negative_prompt !== undefined ? { negative_prompt: args.negative_prompt } : {}),
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      };
      const clash = providerOptionsClash(input, args.provider_options);
      if (clash) return clash;
      Object.assign(input, args.provider_options ?? {});

      return runGeneration({ kind: "image", model, input, callback_url: args.callback_url, confirm_cost: args.confirm_cost, wait: args.wait });
    },
  );
}
