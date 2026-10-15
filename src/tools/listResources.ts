import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toolError } from "../errors.js";
import { getProviderResource, listVoices, type Voice } from "../unifically.js";
import type { ToolResult } from "./_helpers.js";
import { fenceUntrusted, sanitizeUntrusted } from "../untrusted.js";

// UnificAlly's provider-resource catalog (GET /v1/resources/*). The endpoint
// paths are irregular, so map a friendly key -> exact path + shape rather than
// templating {provider}/{type}. Adding a new resource is a one-line entry here.
// Only genuinely LISTABLE resources belong here — catalogs you pick an id from.
// (The Suno voice-verification phrase is a per-call helper, not a list, and no
// tool consumes its phrase_id, so it is intentionally not exposed here.)
type ResourceKey = "elevenlabs-voices" | "kling-voices" | "veo-voices";

const RESOURCE_ALIASES: Record<string, ResourceKey> = {
  // ElevenLabs voices — the default, used for generate_audio (tts/dialogue/voice-changer).
  voices: "elevenlabs-voices",
  "elevenlabs-voices": "elevenlabs-voices",
  elevenlabs: "elevenlabs-voices",
  tts: "elevenlabs-voices",
  // Kling video voices.
  "kling-voices": "kling-voices",
  kling: "kling-voices",
  kuaishou: "kling-voices",
  // Google Veo voices.
  "veo-voices": "veo-voices",
  veo: "veo-voices",
  google: "veo-voices",
};

const inputShape = {
  resource: z
    .string()
    .optional()
    .describe(
      "Which provider's voice list to return. Default 'elevenlabs-voices'. Options: " +
        "'elevenlabs-voices' (ElevenLabs TTS/dialogue/voice-changer voices — use the voice_id in generate_audio), " +
        "'kling-voices' (Kling video voices — use the id as voice_id), " +
        "'veo-voices' (Google Veo voices — use the id as 'voice'; requires an image/character reference). " +
        "Aliases 'tts'/'kling'/'veo' work. NOTE: this is UnificAlly's provider-resource catalog, distinct from the MCP protocol's resources/list.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Filter the voice list by name/labels — space-separated words, all must match (e.g. 'british female'). Applies to all voice lists.",
    ),
  category: z
    .enum(["premade", "professional", "cloned", "generated", "all"])
    .optional()
    .describe("ElevenLabs voices only: which set to return. Default 'premade' (~21 stable official voices); 'all' includes the large shared library."),
  limit: z.number().int().positive().max(200).optional().describe("Max items to return. Default 50."),
};

const inputSchema = z.object(inputShape).strict();

const wordsMatch = (haystack: string, words: string[]): boolean => {
  const h = haystack.toLowerCase();
  return words.every((w) => h.includes(w));
};

