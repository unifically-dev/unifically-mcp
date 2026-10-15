/**
 * Friendly aliases so an AI (or human) can say "veo", "flux", or "tts" instead
 * of memorizing exact "provider/model-id" strings. Anything that is already a
 * full model id ("provider/name") passes straight through untouched, so this is
 * purely additive — it never blocks a real id.
 */
const MODEL_ALIASES: Record<string, string> = {
  // ---- video ----
  veo: "google/veo-3.1-fast",
  "veo-fast": "google/veo-3.1-fast",
  "veo-quality": "google/veo-3.1-quality",
  "veo-lite": "google/veo-3.1-lite",
  kling: "kuaishou/kling-3.0-video",
  "kling-omni": "kuaishou/kling-3.0-omni-video",
  "kling-turbo": "kuaishou/kling-2.5-turbo-video",
  hailuo: "hailuo/minimax-2.3",
  minimax: "hailuo/minimax-2.3",
  "minimax-fast": "hailuo/minimax-2.3-fast",
  seedance: "bytedance/seedance-2.0-pro",
  // Two Grok video models, and the difference matters:
  //   grok-imagine-video      — speed-optimized 1.5 build. Does text-to-video, and
  //                             it is the ONLY one extend_video / grok-upscale can
  //                             continue (they take ITS task_ids).
  //   grok-imagine-1.5-video  — official 1.5. IMAGE-TO-VIDEO ONLY (a start image
  //                             is required), longer (to 15s) and up to 1080p.
  // 'grok-video' points at the former: generate_video's normal path is a bare
  // prompt, which 1.5 cannot do at all.
  "grok-video": "xai/grok-imagine-video",
  "grok-1.5": "xai/grok-imagine-1.5-video",
  "grok-video-1.5": "xai/grok-imagine-1.5-video",
  "veo-extend": "google/veo-3.1-extend",
  "grok-extend": "xai/grok-imagine-video-extend",

  // ---- video edit / motion ----
  "video-edit": "google/gemini-omni-flash-1.1-video-edit",
  "kling-edit": "kuaishou/kling-3.0-omni-video-edit",
  "wan-edit": "alibaba/wan-2.7-video-edit",
  // 'grok-edit' is gone: xai/grok-imagine-video-edit was removed upstream (its
  // docs page 404s and it is absent from /v1/models).
  "motion-control": "kuaishou/kling-3.0-motion-control",

  // ---- image ----
  "nano-banana": "google/nano-banana",
  "nano-banana-pro": "google/nano-banana-pro",
  "nano-banana-2": "google/nano-banana-2",
  "nano-banana-2.1": "google/nano-banana-2.1",
  "nano-banana-2-lite": "google/nano-banana-2-lite",
  nano: "google/nano-banana-pro",
  seedream: "bytedance/seedream-4.5",
  flux: "black-forest-labs/flux.2-pro",
  "flux-max": "black-forest-labs/flux.2-max",
  "flux-flex": "black-forest-labs/flux.2-flex",
  "gpt-image": "openai/gpt-image-2",
  qwen: "alibaba/qwen-image-2.0-pro",
  "kling-image": "kuaishou/kling-3.0-image",
  "grok-image": "xai/grok-imagine-image",

  // ---- audio ----
  suno: "suno-ai/music",
  music: "suno-ai/music",
  tts: "elevenlabs/text-to-speech",
  speech: "elevenlabs/text-to-speech",
  "text-to-speech": "elevenlabs/text-to-speech",
  dialogue: "elevenlabs/text-to-dialogue",
  sfx: "elevenlabs/sound-effect",
  "sound-effect": "elevenlabs/sound-effect",
  "speech-to-text": "elevenlabs/speech-to-text",
  transcribe: "elevenlabs/speech-to-text",
  stt: "elevenlabs/speech-to-text",
  "voice-changer": "elevenlabs/voice-changer",
  "voice-isolation": "elevenlabs/audio-isolation",
  "audio-isolation": "elevenlabs/audio-isolation",

  // ---- upscale ----
  "image-upscale": "topaz-labs/image-upscale",
  "video-upscale": "topaz-labs/video-upscale",
  upscale: "topaz-labs/image-upscale",
  "veo-upscale": "google/veo-3.1-upscale",
  "grok-upscale": "xai/grok-imagine-upscale",
};

/**
 * Resolve a caller-supplied model name to a real model id.
 * - `undefined`/empty -> `fallback`
 * - a known alias -> its target id
 * - anything containing "/" or otherwise unknown -> returned as-is
 */
export function resolveModel(model: string | undefined, fallback: string): string {
  if (!model || !model.trim()) return fallback;
  const key = model.trim().toLowerCase();
  return MODEL_ALIASES[key] ?? model.trim();
}

/**
 * A resolved model that still has no "/" is neither an alias nor a full id —
 * it's a near-miss like "veo3" or "nano banana". Sending it upstream costs a
 * round-trip and returns an unknown-model error with no hint; fail locally
 * with the vocabulary instead. Returns null when the model looks legitimate.
 */
const EXAMPLE_ALIASES: Record<string, string[]> = {
  video: ["veo", "kling", "hailuo", "seedance", "grok-video"],
  image: ["nano-banana-pro", "flux", "gpt-image", "qwen", "seedream"],
  audio: ["tts", "sfx", "dialogue", "stt"],
};

export function unknownModelError(resolved: string, category?: "video" | "image" | "audio"): string | null {
  if (resolved.includes("/")) return null;
  const examples = (category && EXAMPLE_ALIASES[category]) ?? Object.keys(MODEL_ALIASES).slice(0, 8);
  return (
    `Unknown model or alias '${resolved}'. Use a listed alias (e.g. ${examples.map((a) => `'${a}'`).join(", ")}) ` +
    "or a full 'provider/model' id — call list_models for the catalog."
  );
}

/** Grouped alias listing for docs / list_models output. */
export function aliasTable(): Record<string, string> {
  return { ...MODEL_ALIASES };
}
