import { describe, expect, it } from "vitest";

import { normalizeCatalog } from "../src/models.js";

// GET /v1/models is changing: today it emits input/output_modalities and NO
// category; it will emit an explicit category (llm|video|image|audio) and drop
// the modality arrays. The MCP and the API deploy independently, so BOTH shapes
// must work — whichever ships first must not break the other. These tests pin
// that, and are the reason the catalog isn't coded to one version.

// Verbatim from live api.unifically.com (2026-07-16).
const CURRENT_SHAPE = [
  { id: "elevenlabs/audio-isolation", object: "model", owned_by: "elevenlabs", display_name: "ElevenLabs Audio Isolation", input_modalities: ["audio"], output_modalities: ["audio"] },
  { id: "google/veo-3.1-fast", object: "model", owned_by: "google", display_name: "Google Veo 3.1 Fast", input_modalities: ["text", "image"], output_modalities: ["video"] },
  { id: "google/nano-banana-2", object: "model", owned_by: "google", display_name: "Nano Banana 2", input_modalities: ["text", "image"], output_modalities: ["image"] },
  { id: "openai/gpt-5", object: "model", owned_by: "openai", display_name: "GPT-5", input_modalities: ["text"], output_modalities: ["text"] },
];

// The incoming shape.
const NEW_SHAPE = [
  { id: "elevenlabs/audio-isolation", owned_by: "elevenlabs", display_name: "ElevenLabs Audio Isolation", category: "audio" },
  { id: "google/veo-3.1-fast", owned_by: "google", display_name: "Google Veo 3.1 Fast", category: "video" },
  { id: "google/nano-banana-2", owned_by: "google", display_name: "Nano Banana 2", category: "image" },
  { id: "openai/gpt-5", owned_by: "openai", display_name: "GPT-5", category: "llm" },
];

// Provider naming is migrating the same way: `owned_by` becomes an explicit
// pair — `provider`, the stable machine key that never changes, and
// `provider_display`, the human name. Verbatim from the API change note.
const PROVIDER_SHAPE = [
  { id: "moonshotai/kimi-k3", provider: "moonshotai", provider_display: "Moonshot AI", display_name: "Kimi K3", category: "llm" },
  { id: "google/veo-3.1-fast", provider: "google", provider_display: "Google", display_name: "Veo 3.1 Fast", category: "video" },
  { id: "black-forest-labs/flux.2-pro", provider: "black-forest-labs", provider_display: "Black Forest Labs", display_name: "Flux.2 Pro", category: "image" },
];

const byId = (models: ReturnType<typeof normalizeCatalog>) =>
  Object.fromEntries(models.map((m) => [m.id, m.category]));

describe("catalog: provider naming (owned_by -> provider + provider_display)", () => {
  it("reads the new provider pair", () => {
    const models = normalizeCatalog(PROVIDER_SHAPE);
    const veo = models.find((m) => m.id === "google/veo-3.1-fast");
    expect(veo?.provider).toBe("google");
    expect(veo?.provider_display).toBe("Google");
  });

  it("still reads owned_by, so either side can deploy first", () => {
    // The whole point: the MCP and the API ship independently. Reading only the
    // new field would empty the catalog until the API deploys; reading only the
    // old one would empty it the moment the API does.
    const [m] = normalizeCatalog([{ id: "google/veo-3.1-fast", owned_by: "google", display_name: "Veo 3.1 Fast", category: "video" }]);
    expect(m?.provider).toBe("google");
  });

  it("prefers `provider` over `owned_by` when both are present", () => {
    // During the transition both may ship. `provider` is documented as the
    // stable key, so it wins — otherwise the identity we filter on would depend
    // on which field the API happens to emit that week.
    const [m] = normalizeCatalog([{ id: "x/y", provider: "newkey", owned_by: "oldkey", category: "video" }]);
    expect(m?.provider).toBe("newkey");
  });

  it("never treats the display name as identity", () => {
    // "Moonshot AI" is for humans; "moonshotai" is the key. If display ever
    // leaked into `provider`, filtering would break the moment marketing
    // renamed a vendor.
    const models = normalizeCatalog(PROVIDER_SHAPE);
    for (const m of models) {
      expect(m.provider).not.toMatch(/\s/); // keys have no spaces
      expect(m.id.startsWith(`${m.provider}/`)).toBe(true);
    }
  });

  it("carries no provider_display when the API omits it, rather than inventing one", () => {
    const [m] = normalizeCatalog([{ id: "google/veo-3.1-fast", owned_by: "google", category: "video" }]);
    expect(m?.provider_display).toBeUndefined();
  });
});

