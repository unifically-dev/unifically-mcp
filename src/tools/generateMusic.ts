import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toolError } from "../errors.js";
import { resolveMediaRef } from "../media.js";
import { callbackUrl, confirmCost, providerOptions, wait } from "../schemas.js";
import { providerOptionsClash, runGeneration, type ToolResult } from "./_helpers.js";

// Suno operations, mapped to their model ids. Everything except "music"
// transforms an existing track and needs audio_url.
const MODE_MODEL: Record<string, string> = {
  music: "suno-ai/music",
  cover: "suno-ai/cover",
  extend: "suno-ai/extend",
  "add-vocals": "suno-ai/add-vocals",
  "add-instrumental": "suno-ai/add-instrumental",
  stems: "suno-ai/stems",
  "stems-all": "suno-ai/stems-all",
  lyrics: "suno-ai/lyrics",
  sound: "suno-ai/sound",
  wav: "suno-ai/wav",
};
// Ops that take a source TRACK URL (audio_url). stems/stems-all/wav instead take
// a clip_id (a prior Suno generation's clip), and music/lyrics/sound take neither.
const AUDIO_INPUT_MODES = new Set(["cover", "extend", "add-vocals", "add-instrumental"]);
const CLIP_ID_MODES = new Set(["stems", "stems-all", "wav"]);
const CUSTOM_MODES = new Set(["music", "cover", "extend"]);

const inputShape = {
  prompt: z
    .string()
    .optional()
    .describe(
      "For mode 'music' (default): the song description (simple) or full lyrics (custom:true). For 'cover'/'extend'/'add-vocals'/'add-instrumental': optional style/lyrics guidance. For 'sound': describe the sound effect (required). For 'lyrics': the lyric idea. Not used by stems/stems-all/wav.",
    ),
  mode: z
    .enum(["music", "cover", "extend", "add-vocals", "add-instrumental", "stems", "stems-all", "lyrics", "sound", "wav"])
    .optional()
    .describe(
      "Suno operation. 'music' (default) makes a new song. 'cover' re-sings a track; 'extend' lengthens it (needs continue_at); 'add-vocals'/'add-instrumental' layer onto it; 'stems'/'stems-all' split a track (need clip_id); 'lyrics' writes lyrics; 'sound' makes a sound effect from a prompt; 'wav' exports a clip as WAV (needs clip_id). cover/extend/add-vocals/add-instrumental need audio_url.",
    ),
  audio_url: z
    .string()
    .min(1)
    .optional()
    .describe("Source track (public https URL) for cover/extend/add-vocals/add-instrumental. For local files, upload_file first."),
  clip_id: z
    .string()
    .min(1)
    .optional()
    .describe("Clip id of a completed Suno music task — required by 'stems'/'stems-all' (split into stems) and 'wav' (export as WAV)."),
  continue_at: z
    .number()
    .nonnegative()
    .optional()
    .describe("For extend: the time in seconds of the source track to continue from (required for 'extend')."),
  custom: z
    .boolean()
    .optional()
    .describe("music/cover/extend only. false (default): prompt is a description. true: prompt is the full lyrics; style goes in tags."),
  tags: z
    .string()
    .optional()
    .describe("Music style tags, e.g. 'pop, electronic, upbeat'."),
  title: z.string().optional().describe("Song title."),
  negative_tags: z.string().optional().describe("Styles to avoid, e.g. 'metal, jazz'."),
  instrumental: z.boolean().optional().describe("true for instrumental-only (no vocals)."),
  mv: z
    .string()
    .optional()
    .describe("Suno model version for songs — default 'chirp-bluejay'; others 'chirp-v3-5', 'chirp-v4', 'chirp-auk', 'chirp-crow', 'chirp-fenix'. ('sound' defaults to 'chirp-fenix' and 'lyrics' to 'default' — both still honor an explicit mv if you pass one.)"),
  wait,
  callback_url: callbackUrl,
  confirm_cost: confirmCost,
  provider_options: providerOptions,
};

const inputSchema = z.object(inputShape).strict();

