import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Intercept the API client so tool calls never hit the network and we can
// assert the exact { model, input } payload each tool builds. These mappings
// are where doc drift bites (Topaz "2k", Suno's missing mv, Hailuo frame keys).
vi.mock("../src/unifically.js", () => ({
  createTask: vi.fn(async () => ({ task_id: "t1", status: "pending" })),
  waitForTask: vi.fn(async () => ({
    task_id: "t1",
    status: "completed",
    output: { video_url: "https://cdn.example.com/out.mp4" },
  })),
  dryRunTask: vi.fn(async () => ({ cost: 0.01 })),
  getTask: vi.fn(async () => ({ task_id: "t1", status: "completed", output: {} })),
  getAccount: vi.fn(async () => ({ user_id: 1, balance_usd: 10, email: "x@example.com" })),
  uploadFile: vi.fn(async () => ({ file_url: "https://files.example.com/f.jpg" })),
  listVoices: vi.fn(async () => ({ voices: [] })),
  getProviderResource: vi.fn(async () => []),
  listTasks: vi.fn(async () => ({
    tasks: [],
    pagination: { page: 1, page_size: 25, total: 0, total_pages: 0, has_next: false, has_previous: false },
  })),
  getModelCatalog: vi.fn(async () => []),
}));

import { createTask, waitForTask, uploadFile, listVoices, getProviderResource, getModelCatalog } from "../src/unifically.js";
import { createServer } from "../src/server.js";
import { resetConfigForTests } from "../src/config.js";

const IMG = "https://cdn.example.com/a.jpg";
const IMG2 = "https://cdn.example.com/b.jpg";
const VID = "https://cdn.example.com/a.mp4";

let client: Client;

