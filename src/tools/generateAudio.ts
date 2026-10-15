import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveModel, unknownModelError } from "../aliases.js";
import { toolError } from "../errors.js";
import { resolveMediaRef } from "../media.js";
import { callbackUrl, confirmCost, providerOptions, wait } from "../schemas.js";
import { providerOptionsClash, runGeneration, type ToolResult } from "./_helpers.js";

const inputShape = {
  prompt: z
    .string()
    .optional()
    .describe(
      "The content to synthesize: spoken text for text-to-speech/dialogue, or the sound description for sound effects. Not used for transcription (pass audio_url instead).",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model, as a short alias or full id. Aliases: 'tts' (default, text-to-speech), 'sfx' (sound effect), 'dialogue', 'stt' (transcribe), 'voice-changer' (transform a voice, needs audio_url), 'voice-isolation' (clean/isolate audio, needs audio_url). Full ids also work. For music use generate_music.",
    ),
  voice_id: z
    .string()
    .optional()
    .describe("Voice id for text-to-speech. Discover available voices with the list_resources tool. Falls back to a default voice if omitted."),
  dialogue: z
    .array(z.object({ text: z.string().min(1), voice_id: z.string().min(1) }).strict())
    .min(1)
    .optional()
    .describe("Model 'dialogue' only: the conversation as an array of turns, each { text, voice_id } (voice ids from list_resources). Replaces prompt for dialogue."),
  duration: z
    .number()
    .positive()
    // Capped at 10h: this number is the BILLING BASIS for transcription, so an
    // unbounded value is an unbounded charge. The cost gate (which would have
    // caught it) is opt-in and off by default, making this the only ceiling.
    .max(36000)
    .optional()
    .describe(
      "Duration in seconds (max 36000 = 10h, a billing ceiling this server imposes — not a model limit). Sound effects: omit for automatic. Transcription: the job is PRICED by this declared length (defaults to 300s = 5 min) — pass the audio's real length or short clips are overcharged.",
    ),
  audio_url: z
    .string()
    .min(1)
    .optional()
    .describe("Source audio (public https URL) for audio-input models: transcription ('stt'), voice change ('voice-changer'), and cleanup ('voice-isolation'). For local files, upload_file first."),
  language_code: z
    .string()
    .optional()
    .describe("Transcription: optional ISO 639 language code (e.g. 'eng', 'spa'). Auto-detected when omitted."),
  diarize: z
    .boolean()
    .optional()
    .describe("Transcription: label who is speaking (speaker diarization). Default false."),
  wait,
  callback_url: callbackUrl,
  confirm_cost: confirmCost,
  provider_options: providerOptions,
};

const inputSchema = z.object(inputShape).strict();

const DEFAULT_TTS_VOICE = "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs "Rachel" premade voice.

export function registerGenerateAudio(server: McpServer): void {
  server.registerTool(
    "generate_audio",
    {
      title: "Generate audio",
      description:
        "Speech and sound: text-to-speech (default; optional voice_id, see list_resources), sound effects (model 'sfx', optional duration), " +
        "multi-voice dialogue (model 'dialogue': pass the turns in the dialogue parameter, not prompt), transcription (model 'stt': pass audio_url, get text back; optional diarize/language_code), " +
        "voice change (model 'voice-changer': audio_url + target voice_id) and audio cleanup (model 'voice-isolation': audio_url). " +
        "Returns the audio URL (or the transcript for 'stt'). For music, use generate_music.",
      inputSchema: inputSchema,
      annotations: {
        title: "Generate audio",
        // Irreversible spend — see generate_video for the reasoning.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (rawArgs): Promise<ToolResult> => {
      const args = inputSchema.parse(rawArgs);
      const model = resolveModel(args.model, "elevenlabs/text-to-speech");

      const fail = (text: string): ToolResult => ({
        isError: true as const,
        content: [{ type: "text" as const, text }],
      });

      const unknown = unknownModelError(model, "audio");
      if (unknown) return fail(unknown);
      if (model.startsWith("suno-ai/")) {
        return fail("Music generation moved to the generate_music tool — call that with your song description (Suno).");
      }
      if (/video|veo|kling|hailuo|seedance/.test(model)) return fail(`'${model}' is a video model — use generate_video.`);
      if (/image|flux|banana|seedream/.test(model)) return fail(`'${model}' is an image model — use generate_image.`);

      // Transcription: audio in, text out.
      if (model === "elevenlabs/speech-to-text") {
        if (!args.audio_url) {
          return fail("Transcription requires audio_url (a public https URL of the audio/video to transcribe). For local files, upload_file first.");
        }
        let audioUrl: string;
        try {
          audioUrl = await resolveMediaRef(args.audio_url);
        } catch (err) {
          return toolError(err);
        }
        const input: Record<string, unknown> = {
          audio_url: audioUrl,
          // The API needs a duration to price the job before it runs.
          duration: args.duration ?? 300,
          ...(args.language_code !== undefined ? { language_code: args.language_code } : {}),
          ...(args.diarize !== undefined ? { diarize: args.diarize } : {}),
        };
        const clash = providerOptionsClash(input, args.provider_options);
        if (clash) return clash;
        Object.assign(input, args.provider_options ?? {});
        return runGeneration({
          kind: "transcription",
          model,
          input,
          callback_url: args.callback_url,
          confirm_cost: args.confirm_cost,
          wait: args.wait,
        });
      }

      // Audio-input transforms (voice change, isolation): audio in, audio out.
      if (model === "elevenlabs/voice-changer" || model === "elevenlabs/audio-isolation") {
        if (!args.audio_url) {
          return fail(`'${model}' needs a source track — pass audio_url (a public https URL; upload_file for local files).`);
        }
        let audioUrl: string;
        try {
          audioUrl = await resolveMediaRef(args.audio_url);
        } catch (err) {
          return toolError(err);
        }
        const input: Record<string, unknown> = { audio_url: audioUrl };
        if (model === "elevenlabs/voice-changer") {
          // voice-changer requires a target voice_id (audio-isolation takes none).
          if (!args.voice_id) {
            return fail("voice-changer needs a target voice_id (from list_resources) to change the audio into.");
          }
          input.voice_id = args.voice_id;
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
      }

      // Dialogue takes a structured turn list, not a flat prompt.
      if (model === "elevenlabs/text-to-dialogue") {
        if (!args.dialogue?.length) {
          return fail("Dialogue requires the dialogue parameter: an array of turns, each { text, voice_id } (voice ids from list_resources). prompt is not used for this model.");
        }
        const input: Record<string, unknown> = {
          dialogue: args.dialogue.map((turn) => ({ text: turn.text, voice: turn.voice_id })),
        };
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
      }

      if (!args.prompt?.trim()) {
        return fail("prompt is required (the text to speak, or the sound to describe).");
      }

      let input: Record<string, unknown>;
      if (model === "elevenlabs/sound-effect") {
        input = {
          text: args.prompt,
          ...(args.duration !== undefined ? { duration: args.duration } : {}),
        };
      } else if (model === "elevenlabs/text-to-speech") {
        // ElevenLabs TTS wants `voice` (the voice_id value); model_id defaults
        // to eleven_flash_v2_5 server-side and can be overridden via provider_options.
        input = {
          text: args.prompt,
          voice: args.voice_id?.trim() || DEFAULT_TTS_VOICE,
        };
      } else {
        // Dialogue and any other audio model: pass text through, plus optional voice.
        input = {
          text: args.prompt,
          ...(args.voice_id !== undefined ? { voice_id: args.voice_id } : {}),
        };
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