function queryWords(query: string | undefined): string[] {
  return (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function registerListResources(server: McpServer): void {
  server.registerTool(
    "list_resources",
    {
      title: "List resources",
      description:
        "List a model provider's voices so you can pass the right id to a generation tool. " +
        "Default 'elevenlabs-voices' (the voices for generate_audio); also covers Kling and Google Veo voices. " +
        "Returns each voice's id and name. (This is UnificAlly's resource catalog; it is not the MCP protocol's resources/list.)",
      inputSchema: inputSchema,
      annotations: {
        title: "List resources",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawArgs): Promise<ToolResult> => {
      const args = inputSchema.parse(rawArgs);
      const key = RESOURCE_ALIASES[(args.resource ?? "elevenlabs-voices").trim().toLowerCase()];
      if (!key) {
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text: `Unknown resource '${args.resource}'. Use one of: elevenlabs-voices, kling-voices, veo-voices (aliases: tts, kling, veo).`,
            },
          ],
        };
      }
      const limit = args.limit ?? 50;
      const words = queryWords(args.query);

      try {
        if (key === "elevenlabs-voices") {
          const category = args.category ?? "premade";
          const { voices } = await listVoices();
          const seen = new Set<string>();
          let pool = voices.filter((v: Voice) => {
            if (!v.voice_id || seen.has(v.voice_id)) return false;
            seen.add(v.voice_id);
            return true;
          });
          if (category !== "all") pool = pool.filter((v) => (v.category ?? "premade") === category);
          const preFilter = pool.length;
          if (words.length) {
            pool = pool.filter((v) =>
              wordsMatch([v.name, v.category ?? "", ...Object.values(v.labels ?? {})].join(" "), words),
            );
          }
          const shown = pool.slice(0, limit);
          // Voice names/labels are third-party text — with category:'all' this is
          // the ElevenLabs SHARED library, where anyone can publish a voice named
          // whatever they like. Sanitize before it enters the model's context.
          const lines = shown.map((v) => {
            const labels = v.labels
              ? Object.values(v.labels).filter(Boolean).map((l) => sanitizeUntrusted(l, 60)).join(", ")
              : "";
            return `- ${v.voice_id} — ${sanitizeUntrusted(v.name, 80)}${labels ? ` (${labels})` : ""}`;
          });
          const more = pool.length > shown.length ? ` (showing ${shown.length} of ${pool.length}; narrow with query or raise limit)` : "";
          let body = lines.join("\n");
          if (pool.length === 0) {
            body =
              words.length && preFilter > 0
                ? `(none — the catalog has ${preFilter} voice(s) in category '${category}'; query matches names and accent/age/gender labels. Omit query to list all.)`
                : `(none in category '${category}' — try category: 'all'.)`;
          }
          return ok(
            `${pool.length} ElevenLabs voice(s) in category '${category}'${words.length ? ` matching "${sanitizeUntrusted(args.query, 80)}"` : ""}${more}. Pass a voice_id to generate_audio:\n${fenceUntrusted("voice-catalog", body)}`,
            { resource: key, count: pool.length, category, items: shown, param: "voice_id" },
          );
        }

        // kling-voices or veo-voices — the only remaining keys.
        const path = key === "kling-voices" ? "/v1/resources/kuaishou/kling/voices" : "/v1/resources/google/voices/veo-3.1";
        const raw = await getProviderResource<unknown>(path);
        // Kling returns a bare array [{id,name}]; Veo wraps it as { voices: [...] }
        // (like ElevenLabs). Handle both so neither silently returns nothing.
        const items: Array<Record<string, unknown>> = Array.isArray(raw)
          ? (raw as Array<Record<string, unknown>>)
          : Array.isArray((raw as { voices?: unknown } | null)?.voices)
            ? (raw as { voices: Array<Record<string, unknown>> }).voices
            : [];
        const param = key === "kling-voices" ? "voice_id" : "voice";
        let pool = items;
        if (words.length) {
          pool = items.filter((v) =>
            wordsMatch([String(v.name ?? ""), String(v.description ?? "")].join(" "), words),
          );
        }
        const shown = pool.slice(0, limit);
        const lines = shown.map((v) => {
          const id = sanitizeUntrusted(String(v.id ?? ""), 80);
          const name = v.name ? ` — ${sanitizeUntrusted(v.name, 80)}` : "";
          const desc = v.description ? ` (${sanitizeUntrusted(v.description, 120)})` : "";
          return `- ${id}${name}${desc}`;
        });
        const label = key === "kling-voices" ? "Kling" : "Google Veo";
        const more = pool.length > shown.length ? ` (showing ${shown.length} of ${pool.length})` : "";
        return ok(
          `${pool.length} ${label} voice(s)${words.length ? ` matching "${sanitizeUntrusted(args.query, 80)}"` : ""}${more}. Pass the id as '${param}':\n${fenceUntrusted("voice-catalog", lines.join("\n") || "(none)")}`,
          { resource: key, count: pool.length, items: shown, param },
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
}

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}
