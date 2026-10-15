import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveModel, unknownModelError } from "../aliases.js";
import { toolError } from "../errors.js";
import { resolveMediaRef, resolveMediaRefs } from "../media.js";
import { callbackUrl, confirmCost, mediaRef, nonBlankText, providerOptions, seed, wait } from "../schemas.js";
import { providerOptionsClash, runGeneration, type ToolResult } from "./_helpers.js";

const inputShape = {
  prompt: nonBlankText.describe("Text prompt describing the desired video."),
  model: z
    .string()
    .optional()
    .describe(
      "Model, as a short alias or full id. Aliases: 'veo' (default), 'veo-quality', 'veo-lite', 'kling', 'kling-omni', 'hailuo', 'seedance', 'grok-video', 'grok-1.5'. Full ids like 'google/veo-3.1-fast' also work. Call list_models for the catalog, and read a model's docs page for its exact parameters.",
    ),
  duration: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Video length in seconds. Omit for the model's default. Allowed values are per-model."),
  aspect_ratio: z
    .string()
    .optional()
    .describe("Output aspect ratio, e.g. '16:9'. Per-model: some accept different sets, some have none."),
  image_url: mediaRef(
    "Optional starting frame for image-to-video. This tool maps it to whatever field the chosen model wants, so pass it here rather than the model's own field name.",
  ).optional(),
  end_image_url: mediaRef(
    "Optional final frame (start-frame + end-frame interpolation). Only some models support one.",
  ).optional(),
  reference_image_urls: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional reference images for style/subject — each must be a public https URL (upload local files first — never a path or base64). Support, the max count, and whether they combine with a start frame are per-model.",
    ),
  seed,
  wait,
  callback_url: callbackUrl,
  confirm_cost: confirmCost,
  provider_options: providerOptions,
};

const inputSchema = z.object(inputShape).strict();

