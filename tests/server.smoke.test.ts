import { afterEach, describe, expect, it, beforeAll } from "vitest";

import { resolveModel } from "../src/aliases.js";
import { getConfig, modelBlockedReason, resetConfigForTests } from "../src/config.js";
import { assertSafeRemoteUrl } from "../src/urlSafety.js";
import { annotateProviderCredit, mapErrorToTextMessage, UnificallyError } from "../src/errors.js";
import { normalizeCatalog } from "../src/models.js";
import { resolveApiKey } from "../src/unifically.js";
import { createServer, serverCard, TOOL_NAMES, SERVER_VERSION } from "../src/server.js";
import pkg from "../package.json" with { type: "json" };
import manifest from "../server.json" with { type: "json" };

beforeAll(() => {
  process.env.UNIFICALLY_API_KEY = process.env.UNIFICALLY_API_KEY ?? "sk-test";
});

describe("version", () => {
  it("SERVER_VERSION matches package.json", () => {
    // Two independent copies of the same fact. package.json is what npm
    // publishes and what an installed version reports; SERVER_VERSION is what
    // the MCP handshake, /.well-known/mcp/server-card.json and --version all
    // report. Let them drift and the registry advertises one version while the
    // running server claims another — with no way to tell which is deployed.
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it("SERVER_VERSION matches server.json (the registry manifest)", () => {
    // The third copy. server.json is what the official registry publishes and
    // what aggregators sync; it sat at 1.17.0 while the code said 1.0.0.
    expect(SERVER_VERSION).toBe(manifest.version);
    expect(SERVER_VERSION).toBe(manifest.packages[0].version);
  });
});

describe("listing metadata", () => {
  it("the server card carries the copy a registry renders", () => {
    // Smithery listed this server with an empty overview because the card had
    // no description at all — the tool list alone is not a listing.
    const card = serverCard() as Record<string, any>;
    expect(card.description).toBe(manifest.description);
    expect(card.title).toBeTruthy();
    expect(card.websiteUrl).toBe(manifest.websiteUrl);
  });

  it("states that discovery is public but using a tool is not", () => {
    // A scanner must not read "tools/list answered without a key" as "no auth".
    const card = serverCard() as Record<string, any>;
    expect(card.authentication.required).toBe(true);
    expect(card.authentication.publicMethods).toContain("tools/list");
    expect(card.authentication.publicMethods).not.toContain("tools/call");
    expect(card.configSchema.required).toEqual(["api_key"]);
  });
});

const EXPECTED_TOOLS = [
  "generate_video",
  "generate_image",
  "generate_audio",
  "generate_music",
  "edit_video",
  "upscale_media",
  "extend_video",
  "upload_file",
  "get_task",
  "list_tasks",
  "list_resources",
  "list_models",
  "dry_run_cost",
  "check_balance",
];

describe("createServer", () => {
  it("registers all expected tools", () => {
    const server = createServer();
    const lowLevel = (server as unknown as { server: { _requestHandlers: Map<string, unknown> } }).server;
    expect(lowLevel).toBeDefined();
    expect(TOOL_NAMES).toHaveLength(EXPECTED_TOOLS.length);
    expect(new Set(TOOL_NAMES).size).toBe(EXPECTED_TOOLS.length);
  });

  it("exposes the documented tool names", () => {
    expect([...TOOL_NAMES].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });
});

describe("resolveModel", () => {
  it("resolves aliases case-insensitively", () => {
    expect(resolveModel("veo", "fallback")).toBe("google/veo-3.1-fast");
    expect(resolveModel("Suno", "fallback")).toBe("suno-ai/music");
  });

  it("passes full ids through unchanged", () => {
    expect(resolveModel("openai/gpt-image-2", "fallback")).toBe("openai/gpt-image-2");
  });

  it("falls back when model is omitted", () => {
    expect(resolveModel(undefined, "google/nano-banana-pro")).toBe("google/nano-banana-pro");
    expect(resolveModel("", "google/nano-banana-pro")).toBe("google/nano-banana-pro");
  });
});

describe("mapErrorToTextMessage", () => {
  it("maps the backend's bogus 'polling URL' 500 to task-not-found", () => {
    const msg = mapErrorToTextMessage(
      new UnificallyError(500, "Polling URL is not configured for this model. Please contact support with request id abc."),
    );
    expect(msg).toContain("No task found");
    expect(msg).not.toContain("Retry");
  });

  it("keeps real 500s as retriable server errors", () => {
    const msg = mapErrorToTextMessage(new UnificallyError(500, "internal error"));
    expect(msg).toContain("Retry shortly");
  });
});

describe("operator guardrails (config)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetConfigForTests();
  });

  it("parses the hard cap and rejects invalid values", () => {
    process.env.UNIFICALLY_MAX_COST_PER_TASK = "2.5";
    resetConfigForTests();
    expect(getConfig().maxCostPerTask).toBe(2.5);

    process.env.UNIFICALLY_MAX_COST_PER_TASK = "off";
    resetConfigForTests();
    expect(getConfig().maxCostPerTask).toBeNull();

    process.env.UNIFICALLY_MAX_COST_PER_TASK = "-1";
    resetConfigForTests();
    expect(() => getConfig()).toThrow();
  });

  it("blocklist gates by resolved id, accepting aliases", () => {
    process.env.UNIFICALLY_BLOCKED_MODELS = "veo, suno";
    resetConfigForTests();
    // 'veo' resolves to google/veo-3.1-fast; both the alias target and a
    // caller passing the full id are gated.
    expect(modelBlockedReason("google/veo-3.1-fast")).toContain("disabled");
    expect(modelBlockedReason("suno-ai/music")).toContain("disabled");
    expect(modelBlockedReason("google/nano-banana-pro")).toBeNull();
  });

  it("allowlist permits only listed models", () => {
    process.env.UNIFICALLY_ALLOWED_MODELS = "flux";
    resetConfigForTests();
    expect(modelBlockedReason("black-forest-labs/flux.2-pro")).toBeNull();
    expect(modelBlockedReason("google/veo-3.1-fast")).toContain("not permitted");
  });

  it("read-only flag is parsed", () => {
    process.env.UNIFICALLY_DISABLE_GENERATION = "true";
    resetConfigForTests();
    expect(getConfig().disableGeneration).toBe(true);
  });

  it("never falls back to a shared environment key over HTTP", () => {
    process.env.MCP_TRANSPORT = "http";
    process.env.UNIFICALLY_API_KEY = "host-secret-must-not-be-spent";
    resetConfigForTests();
    expect(resolveApiKey({})).toBe("");
    expect(resolveApiKey({ apiKey: "caller's-own-key" })).toBe("caller's-own-key");
  });
});