describe("catalog: current shape (no category, modalities present)", () => {
  it("derives the category from output_modalities", () => {
    // Regression: normalizeCatalog required an explicit `category`, which the API
    // has never emitted — so every model was dropped, the 'catalog' path silently
    // returned zero, and the server quietly fell back to the docs parser.
    const models = normalizeCatalog(CURRENT_SHAPE);
    expect(models.length).toBeGreaterThan(0);
    expect(byId(models)).toMatchObject({
      "elevenlabs/audio-isolation": "audio",
      "google/veo-3.1-fast": "video",
      "google/nano-banana-2": "image",
    });
  });

  it("excludes text-output models (llm / stt) from the generation catalog", () => {
    // text output => llm, which no generation tool can drive.
    expect(byId(normalizeCatalog(CURRENT_SHAPE))["openai/gpt-5"]).toBeUndefined();
  });

  it("mirrors the API's own precedence when several modalities are present", () => {
    // API _row_kind(): video > image > audio > text. Must match, or a model lands
    // in a different bucket on each side.
    const both = [{ id: "x/omni", owned_by: "x", output_modalities: ["audio", "video"] }];
    expect(normalizeCatalog(both)[0]?.category).toBe("video");
  });
});

describe("catalog: new shape (explicit category, no modalities)", () => {
  it("uses the explicit category", () => {
    const models = normalizeCatalog(NEW_SHAPE);
    expect(byId(models)).toMatchObject({
      "elevenlabs/audio-isolation": "audio",
      "google/veo-3.1-fast": "video",
      "google/nano-banana-2": "image",
    });
  });

  it("drops category 'llm' — not usable by the generation tools", () => {
    expect(byId(normalizeCatalog(NEW_SHAPE))["openai/gpt-5"]).toBeUndefined();
  });

  it("survives the modality arrays disappearing", () => {
    const models = normalizeCatalog(NEW_SHAPE);
    expect(models.every((m) => m.input_modalities === undefined)).toBe(true);
    expect(models.length).toBe(3);
  });
});

describe("list_tasks category filter", () => {
  // v1 is dropping 'text' from VALID_TASK_CATEGORIES, leaving llm|video|image|audio.
  // Validate here so a wrong value is a self-healing message rather than a bare
  // 400 a round-trip later.
  it("rejects 'text' and names the valid set plus the recovery path", async () => {
    const { registerListTasks } = await import("../src/tools/listTasks.js");
    const captured: { schema?: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } } } = {};
    registerListTasks({
      registerTool: (_n: string, cfg: { inputSchema: typeof captured.schema }) => {
        captured.schema = cfg.inputSchema;
      },
    } as never);
    const r = captured.schema!.safeParse({ category: "text" });
    expect(r.success).toBe(false);
    const msg = r.error!.issues[0]!.message;
    expect(msg).toContain("llm, video, image, audio");
    expect(msg).toContain("text"); // echoes what was sent
    expect(msg.toLowerCase()).toContain("transcription"); // tells the agent what to do instead
  });

  it("accepts the four live categories, alone and combined", async () => {
    const { registerListTasks } = await import("../src/tools/listTasks.js");
    const captured: { schema?: { safeParse: (v: unknown) => { success: boolean } } } = {};
    registerListTasks({
      registerTool: (_n: string, cfg: { inputSchema: typeof captured.schema }) => {
        captured.schema = cfg.inputSchema;
      },
    } as never);
    for (const v of ["llm", "video", "image", "audio", "video,image", "VIDEO, Audio"]) {
      expect(captured.schema!.safeParse({ category: v }).success, v).toBe(true);
    }
    for (const v of ["text", "video,text", "bogus", "upscale"]) {
      expect(captured.schema!.safeParse({ category: v }).success, v).toBe(false);
    }
    expect(captured.schema!.safeParse({}).success).toBe(true); // still optional
  });
});

describe("catalog: both shapes agree", () => {
  it("categorizes the same models identically either way", () => {
    expect(byId(normalizeCatalog(CURRENT_SHAPE))).toEqual(byId(normalizeCatalog(NEW_SHAPE)));
  });

  it("prefers an explicit category over the modality inference", () => {
    // During rollout a payload may carry both. The explicit field wins.
    const mixed = [{ id: "a/b", owned_by: "a", category: "image", output_modalities: ["video"] }];
    expect(normalizeCatalog(mixed)[0]?.category).toBe("image");
  });

  it("still recognizes upscalers under either shape", () => {
    expect(normalizeCatalog([{ id: "google/veo-3.1-upscale", owned_by: "google", output_modalities: ["video"] }])[0]?.category).toBe("upscale");
    expect(normalizeCatalog([{ id: "google/veo-3.1-upscale", owned_by: "google", category: "video" }])[0]?.category).toBe("upscale");
  });
});