export function registerGenerateVideo(server: McpServer): void {
  server.registerTool(
    "generate_video",
    {
      title: "Generate video",
      description:
        "Generate a video from a text prompt (and optional start/end frames). " +
        "Defaults to Google Veo 3.1 Fast, which includes native audio. " +
        "Switch model with the model parameter (Veo, Kling, Hailuo/MiniMax, and more). " +
        "The tool waits for the result and returns the video URL; pass callback_url for long jobs to return immediately.",
      inputSchema: inputSchema,
      annotations: {
        title: "Generate video",
        // Spends the user's balance on a task that cannot be canceled once
        // submitted. The new asset is additive, but the charge is irreversible —
        // and this hint is what a client uses to decide whether to auto-approve.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false, // a retry is a second paid task, never a no-op
        openWorldHint: true,
      },
    },
    async (rawArgs): Promise<ToolResult> => {
      const args = inputSchema.parse(rawArgs);
      const model = resolveModel(args.model, "google/veo-3.1-fast");

      const fail = (text: string): ToolResult => ({
        isError: true as const,
        content: [{ type: "text" as const, text }],
      });

      const unknown = unknownModelError(model, "video");
      if (unknown) return fail(unknown);
      // Wrong-category models create paid tasks of the wrong kind — redirect.
      if (/upscale/.test(model)) return fail(`'${model}' is an upscaler — use upscale_media.`);
      if (/extend/.test(model)) return fail(`'${model}' is a video extender — use extend_video with the source task_id.`);
      if (/-edit$|-edit-|motion-control/.test(model)) return fail(`'${model}' edits/transforms an existing video — use edit_video with a video_url.`);
      if (/image|seedream|flux|banana/.test(model)) return fail(`'${model}' is an image model — use generate_image.`);
      if (/suno|elevenlabs|speech|audio|music/.test(model)) return fail(`'${model}' is an audio model — use generate_audio or generate_music.`);

      // Field NAMES only. This is the one piece of per-model knowledge the tool
      // must keep: it is what lets a caller pass image_url without knowing the
      // model's own spelling. It is a translation, not a rule — it never rejects
      // anything, and a caller who reads the docs can bypass it entirely by
      // sending the model's real field name in provider_options.
      //   Kling                     start_frame_url / end_frame_url
      //   Seedance, newer Alibaba   first_frame_url / last_frame_url
      //   everyone else             start_image_url / end_image_url
      const isKling = /kling/.test(model);
      const isSeedance = /seedance/.test(model);
      const isGrok = /grok/.test(model);
      // Newer Alibaba video-generation models (Wan 2.x video, HappyHorse) use
      // the first_frame_url/last_frame_url + ratio convention like Seedance.
      const isAlibabaFirstFrame = /wan-[\d.]+-video$|happyhorse-[\d.]+-video$/.test(model);
      const useFirstFrame = isSeedance || isAlibabaFirstFrame;
      const startKey = isKling ? "start_frame_url" : useFirstFrame ? "first_frame_url" : "start_image_url";
      const endKey = isKling ? "end_frame_url" : useFirstFrame ? "last_frame_url" : "end_image_url";
      // References: Veo wants reference_image_urls; Kling Omni, Seedance and Grok take image_urls.
      const refKey = isKling || isSeedance || isGrok ? "image_urls" : "reference_image_urls";
      // Alibaba first-frame models call the aspect field `ratio`. Models that
      // have no aspect field at all (Hailuo sizes by resolution) are NOT special
      // -cased into a silent drop: swallowing a parameter the user asked for
      // yields a paid render at the wrong shape, which is worse than the free
      // provider 400 that passing it through produces.
      const aspectKey = isAlibabaFirstFrame ? "ratio" : "aspect_ratio";

      // WHICH RULES BELONG HERE IS AN EMPIRICAL QUESTION, and it was measured
      // against the live API rather than reasoned about (2026-07-17):
      //
      //   VALUE rules (duration, resolution, aspect_ratio, counts) — the API
      //   validates these itself and answers 422 "duration must be one of
      //   (4, 6, 8)": free, no task created, more precise than anything written
      //   here, and never stale. A copy here is pure duplication that can only
      //   rot into rejecting calls that are valid. So there are none.
      //
      //   COMBINATION / CAPABILITY rules — the API does NOT validate these. They
      //   fall through to the provider and come back as 500 "Model configuration
      //   error. Please contact support" or 503 "no alternative channels found to
      //   reroute; please try again later". Both LIE: the request was wrong, not
      //   the platform. The 503 invites an agent to retry a permanently invalid
      //   call, and the 500 sends the user to support for a bug that is theirs.
      //   Nothing upstream will ever say what to fix, so the guards below are the
      //   only honest error the caller gets. They stay.
      //
      // Add a guard here ONLY after checking what the API does without it. If it
      // 422s, don't.
      if (/grok-imagine-1\.5-video/.test(model) && args.image_url === undefined) {
        // Measured without this guard: 500 "Model configuration error."
        return fail(
          `'${model}' is image-to-video ONLY — it needs a start image, so pass image_url. ` +
            "For text-to-video from a bare prompt use 'grok-video' (xai/grok-imagine-video), which is also the only Grok model extend_video and grok-upscale can continue.",
        );
      }
      if (/grok-imagine-video$/.test(model) && args.image_url !== undefined && args.reference_image_urls !== undefined) {
        // Measured without this guard: 503 "please try again later" — which is
        // exactly the error an agent retries.
        return fail(
          `'${model}' accepts a start frame OR reference images, not both. Pass image_url alone to animate a specific frame, or reference_image_urls alone for style/subject guidance (referenced from the prompt as @Image1, @Image2, …).`,
        );
      }

      // Reject non-URL refs early with a clear fix instead of an upstream 400.
      let startUrl: string | undefined;
      let endUrl: string | undefined;
      let referenceUrls: string[] | undefined;
      try {
        startUrl = args.image_url !== undefined ? await resolveMediaRef(args.image_url) : undefined;
        endUrl = args.end_image_url !== undefined ? await resolveMediaRef(args.end_image_url) : undefined;
        referenceUrls = await resolveMediaRefs(args.reference_image_urls);
      } catch (err) {
        return toolError(err);
      }

      const input: Record<string, unknown> = {
        prompt: args.prompt,
        ...(args.duration !== undefined ? { duration: args.duration } : {}),
        ...(args.aspect_ratio !== undefined ? { [aspectKey]: args.aspect_ratio } : {}),
        ...(startUrl !== undefined ? { [startKey]: startUrl } : {}),
        ...(endUrl !== undefined ? { [endKey]: endUrl } : {}),
        ...(referenceUrls !== undefined ? { [refKey]: referenceUrls } : {}),
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      };
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