describe("SSRF url safety (assertSafeRemoteUrl)", () => {
  it("blocks non-web schemes, credentials, and private/loopback/link-local hosts", () => {
    const blocked = [
      "http://169.254.169.254/latest/meta-data/", // AWS/Azure IMDS
      "http://2130706433/", // decimal 127.0.0.1
      "http://0x7f000001/", // hex 127.0.0.1
      "http://0177.0.0.1/", // octal 127.0.0.1
      "http://127.0.0.1:6379/", // loopback (redis)
      "http://localhost/",
      "http://[::1]/", // IPv6 loopback
      "http://[fe80::1]/", // IPv6 link-local
      "http://[fe90::1]/", // IPv6 link-local (fe80::/10 upper range)
      "http://[febf::1]/", // IPv6 link-local (fe80::/10 top)
      "http://[::ffff:169.254.169.254]/", // IPv4-mapped IMDS
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://metadata.google.internal/computeMetadata/v1/", // GCP IMDS
      "file:///etc/passwd",
      "gopher://127.0.0.1:11211/_",
      "http://user:pass@evil.com/",
    ];
    for (const u of blocked) {
      expect(() => assertSafeRemoteUrl(u), u).toThrow();
    }
  });

  it("allows public http(s) URLs and preserves signed URLs byte-for-byte", () => {
    expect(assertSafeRemoteUrl("https://cdn.example.com/a.jpg")).toBe("https://cdn.example.com/a.jpg");
    expect(assertSafeRemoteUrl("http://files.unifically.com/x.png")).toBe("http://files.unifically.com/x.png");
    const signed = "https://s3.amazonaws.com/b/k?X-Amz-Signature=abc%2Fdef";
    expect(assertSafeRemoteUrl(signed)).toBe(signed); // no re-encoding
    expect(assertSafeRemoteUrl("https://8.8.8.8/x.png")).toBe("https://8.8.8.8/x.png"); // public IP ok
  });
});

describe("annotateProviderCredit", () => {
  it("flags provider credit/quota wording as not-a-balance-issue", () => {
    const msg = annotateProviderCredit("Insufficient credits. Please try again later.");
    expect(msg).toContain("NOT your UnificAlly balance");
  });
  it("leaves unrelated failure messages untouched", () => {
    expect(annotateProviderCredit("Prompt too long")).toBe("Prompt too long");
  });
});

describe("normalizeCatalog", () => {
  const sample = [
    { key: "veo-3.1-fast", name: "Veo 3.1 Fast", provider: "google", category: "video" },
    { key: "nano-banana-pro", name: "Nano Banana Pro", provider: "google", category: "image" },
    { key: "image-upscale", name: "Topaz Image Upscale", provider: "topaz-labs", category: "image" },
    { key: "music", name: "Suno Music", provider: "suno-ai", category: "audio" },
    { key: "gpt-5.5", name: "GPT-5.5", provider: "openai", category: "llm" },
  ];

  it("builds provider/key ids and maps categories", () => {
    const models = normalizeCatalog(sample);
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["google/veo-3.1-fast"]?.category).toBe("video");
    expect(byId["google/veo-3.1-fast"]?.description).toBe("Veo 3.1 Fast");
    expect(byId["google/nano-banana-pro"]?.category).toBe("image");
    // Upscale is inferred from the id regardless of the source category.
    expect(byId["topaz-labs/image-upscale"]?.category).toBe("upscale");
    expect(byId["suno-ai/music"]?.category).toBe("audio");
    // llm models are dropped — the generation tools can't use them.
    expect(byId["openai/gpt-5.5"]).toBeUndefined();
  });

  it("accepts the array nested under a wrapper key and keys that already include a slash", () => {
    const models = normalizeCatalog({ models: [{ key: "kuaishou/kling-3.0-video", name: "Kling", provider: "kuaishou", category: "video" }] });
    expect(models[0]?.id).toBe("kuaishou/kling-3.0-video");
  });
});
