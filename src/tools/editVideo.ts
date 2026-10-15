import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveModel, unknownModelError } from "../aliases.js";
import { toolError } from "../errors.js";
import { resolveMediaRef, resolveMediaRefs } from "../media.js";
import { callbackUrl, confirmCost, mediaRef, nonBlankText, providerOptions, seed, wait } from "../schemas.js";
import { providerOptionsClash, runGeneration, type ToolResult } from "./_helpers.js";

const inputShape = {
  video_url: mediaRef("The source video to edit (or the reference/control video for motion transfer)."),
  prompt: nonBlankText.describe("What to change — the edit instruction (e.g. 'make it snow', 'turn day into night', 'apply this motion to the subject')."),
  model: z
    .string()
    .optional()
    .describe(
      "Edit model, alias or full id. Aliases: 'video-edit' (default, Gemini Omni), 'kling-edit', 'wan-edit', 'motion-control' (Kling motion transfer). See list_models (category video, the *-edit / motion-control ids).",
    ),
  image_urls: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional reference/subject images (each a public https URL) — used by motion-control (the subject to animate) and omni edit models. The max count is per-model.",
    ),
  aspect_ratio: z.string().optional().describe("Optional output aspect ratio, if the model supports it."),
  seed,
  wait,
  callback_url: callbackUrl,
  confirm_cost: confirmCost,
  provider_options: providerOptions,
};

const inputSchema = z.object(inputShape).strict();

// Video-edit models disagree on field names — get these wrong and the source
// video or reference images are silently dropped. Verified against the model
// docs. videoArrayKey means the source goes as [url] under that key.
interface EditSpec {
  videoKey: string;
  videoArray?: boolean;
  refKey?: string; // where reference/subject images go, or undefined if unsupported
  refSingle?: boolean; // send a single string, not an array (motion-control)
  aspectKey?: string; // 'aspect_ratio' | 'ratio' | undefined
  allowSeed?: boolean;
}

function editSpec(model: string): EditSpec {
  if (/gemini-omni.*video-edit/.test(model)) {
    return { videoKey: "reference_video_urls", videoArray: true, refKey: "reference_image_urls", allowSeed: true };
  }
  if (/wan-.*video-edit/.test(model)) {
    return { videoKey: "video_url", refKey: "reference_image_urls", aspectKey: "ratio", allowSeed: true };
  }
  if (/happyhorse.*video-edit/.test(model)) {
    return { videoKey: "video_url", refKey: "reference_image_urls", allowSeed: true };
  }
  if (/kling.*(omni|o1).*video-edit/.test(model)) {
    return { videoKey: "video_url", refKey: "image_urls", aspectKey: "aspect_ratio", allowSeed: false };
  }
  if (/motion-control/.test(model)) {
    return { videoKey: "video_url", refKey: "image_url", refSingle: true, allowSeed: false };
  }
  return { videoKey: "video_url", refKey: "reference_image_urls", allowSeed: true };
}

export function registerEditVideo(server: McpServer): void {
  server.registerTool(
    "edit_video",
    {
      title: "Edit video",
      description:
        "Edit an existing video from a prompt, or transfer motion onto a subject image. " +
        "Pass the source in video_url and the change in prompt. Defaults to Google Gemini Omni video edit; " +
        "switch with model ('kling-edit', 'wan-edit', or 'motion-control' for Kling motion transfer with a subject image in image_urls). " +
        "This is for changing an existing clip — to make a new video from scratch use generate_video, to extend one use extend_video, to upscale use upscale_media. Returns the video URL.",
      inputSchema: inputSchema,
      annotations: {
        title: "Edit video",
        // Irreversible spend — see generate_video for the reasoning. (Edits emit
        // a NEW clip; the source video is never mutated.)
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (rawArgs): Promise<ToolResult> => {
      const args = inputSchema.parse(rawArgs);
      const model = resolveModel(args.model, "google/gemini-omni-flash-1.1-video-edit");

      const fail = (text: string): ToolResult => ({
        isError: true as const,
        content: [{ type: "text" as const, text }],
      });

      const unknown = unknownModelError(model, "video");
      if (unknown) return fail(unknown);
      // Only edit/motion models consume a source video_url; a plain
      // text-to-video id here would ignore it and waste a paid call.
      if (!/-edit$|-edit-|motion-control/.test(model)) {
        return fail(`'${model}' is not a video-edit model — use 'video-edit', 'kling-edit', 'wan-edit', or 'motion-control'. To make a NEW clip use generate_video; to lengthen one use extend_video.`);
      }

      let videoUrl: string;
      let imageUrls: string[] | undefined;
      try {
        videoUrl = await resolveMediaRef(args.video_url);
        imageUrls = await resolveMediaRefs(args.image_urls);
      } catch (err) {
        return toolError(err);
      }

      const spec = editSpec(model);
      if (/motion-control/.test(model) && (!imageUrls || imageUrls.length === 0)) {
        return fail("motion-control needs the subject image in image_urls (the character/subject to animate with the motion from video_url).");
      }

      const input: Record<string, unknown> = { prompt: args.prompt };
      // Source video, under the field name this family expects.
      input[spec.videoKey] = spec.videoArray ? [videoUrl] : videoUrl;
      // Reference/subject images, if the model takes them.
      if (imageUrls && imageUrls.length > 0 && spec.refKey) {
        input[spec.refKey] = spec.refSingle ? imageUrls[0] : imageUrls;
      }
      if (args.aspect_ratio !== undefined && spec.aspectKey) input[spec.aspectKey] = args.aspect_ratio;
      if (args.seed !== undefined && spec.allowSeed) input.seed = args.seed;

      const clash = providerOptionsClash(input, args.provider_options);
      if (clash) return clash;
      Object.assign(input, args.provider_options ?? {});

      return runGeneration({
        kind: "video",
        model,
        input,
        callback_url: args.callback_url,
        confirm_cost: args.confirm_cost,
        wait: args.wait,
      });
    },
  );
}
