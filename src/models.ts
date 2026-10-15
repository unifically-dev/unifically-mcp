import { getModelCatalog, readResponseTextLimited } from "./unifically.js";
import { getRequestSignal } from "./config.js";

export type ModelCategory = "video" | "image" | "audio" | "upscale";
export type CatalogSource = "catalog" | "live" | "fallback";

export interface ModelEntry {
  id: string;
  description: string;
  category: ModelCategory;
  /**
   * Stable machine key for the vendor ("moonshotai"), as emitted by the catalog.
   * Read from the payload rather than split off the id: those agree today, but
   * the id's prefix is a routing path and the provider is an identity — nothing
   * guarantees they stay the same string, and this is what filtering keys on.
   */
  provider?: string;
  /** Human-facing vendor name ("Moonshot AI"). Display only — never match on it. */
  provider_display?: string;
  /** e.g. ["text","image"] — what the model accepts (from the live catalog). */
  input_modalities?: string[];
  /** e.g. ["video"] — what the model produces. */
  output_modalities?: string[];
}

const LLMS_FULL_URL = "https://docs.unifically.com/llms-full.txt";
const CACHE_TTL_MS = 60 * 60 * 1000;
// A fallback result usually means a transient cold-start failure — retry soon
// rather than serving the static list as truth for a full hour.
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

const STATIC_FALLBACK: ModelEntry[] = [
  { id: "google/veo-3.1-fast", description: "Google Veo 3.1 Fast", category: "video" },
  { id: "google/veo-3.1-quality", description: "Google Veo 3.1 Quality", category: "video" },
  { id: "google/veo-3.1-lite", description: "Google Veo 3.1 Lite", category: "video" },
  { id: "google/veo-3.1-lite-relaxed", description: "Google Veo 3.1 Lite Relaxed", category: "video" },
  { id: "google/veo-3.1-extend", description: "Google Veo 3.1 Extend", category: "video" },
  { id: "google/veo-3.1-upscale", description: "Google Veo 3.1 Upscale (Veo generations only)", category: "upscale" },
  { id: "hailuo/minimax-2.0", description: "Minimax Hailuo 2.0", category: "video" },
  { id: "hailuo/minimax-2.3", description: "Minimax Hailuo 2.3", category: "video" },
  { id: "hailuo/minimax-2.3-fast", description: "Minimax Hailuo 2.3 Fast", category: "video" },
  { id: "kuaishou/kling-3.0-omni-video", description: "Kling v3.0 Omni Video", category: "video" },
  { id: "kuaishou/kling-3.0-video", description: "Kling v3.0 Video", category: "video" },
  { id: "kuaishou/kling-2.6-video", description: "Kling v2.6 Video", category: "video" },
  { id: "kuaishou/kling-2.5-turbo-video", description: "Kling v2.5 Turbo Video", category: "video" },
  { id: "kuaishou/kling-2.1-video", description: "Kling v2.1 Video", category: "video" },
  { id: "bytedance/seedance-2.0-pro", description: "ByteDance Seedance 2.0 Pro", category: "video" },
  { id: "xai/grok-imagine-video", description: "Grok Imagine Video (speed-optimized 1.5; text-to-video + references)", category: "video" },
  { id: "xai/grok-imagine-1.5-video", description: "Grok Imagine Video 1.5 (official; image-to-video only)", category: "video" },
  { id: "xai/grok-imagine-video-extend", description: "Grok Imagine Video Extend", category: "video" },
  { id: "xai/grok-imagine-upscale", description: "Grok Imagine Upscale (Grok generations only)", category: "upscale" },
  { id: "google/nano-banana", description: "Nano Banana", category: "image" },
  { id: "google/nano-banana-pro", description: "Nano Banana Pro", category: "image" },
  { id: "google/nano-banana-2", description: "Nano Banana 2", category: "image" },
  { id: "google/nano-banana-2-lite", description: "Nano Banana 2 Lite (1K only)", category: "image" },
  { id: "bytedance/seedream-4.5", description: "SeeDream 4.5", category: "image" },
  { id: "openai/gpt-image-2", description: "GPT Image 2", category: "image" },
  { id: "black-forest-labs/flux.2-pro", description: "Flux.2 Pro", category: "image" },
  { id: "black-forest-labs/flux.2-flex", description: "Flux.2 Flex", category: "image" },
  { id: "black-forest-labs/flux.2-max", description: "Flux.2 Max", category: "image" },
  { id: "kuaishou/kling-3.0-image", description: "Kling v3.0 Image", category: "image" },
  { id: "alibaba/qwen-image-2.0-pro", description: "Qwen Image 2.0 Pro", category: "image" },
  { id: "alibaba/wan-2.7-pro-image", description: "Wan 2.7 Pro Image", category: "image" },
  { id: "xai/grok-imagine-image", description: "Grok Imagine Image", category: "image" },
  { id: "suno-ai/music", description: "Suno Music Generation", category: "audio" },
  { id: "elevenlabs/text-to-speech", description: "ElevenLabs Text-to-Speech", category: "audio" },
  { id: "elevenlabs/text-to-dialogue", description: "ElevenLabs Multi-Voice Dialogue", category: "audio" },
  { id: "elevenlabs/sound-effect", description: "ElevenLabs Sound Effects", category: "audio" },
  { id: "elevenlabs/speech-to-text", description: "ElevenLabs Speech-to-Text (transcription)", category: "audio" },
  { id: "topaz-labs/image-upscale", description: "Topaz Image Upscale", category: "upscale" },
  { id: "topaz-labs/image-generative", description: "Topaz Generative Image Upscale", category: "upscale" },
  { id: "topaz-labs/video-upscale", description: "Topaz Video Upscale", category: "upscale" },
];