export function registerGenerateMusic(server: McpServer): void {
  server.registerTool(
    "generate_music",
    {
      title: "Generate music",
      description:
        "Full Suno suite. mode 'music' (default) makes a new song from a description (or lyrics with custom:true). " +
        "Transform an existing track (pass audio_url): 'cover' (new style), 'extend' (longer, +continue_at), 'add-vocals' / 'add-instrumental' (layer on). Split a prior clip (pass clip_id): 'stems' / 'stems-all', or 'wav' to export it. " +
        "'lyrics' writes lyrics; 'sound' makes a sound effect from a prompt. Set instrumental for no vocals. Returns the audio URL(s).",
      inputSchema: inputSchema,
      annotations: {
        title: "Generate music",
        // Irreversible spend — see generate_video for the reasoning.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (rawArgs): Promise<ToolResult> => {
      const args = inputSchema.parse(rawArgs);
      const mode = args.mode ?? "music";
      const model = MODE_MODEL[mode] ?? "suno-ai/music";

      const fail = (text: string): ToolResult => ({
        isError: true as const,
        content: [{ type: "text" as const, text }],
      });

      // Each Suno op has its own accepted fields — sending extras (tags to a
      // stems call, etc.) or missing a required one (clip_id, continue_at) makes
      // the request malformed. Build per-mode.
      const input: Record<string, unknown> = {};
      const title = () => (args.title !== undefined ? { title: args.title } : {});
      const mvChirp = args.mv ?? "chirp-bluejay";

      if (mode === "wav") {
        // WAV export: clip_id only.
        if (!args.clip_id) return fail("Suno 'wav' exports a prior clip — pass clip_id (from a completed music task).");
        input.clip_id = args.clip_id;
      } else if (CLIP_ID_MODES.has(mode)) {
        // stems / stems-all: split a prior clip. Only clip_id (+ optional title).
        if (!args.clip_id) return fail(`Suno '${mode}' splits a prior Suno generation — pass clip_id (from a completed music task).`);
        Object.assign(input, { clip_id: args.clip_id }, title());
      } else if (mode === "sound") {
        // Sound effect from a prompt. mv enum is chirp-fenix/chirp-custom.
        if (!args.prompt?.trim()) return fail("Suno 'sound' needs a prompt describing the sound effect.");
        input.mv = args.mv ?? "chirp-fenix";
        input.prompt = args.prompt;
        if (args.negative_tags !== undefined) input.negative_tags = args.negative_tags;
        Object.assign(input, title());
      } else if (mode === "lyrics") {
        if (!args.prompt?.trim()) return fail("Suno 'lyrics' needs a prompt describing the lyrics to write.");
        // The lyrics model uses a different mv enum ('default'/'remi-v1'), not chirp.
        input.mv = args.mv ?? "default";
        input.prompt = args.prompt;
      } else if (AUDIO_INPUT_MODES.has(mode)) {
        if (!args.audio_url) return fail(`Suno '${mode}' needs a source track — pass audio_url (a public https URL; upload_file for local files).`);
        try {
          input.audio_url = await resolveMediaRef(args.audio_url);
        } catch (err) {
          return toolError(err);
        }
        input.mv = mvChirp;
        if (mode === "extend") {
          if (args.continue_at === undefined) return fail("Suno 'extend' needs continue_at — the time in seconds of the source track to continue from.");
          input.continue_at = args.continue_at;
        }
        if (CUSTOM_MODES.has(mode)) {
          const custom = args.custom ?? false;
          input.custom = custom;
          if (args.prompt) input[custom ? "prompt" : "gpt_description_prompt"] = args.prompt;
        } else if (args.prompt) {
          // add-vocals / add-instrumental: guidance text only, no custom flag.
          input.prompt = args.prompt;
        }
        Object.assign(input, title());
      } else {
        // music: new song.
        if (!args.prompt?.trim()) return fail("Music generation needs a prompt (a song description, or lyrics with custom:true).");
        input.mv = mvChirp;
        const custom = args.custom ?? false;
        input.custom = custom;
        if (custom) input.prompt = args.prompt;
        else input.gpt_description_prompt = args.prompt;
        if (args.tags !== undefined) input.tags = args.tags;
        if (args.negative_tags !== undefined) input.negative_tags = args.negative_tags;
        if (args.instrumental !== undefined) input.make_instrumental = args.instrumental;
        Object.assign(input, title());
      }

      const clash = providerOptionsClash(input, args.provider_options);
      if (clash) return clash;
      Object.assign(input, args.provider_options ?? {});

      return runGeneration({
        kind: "audio",
        model,
        input,
        callback_url: args.callback_url,
        confirm_cost: args.confirm_cost,
        wait: args.wait,
      });
    },
  );
}