beforeAll(async () => {
  process.env.UNIFICALLY_API_KEY = process.env.UNIFICALLY_API_KEY ?? "sk-test";
  const server = createServer();
  client = new Client({ name: "mapping-tests", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
});

beforeEach(() => {
  vi.mocked(createTask).mockClear();
});

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

function sentPayload() {
  expect(createTask).toHaveBeenCalledTimes(1);
  return vi.mocked(createTask).mock.calls[0]![0];
}

function errorText(result: Awaited<ReturnType<typeof call>>): string {
  expect(result.isError).toBe(true);
  const content = result.content as Array<{ text?: string }>;
  return content[0]?.text ?? "";
}

describe("generate_video frame/reference field mapping", () => {
  it("Veo uses start_image_url/end_image_url and reference_image_urls", async () => {
    await call("generate_video", { prompt: "p", model: "veo", image_url: IMG, end_image_url: IMG2 });
    const { model, input } = sentPayload();
    expect(model).toBe("google/veo-3.1-fast");
    expect(input.start_image_url).toBe(IMG);
    expect(input.end_image_url).toBe(IMG2);

    vi.mocked(createTask).mockClear();
    await call("generate_video", { prompt: "p", model: "veo", reference_image_urls: [IMG] });
    expect(sentPayload().input.reference_image_urls).toEqual([IMG]);
  });

  it("Kling uses start_frame_url/end_frame_url and image_urls for references", async () => {
    await call("generate_video", { prompt: "p", model: "kling", image_url: IMG, end_image_url: IMG2 });
    const { input } = sentPayload();
    expect(input.start_frame_url).toBe(IMG);
    expect(input.end_frame_url).toBe(IMG2);
    expect(input.start_image_url).toBeUndefined();

    vi.mocked(createTask).mockClear();
    await call("generate_video", { prompt: "p", model: "kling-omni", reference_image_urls: [IMG] });
    expect(sentPayload().input.image_urls).toEqual([IMG]);
  });

  it("Hailuo uses start_image_url (not the Kling frame names)", async () => {
    await call("generate_video", { prompt: "p", model: "hailuo", image_url: IMG });
    const { model, input } = sentPayload();
    expect(model).toBe("hailuo/minimax-2.3");
    expect(input.start_image_url).toBe(IMG);
    expect(input.start_frame_url).toBeUndefined();
  });

  it("Seedance uses first_frame_url/last_frame_url and image_urls", async () => {
    await call("generate_video", { prompt: "p", model: "seedance", image_url: IMG, end_image_url: IMG2 });
    const { input } = sentPayload();
    expect(input.first_frame_url).toBe(IMG);
    expect(input.last_frame_url).toBe(IMG2);
  });

  it("'grok-video' resolves to the speed-optimized build, which does text-to-video", async () => {
    // The alias must NOT point at xai/grok-imagine-1.5-video: that one is
    // image-to-video only, so generate_video's normal path (a bare prompt) would
    // be impossible.
    await call("generate_video", { prompt: "p", model: "grok-video" });
    expect(sentPayload().model).toBe("xai/grok-imagine-video");
  });

  it("Grok maps the start frame to start_image_url (NOT start_frame_image_url)", async () => {
    // Grok used to want start_frame_image_url. Both Grok video models now take
    // plain start_image_url; this pinned the stale key and the MCP was sending a
    // field that no longer exists.
    await call("generate_video", { prompt: "p", model: "grok-video", image_url: IMG });
    const { input } = sentPayload();
    expect(input.start_image_url).toBe(IMG);
    expect(input.start_frame_image_url).toBeUndefined();
  });

  it("Grok maps references to image_urls", async () => {
    await call("generate_video", { prompt: "p", model: "grok-video", reference_image_urls: [IMG] });
    expect(sentPayload().input.image_urls).toEqual([IMG]);
  });

  it("grok-1.5 maps a start frame on the same start_image_url key", async () => {
    await call("generate_video", { prompt: "p", model: "grok-1.5", image_url: IMG });
    const { model, input } = sentPayload();
    expect(model).toBe("xai/grok-imagine-1.5-video");
    expect(input.start_image_url).toBe(IMG);
  });

  it("keeps the two guards whose upstream error LIES about whose fault it is", async () => {
    // Measured against the live API (2026-07-17). Value rules like duration are
    // caught upstream as a free, precise 422, so we don't duplicate them. These
    // two are not caught at all — they reach the provider and come back as:
    //   grok-1.5 + bare prompt          -> 500 "Model configuration error.
    //                                      Please contact support"
    //   grok start frame + references   -> 503 "no alternative channels found to
    //                                      reroute; please try again later"
    // Both blame the platform for a bad request. The 503 is worse than useless:
    // it is precisely the shape of error an agent retries. Nothing upstream will
    // ever name the real fix, so these local messages are the only honest answer.
    const bare = await call("generate_video", { prompt: "p", model: "grok-1.5" });
    expect(errorText(bare)).toMatch(/image-to-video ONLY|needs a start image/i);

    const both = await call("generate_video", { prompt: "p", model: "grok-video", image_url: IMG, reference_image_urls: [IMG2] });
    expect(errorText(both)).toMatch(/OR reference images|not both/i);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("passes aspect_ratio through even for models that may not take one, rather than dropping it", async () => {
    // Hailuo sizes by resolution and (today) has no aspect_ratio. We used to
    // silently delete the field for it. Silence is the worst outcome: the user
    // pays for a render at a shape they did not ask for. Send it and let the
    // provider reject it for free — and if Hailuo ever gains aspect_ratio, this
    // already works instead of quietly swallowing it.
    await call("generate_video", { prompt: "p", model: "hailuo", aspect_ratio: "16:9" });
    expect(sentPayload().input.aspect_ratio).toBe("16:9");
  });

  it("rejects local file paths with upload_file guidance", async () => {
    const result = await call("generate_video", { prompt: "p", image_url: "C:\\photos\\me.jpg" });
    expect(errorText(result)).toContain("upload_file");
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("upscale_media routing", () => {
  it("video_url routes to Topaz video upscale with a valid default resolution", async () => {
    await call("upscale_media", { video_url: VID });
    const { model, input } = sentPayload();
    expect(model).toBe("topaz-labs/video-upscale");
    expect(input.video_url).toBe(VID);
    expect(input.resolution).toBe("4k");
  });

  it("passes an unrecognized VIDEO resolution through instead of gatekeeping it", async () => {
    // We no longer keep an allowlist of Topaz's resolutions — it would reject a
    // size Topaz has since added, and nobody can route around a gate inside this
    // server. An unsupported size is a free provider 400.
    await call("upscale_media", { video_url: VID, resolution: "2k" });
    expect(sentPayload().input.resolution).toBe("2k");
  });

  it("image_url routes to Topaz image upscale with an explicit factor", async () => {
    await call("upscale_media", { image_url: IMG, upscale_factor: "2x" });
    const { model, input } = sentPayload();
    expect(model).toBe("topaz-labs/image-upscale");
    expect(input.image_url).toBe(IMG);
    expect(input.upscale_factor).toBe("2x");
    expect(input.resolution).toBeUndefined();
  });

  it("image upscale takes a factor and rejects an absolute-size token", async () => {
    await call("upscale_media", { image_url: IMG, upscale_factor: "4x" });
    expect(sentPayload().input.upscale_factor).toBe("4x");

    // '2k' is an absolute size, NOT a 2x factor — must be rejected, not silently
    // reinterpreted into a bigger, costlier image.
    vi.mocked(createTask).mockClear();
    const r = await call("upscale_media", { image_url: IMG, resolution: "2k" });
    expect(errorText(r)).toContain("2x");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("task_id requires a model-internal upscaler and routes veo-upscale correctly", async () => {
    const bare = await call("upscale_media", { task_id: "abc" });
    expect(errorText(bare)).toContain("veo-upscale");
    expect(createTask).not.toHaveBeenCalled();

    await call("upscale_media", { task_id: "abc", model: "veo-upscale" });
    const { model, input } = sentPayload();
    expect(model).toBe("google/veo-3.1-upscale");
    expect(input).toMatchObject({ task_id: "abc", resolution: "4k" });
  });

  it("requires exactly one source", async () => {
    const result = await call("upscale_media", { image_url: IMG, video_url: VID });
    expect(errorText(result)).toContain("exactly one");
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("result rendering", () => {
  it("surfaces the audio URLs (not cover art) for nested Suno-style outputs, listing all of them", async () => {
    vi.mocked(waitForTask).mockResolvedValueOnce({
      task_id: "t1",
      status: "completed",
      output: {
        clips: [
          { image_url: "https://cdn.example.com/cover1.jpg", audio_url: "https://cdn.example.com/song1.mp3" },
          { image_url: "https://cdn.example.com/cover2.jpg", audio_url: "https://cdn.example.com/song2.mp3" },
        ],
      },
    });
    const result = await call("generate_music", { prompt: "an upbeat song" });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(text).toContain("song1.mp3");
    expect(text).toContain("song2.mp3");
    expect(text).not.toContain("cover1.jpg");
  });

  it("dumps the raw output when no URL is recognized instead of a bare 'completed'", async () => {
    vi.mocked(waitForTask).mockResolvedValueOnce({
      task_id: "t1",
      status: "completed",
      output: { something_else: "value" },
    });
    const result = await call("generate_music", { prompt: "a song" });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(text).toContain("something_else");
  });
});

describe("extend_video model routing", () => {
  it("accepts full ids and aliases, routing to the right extender", async () => {
    await call("extend_video", { task_id: "abc", prompt: "keep going" });
    expect(sentPayload().model).toBe("google/veo-3.1-extend");

    vi.mocked(createTask).mockClear();
    await call("extend_video", { task_id: "abc", model: "xai/grok-imagine-video-extend", video_preset: "spicy" });
    expect(sentPayload().model).toBe("xai/grok-imagine-video-extend");

    vi.mocked(createTask).mockClear();
    await call("extend_video", { task_id: "abc", model: "grok-extend", video_preset: "normal" });
    expect(sentPayload().model).toBe("xai/grok-imagine-video-extend");
  });

  it("rejects a non-extender model", async () => {
    const r = await call("extend_video", { task_id: "abc", prompt: "x", model: "flux" });
    expect(errorText(r)).toContain("not a video extender");
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("edit_video", () => {
  it("default Gemini edit sends the source under reference_video_urls (not video_url)", async () => {
    await call("edit_video", { video_url: VID, prompt: "make it snow", image_urls: [IMG] });
    const { model, input } = sentPayload();
    expect(model).toBe("google/gemini-omni-flash-1.1-video-edit");
    expect(input.reference_video_urls).toEqual([VID]);
    expect(input.video_url).toBeUndefined();
    expect(input.reference_image_urls).toEqual([IMG]);
    expect(input.prompt).toBe("make it snow");
  });

  it("kling omni edit uses video_url + image_urls", async () => {
    await call("edit_video", { video_url: VID, prompt: "x", model: "kling-edit", image_urls: [IMG] });
    const { model, input } = sentPayload();
    expect(model).toBe("kuaishou/kling-3.0-omni-video-edit");
    expect(input.video_url).toBe(VID);
    expect(input.image_urls).toEqual([IMG]);
  });

  it("wan edit maps aspect_ratio to ratio and refs to reference_image_urls", async () => {
    await call("edit_video", { video_url: VID, prompt: "x", model: "wan-edit", image_urls: [IMG], aspect_ratio: "16:9" });
    const { input } = sentPayload();
    expect(input.ratio).toBe("16:9");
    expect(input.aspect_ratio).toBeUndefined();
    expect(input.reference_image_urls).toEqual([IMG]);
  });

  it("motion-control sends the subject as a single image_url and requires it", async () => {
    const missing = await call("edit_video", { video_url: VID, prompt: "apply motion", model: "motion-control" });
    expect(errorText(missing)).toContain("image_urls");
    expect(createTask).not.toHaveBeenCalled();

    await call("edit_video", { video_url: VID, prompt: "apply motion", model: "motion-control", image_urls: [IMG] });
    const { model, input } = sentPayload();
    expect(model).toBe("kuaishou/kling-3.0-motion-control");
    expect(input.image_url).toBe(IMG);
    expect(input.image_urls).toBeUndefined();
  });

  it("generate_video redirects an edit model to edit_video", async () => {
    const r = await call("generate_video", { prompt: "x", model: "video-edit" });
    expect(errorText(r)).toContain("edit_video");
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("generate_music suite", () => {
  it("cover mode routes to suno cover and requires audio_url", async () => {
    const missing = await call("generate_music", { mode: "cover", prompt: "jazz style" });
    expect(errorText(missing)).toContain("audio_url");
    expect(createTask).not.toHaveBeenCalled();

    await call("generate_music", { mode: "cover", audio_url: "https://cdn.example.com/song.mp3", prompt: "jazz style" });
    const { model, input } = sentPayload();
    expect(model).toBe("suno-ai/cover");
    expect(input.audio_url).toBe("https://cdn.example.com/song.mp3");
  });

  it("stems mode needs clip_id (not audio_url) and sends only clip_id/title", async () => {
    const missing = await call("generate_music", { mode: "stems", audio_url: "https://cdn.example.com/song.mp3" });
    expect(errorText(missing)).toContain("clip_id");
    expect(createTask).not.toHaveBeenCalled();

    await call("generate_music", { mode: "stems", clip_id: "clip123" });
    const { model, input } = sentPayload();
    expect(model).toBe("suno-ai/stems");
    expect(input.clip_id).toBe("clip123");
    expect(input.audio_url).toBeUndefined();
    expect(input.mv).toBeUndefined();
  });

  it("extend mode requires continue_at", async () => {
    const missing = await call("generate_music", { mode: "extend", audio_url: "https://cdn.example.com/song.mp3" });
    expect(errorText(missing)).toContain("continue_at");

    await call("generate_music", { mode: "extend", audio_url: "https://cdn.example.com/song.mp3", continue_at: 30 });
    const { model, input } = sentPayload();
    expect(model).toBe("suno-ai/extend");
    expect(input.continue_at).toBe(30);
  });

  it("lyrics mode uses the lyrics mv default, not chirp", async () => {
    await call("generate_music", { mode: "lyrics", prompt: "a song about the sea" });
    const { model, input } = sentPayload();
    expect(model).toBe("suno-ai/lyrics");
    expect(input.mv).toBe("default");
  });

  it("sound mode routes to suno sound with the chirp-fenix mv", async () => {
    await call("generate_music", { mode: "sound", prompt: "a thunderclap" });
    const { model, input } = sentPayload();
    expect(model).toBe("suno-ai/sound");
    expect(input.mv).toBe("chirp-fenix");
    expect(input.prompt).toBe("a thunderclap");
  });

  it("wav mode exports a clip and sends only clip_id", async () => {
    const missing = await call("generate_music", { mode: "wav" });
    expect(errorText(missing)).toContain("clip_id");

    await call("generate_music", { mode: "wav", clip_id: "clip123" });
    const { model, input } = sentPayload();
    expect(model).toBe("suno-ai/wav");
    expect(input.clip_id).toBe("clip123");
    expect(input.title).toBeUndefined();
    expect(input.mv).toBeUndefined();
  });
});

describe("generate_audio transforms", () => {
  it("voice-changer routes with audio_url", async () => {
    const missing = await call("generate_audio", { model: "voice-changer" });
    expect(errorText(missing)).toContain("audio_url");

    const needsVoice = await call("generate_audio", { model: "voice-changer", audio_url: "https://cdn.example.com/a.mp3" });
    expect(errorText(needsVoice)).toContain("voice_id");
    expect(createTask).not.toHaveBeenCalled();

    await call("generate_audio", { model: "voice-changer", audio_url: "https://cdn.example.com/a.mp3", voice_id: "abc" });
    const { model, input } = sentPayload();
    expect(model).toBe("elevenlabs/voice-changer");
    expect(input.audio_url).toBe("https://cdn.example.com/a.mp3");
    expect(input.voice_id).toBe("abc");
  });

  it("voice-isolation routes to audio-isolation and does NOT attach voice_id", async () => {
    await call("generate_audio", { model: "voice-isolation", audio_url: "https://cdn.example.com/a.mp3", voice_id: "abc" });
    const { model, input } = sentPayload();
    expect(model).toBe("elevenlabs/audio-isolation");
    expect(input.voice_id).toBeUndefined();
  });
});

describe("generate_music (Suno)", () => {
  it("simple mode sends the required mv and gpt_description_prompt", async () => {
    await call("generate_music", { prompt: "an upbeat synthpop song about rain" });
    const { model, input } = sentPayload();
    expect(model).toBe("suno-ai/music");
    expect(input).toMatchObject({
      mv: "chirp-bluejay",
      custom: false,
      gpt_description_prompt: "an upbeat synthpop song about rain",
    });
    expect(input.prompt).toBeUndefined();
  });

  it("custom mode sends prompt as lyrics plus tags/title", async () => {
    await call("generate_music", { prompt: "[Verse 1]\nrain falls", custom: true, tags: "synthpop", title: "Rain" });
    const { input } = sentPayload();
    expect(input).toMatchObject({ custom: true, prompt: "[Verse 1]\nrain falls", tags: "synthpop", title: "Rain" });
    expect(input.gpt_description_prompt).toBeUndefined();
  });
});

describe("generate_audio", () => {
  it("tts sends voice and no pinned model_id", async () => {
    await call("generate_audio", { prompt: "hello" });
    const { model, input } = sentPayload();
    expect(model).toBe("elevenlabs/text-to-speech");
    expect(input.text).toBe("hello");
    expect(typeof input.voice).toBe("string");
    expect(input.model_id).toBeUndefined();
  });

  it("stt requires audio_url and prices with a default duration", async () => {
    const missing = await call("generate_audio", { model: "stt" });
    expect(errorText(missing)).toContain("audio_url");
    expect(createTask).not.toHaveBeenCalled();

    await call("generate_audio", { model: "stt", audio_url: VID, diarize: true });
    const { model, input } = sentPayload();
    expect(model).toBe("elevenlabs/speech-to-text");
    expect(input).toMatchObject({ audio_url: VID, duration: 300, diarize: true });
  });

  it("redirects Suno music to generate_music", async () => {
    const result = await call("generate_audio", { prompt: "a song", model: "suno" });
    expect(errorText(result)).toContain("generate_music");
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("list_resources covers every voice provider", () => {
  const textOf = (r: Awaited<ReturnType<typeof call>>) => ((r.content as Array<{ text?: string }>)[0]?.text ?? "");

  it("returns ElevenLabs voices (default) with voice_id", async () => {
    vi.mocked(listVoices).mockResolvedValueOnce({
      voices: [{ voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", category: "premade", labels: { gender: "female" } }],
    });
    const r = await call("list_resources", {});
    expect(textOf(r)).toContain("21m00Tcm4TlvDq8ikWAM");
    expect(textOf(r)).toContain("Rachel");
    expect(textOf(r)).toContain("voice_id");
  });

  it("returns Kling voices (data[] {id,name}) as voice_id, and Veo voices as 'voice'", async () => {
    // Real live shapes: Kling returns a BARE array; Veo wraps it in { voices: [] }.
    vi.mocked(getProviderResource).mockImplementation(async (path: string) => {
      if (path.includes("kuaishou/kling")) return [{ id: 7, name: "Male Voice 1" }] as unknown as [];
      if (path.includes("google/voices/veo")) return { voices: [{ id: "achernar", name: "Achernar", description: "Female, soft" }] } as unknown as [];
      return [] as [];
    });

    const kling = await call("list_resources", { resource: "kling" });
    expect(textOf(kling)).toContain("Male Voice 1");
    expect(textOf(kling)).toMatch(/\b7\b/);
    expect(textOf(kling)).toContain("voice_id");

    const veo = await call("list_resources", { resource: "veo" });
    expect(textOf(veo)).toContain("achernar");
    expect(textOf(veo)).toContain("Achernar");
    expect(textOf(veo)).toContain("'voice'");
    vi.mocked(getProviderResource).mockReset();
    vi.mocked(getProviderResource).mockResolvedValue([] as []);
  });
});

describe("agent-trap guards", () => {
  it("rejects provider_options that override computed fields", async () => {
    const result = await call("generate_video", { prompt: "p", model: "veo", image_url: IMG, provider_options: { start_image_url: "C:\\x.jpg" } });
    expect(errorText(result)).toContain("start_image_url");
    expect(createTask).not.toHaveBeenCalled();

    const music = await call("generate_music", { prompt: "a song", provider_options: { custom: true } });
    expect(errorText(music)).toContain("custom");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("still allows provider_options for unmanaged fields", async () => {
    await call("generate_video", { prompt: "p", model: "kling-omni", provider_options: { multi_shots: [{ prompt: "a", duration: 5 }] } });
    expect(sentPayload().input.multi_shots).toBeDefined();
  });

  it("rejects unknown/extra parameters instead of silently dropping them (strict schemas)", async () => {
    // A typo'd or unsupported param must surface as an error the agent can fix,
    // not vanish — matching the published additionalProperties:false schema.
    let rejected = false;
    let message = "";
    try {
      const r = await call("generate_video", { prompt: "p", model: "veo", negative_prmpt: "typo", bogus_param: 1 });
      rejected = r.isError === true;
      const content = (r.content as Array<{ text?: string }>) ?? [];
      message = content[0]?.text ?? "";
    } catch (e) {
      rejected = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(rejected).toBe(true);
    expect(message).toMatch(/unrecognized|not allowed|invalid|unexpected/i);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("rejects extra keys inside dialogue turns (nested strict)", async () => {
    let rejected = false;
    try {
      const r = await call("generate_audio", { model: "dialogue", dialogue: [{ text: "hi", voice_id: "v1", bogus: 1 }] });
      rejected = r.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("rejects SSRF media URLs (private/metadata hosts) before spending", async () => {
    const img = await call("generate_image", { prompt: "p", image_url: "http://169.254.169.254/latest/meta-data/" });
    expect(errorText(img)).toMatch(/SSRF|private|link-local|metadata/i);
    expect(createTask).not.toHaveBeenCalled();

    // Non-web scheme handed to the CDN importer is refused too.
    const up = await call("upload_file", { url: "file:///etc/passwd" });
    expect(errorText(up)).toMatch(/http\(s\)|not allowed|file:/i);
  });

  it("refuses upload_file file_path on a hosted (non-stdio) server", async () => {
    // file_path reads the server's own disk — on a hosted server that would be
    // arbitrary file read + exfiltration. It must be rejected there, before any
    // filesystem access, and never reach uploadFile.
    process.env.MCP_TRANSPORT = "http";
    resetConfigForTests();
    try {
      const result = await call("upload_file", { file_path: "/etc/passwd" });
      expect(errorText(result)).toContain("not allowed on this server");
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      delete process.env.MCP_TRANSPORT;
      resetConfigForTests();
    }
  });

  it("rejects reserved provider_options keys that would evade the model gate", async () => {
    // `model` in provider_options would slip a different (possibly blocked)
    // model past the operator gate, which only sees the resolved top-level id.
    const overrideModel = await call("generate_video", { prompt: "p", model: "veo", provider_options: { model: "google/veo-3.1-quality" } });
    expect(errorText(overrideModel)).toContain("model");
    expect(createTask).not.toHaveBeenCalled();

    // Same for a case-variant of an auth/billing field.
    const overrideAuth = await call("generate_image", { prompt: "p", provider_options: { Authorization: "Bearer x" } });
    expect(errorText(overrideAuth)).toContain("Authorization");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("tells the caller when a URL is missing its scheme instead of calling it a file path", async () => {
    const result = await call("generate_video", { prompt: "p", image_url: "example.com/photo.jpg" });
    expect(errorText(result)).toContain("https://example.com/photo.jpg");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only prompts", async () => {
    const result = await call("generate_image", { prompt: "   " });
    expect(result.isError).toBe(true);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("rejects near-miss model names locally", async () => {
    const result = await call("generate_video", { prompt: "p", model: "veo3" });
    expect(errorText(result)).toContain("list_models");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("redirects cross-category model choices", async () => {
    const video = await call("generate_video", { prompt: "p", model: "flux" });
    expect(errorText(video)).toContain("generate_image");

    const image = await call("generate_image", { prompt: "p", model: "veo" });
    expect(errorText(image)).toContain("generate_video");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("does NOT second-guess per-model values or combinations — it forwards them", async () => {
    // This is the point of the model-docs rule, expressed as a test. We used to
    // enforce "Veo durations are 4/6/8" here. The day Veo adds one, that guard
    // rejects a call the user is paying for and entitled to — and unlike a wrong
    // value (a free provider 400), a gate inside this server cannot be routed
    // around. The agent reads the model's page; we forward what it asked for.
    await call("generate_video", { prompt: "p", model: "veo", duration: 5 });
    expect(sentPayload().input.duration).toBe(5);

    vi.mocked(createTask).mockClear();
    await call("generate_video", { prompt: "p", model: "veo", image_url: IMG, reference_image_urls: [IMG2] });
    const { input } = sentPayload();
    expect(input.start_image_url).toBe(IMG);
    expect(input.reference_image_urls).toEqual([IMG2]);
  });

  it("accepts full ids for the model-internal upscalers", async () => {
    await call("upscale_media", { task_id: "abc", model: "google/veo-3.1-upscale" });
    expect(sentPayload().model).toBe("google/veo-3.1-upscale");
  });

  it("validates the Topaz image factor", async () => {
    const result = await call("upscale_media", { image_url: IMG, resolution: "1080p" });
    expect(errorText(result)).toContain("2x");
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("generate_image", () => {
  it("does not force a resolution the model may not accept", async () => {
    await call("generate_image", { prompt: "a cat" });
    const { model, input } = sentPayload();
    expect(model).toBe("google/nano-banana-pro");
    expect(input.resolution).toBeUndefined();
  });

  it("redirects upscaler model ids to upscale_media", async () => {
    const result = await call("generate_image", { prompt: "x", model: "image-upscale" });
    expect(errorText(result)).toContain("upscale_media");
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("list_models provider naming (owned_by key + provider_display)", () => {
  // Live shape as of 2026-07-19: the stable key stayed `owned_by` and a human
  // `provider_display` was added alongside it.
  const CATALOG = [
    { id: "black-forest-labs/flux.2-pro", owned_by: "black-forest-labs", provider_display: "Black Forest Labs", display_name: "Flux.2 Pro", category: "image" },
    { id: "xai/grok-imagine-image", owned_by: "xai", provider_display: "xAI", display_name: "Grok Imagine Image", category: "image" },
  ];

  const textOf = (r: Awaited<ReturnType<typeof call>>) => ((r.content as Array<{ text?: string }>)[0]?.text ?? "");

  beforeEach(() => {
    vi.mocked(getModelCatalog).mockResolvedValue(CATALOG as never);
  });

  it("filters by the human name a user would actually say", async () => {
    // The reason provider_display is accepted as input: an agent relaying
    // "Black Forest Labs" must not get an empty list because the key is
    // 'black-forest-labs'.
    const r = await call("list_models", { provider: "Black Forest Labs", refresh: true });
    expect(textOf(r)).toContain("black-forest-labs/flux.2-pro");
    expect(textOf(r)).not.toContain("xai/grok-imagine-image");
  });

  it("still filters by the stable key, case-insensitively", async () => {
    for (const p of ["black-forest-labs", "BLACK-FOREST-LABS"]) {
      const r = await call("list_models", { provider: p, refresh: true });
      expect(textOf(r), p).toContain("flux.2-pro");
    }
  });

  it("echoes the catalog's display name, not the lowercased input", async () => {
    // The filter lowercases to compare, and the heading used to reflect that
    // back — rendering "from black forest labs" and "from xai".
    expect(textOf(await call("list_models", { provider: "black forest labs", refresh: true }))).toContain("from Black Forest Labs");
    expect(textOf(await call("list_models", { provider: "xai", refresh: true }))).toContain("from xAI");
  });
});