interface CacheEntry {
  fetchedAt: number;
  models: ModelEntry[];
  source: CatalogSource;
}

let cache: CacheEntry | undefined;

/** Build the full "provider/key" model id, tolerating keys that already include it. */
function toModelId(key: string, provider: string): string {
  if (key.includes("/")) return key;
  return provider ? `${provider}/${key}` : key;
}

function mapCatalogCategory(raw: string, id: string): ModelCategory | undefined {
  const c = raw.toLowerCase();
  if (c === "video") return inferUpscale(id, "video");
  if (c === "image") return inferUpscale(id, "image");
  if (c === "audio") return "audio";
  // "llm" and anything unknown are not usable by the generation tools.
  return undefined;
}

/**
 * Resolve a catalog entry's category, tolerating BOTH /v1/models shapes so the
 * MCP and the API can deploy in either order:
 *
 *   - new shape: an explicit `category` of llm|video|image|audio.
 *   - current shape: no `category` at all — the kind is inferred from
 *     `output_modalities`, which is what the API's own docs tell clients to do
 *     ("clients infer the kind from output_modalities; text output => llm").
 *
 * The inference order mirrors the API's _row_kind() exactly, so a model that
 * outputs both audio and video lands in the same bucket on both sides.
 *
 * This also fixes a live bug: with no `category` emitted, EVERY model failed to
 * map and the "preferred" catalog path silently returned zero, quietly demoting
 * the server to the docs parser on every cold start.
 */
function resolveCategory(m: Record<string, unknown>, id: string): ModelCategory | undefined {
  const explicit = String(m.category ?? "").trim();
  if (explicit) return mapCatalogCategory(explicit, id);

  const out = Array.isArray(m.output_modalities) ? m.output_modalities.map((x) => String(x).toLowerCase()) : [];
  if (out.includes("video")) return inferUpscale(id, "video");
  if (out.includes("image")) return inferUpscale(id, "image");
  if (out.includes("audio")) return "audio";
  // text output => llm (or an stt helper). Neither is usable by the generation
  // tools, so both are excluded from this catalog — same as an explicit "llm".
  return undefined;
}

export function normalizeCatalog(payload: unknown): ModelEntry[] {
  const arr: unknown[] = Array.isArray(payload)
    ? payload
    : (() => {
        const obj = payload as Record<string, unknown> | null;
        for (const k of ["models", "catalog", "data", "items"]) {
          const v = obj?.[k];
          if (Array.isArray(v)) return v as unknown[];
        }
        return [];
      })();

  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    // Current /v1/models shape has a full `id`; the legacy shape had key+provider.
    const directId = String(m.id ?? "").trim();
    const key = String(m.key ?? "").trim();
    if (!directId && !key) continue;
    // Provider naming, newest shape first. The catalog is migrating to an
    // explicit pair — `provider` is the stable key that never changes
    // ("moonshotai"), `provider_display` is the human name ("Moonshot AI") —
    // while `owned_by` is what it emits today. Accept all of them: the same
    // dual-shape tolerance is why the `category` migration landed without
    // emptying this catalog, and reading only the current field is precisely
    // what breaks on the deploy.
    const provider = String(m.provider ?? m.owned_by ?? "").trim();
    const providerDisplay = String(m.provider_display ?? "").trim();
    const id = directId || toModelId(key, provider);
    // `display_name` is the live field; `name` was the legacy one. Reading only
    // `name` made EVERY description fall back to the id, so list_models printed
    // the id twice and told the caller nothing about the model.
    const name = String(m.display_name ?? m.name ?? "").trim() || id;
    const category = resolveCategory(m, id);
    if (!category) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const inputMods = Array.isArray(m.input_modalities) ? m.input_modalities.map(String) : undefined;
    const outputMods = Array.isArray(m.output_modalities) ? m.output_modalities.map(String) : undefined;
    models.push({
      id,
      description: name,
      category,
      ...(provider ? { provider } : {}),
      ...(providerDisplay ? { provider_display: providerDisplay } : {}),
      ...(inputMods ? { input_modalities: inputMods } : {}),
      ...(outputMods ? { output_modalities: outputMods } : {}),
    });
  }
  return models;
}

function categoryFromHeading(heading: string): ModelCategory | undefined {
  const h = heading.toLowerCase();
  if (h.includes("video")) return "video";
  if (h.includes("image")) return "image";
  if (h.includes("audio")) return "audio";
  return undefined;
}

function inferUpscale(id: string, currentCategory: ModelCategory): ModelCategory {
  if (id.includes("upscale") || id === "topaz-labs/image-generative") return "upscale";
  return currentCategory;
}

export function parseLlmsFull(text: string): ModelEntry[] {
  const lines = text.split(/\r?\n/);
  let inAvailable = false;
  let category: ModelCategory | undefined;
  const models: ModelEntry[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (/^##\s+Available Models\b/i.test(line)) {
      inAvailable = true;
      continue;
    }
    if (!inAvailable) continue;
    if (/^##\s+/.test(line) && !/^##\s+Available Models\b/i.test(line)) break;

    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      category = categoryFromHeading(heading[1] ?? "");
      continue;
    }

    if (!category) continue;

    const row = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!row) continue;
    const id = row[1]?.trim();
    const description = row[2]?.trim();
    if (!id || !description) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, description, category: inferUpscale(id, category) });
  }

  return models;
}

async function fetchFromLlmsFull(): Promise<ModelEntry[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const callerSignal = getRequestSignal();
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    const res = await fetch(LLMS_FULL_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseLlmsFull(await readResponseTextLimited(res, 1024 * 1024));
    if (parsed.length === 0) throw new Error("parser returned 0 models");
    return parsed;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

export async function fetchModels(force = false): Promise<{ models: ModelEntry[]; source: CatalogSource }> {
  const ttl = cache?.source === "fallback" ? FALLBACK_CACHE_TTL_MS : CACHE_TTL_MS;
  if (!force && cache && Date.now() - cache.fetchedAt < ttl) {
    return { models: cache.models, source: cache.source };
  }

  // 1. Preferred: the structured live catalog endpoint (needs an API key,
  //    resolved from the request context or env by the API client).
  try {
    const models = normalizeCatalog(await getModelCatalog());
    if (models.length > 0) {
      cache = { fetchedAt: Date.now(), models, source: "catalog" };
      return { models, source: "catalog" };
    }
  } catch {
    // endpoint unavailable / unauthenticated — fall through.
  }

  // 2. Fallback: parse the public llms-full.txt docs (no auth required).
  try {
    const models = await fetchFromLlmsFull();
    cache = { fetchedAt: Date.now(), models, source: "live" };
    return { models, source: "live" };
  } catch {
    // 3. Last resort: the built-in static list.
    cache = { fetchedAt: Date.now(), models: STATIC_FALLBACK, source: "fallback" };
    return { models: STATIC_FALLBACK, source: "fallback" };
  }
}

export async function listModels(
  category?: ModelCategory,
  opts: { force?: boolean } = {},
): Promise<{ models: ModelEntry[]; source: CatalogSource }> {
  const { models, source } = await fetchModels(opts.force ?? false);
  return { models: category ? models.filter((m) => m.category === category) : models, source };
}
