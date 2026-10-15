import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { aliasTable } from "../aliases.js";
import { listModels, type ModelCategory } from "../models.js";
import type { ToolResult } from "./_helpers.js";

const inputShape = {
  category: z
    .enum(["video", "image", "audio", "upscale"])
    .optional()
    .describe("Filter by category. Omit to return everything."),
  provider: z
    .string()
    .optional()
    .describe(
      "Filter by provider. Takes the stable key ('google', 'black-forest-labs', 'moonshotai') or the human name the user is likely to say ('Black Forest Labs', 'Moonshot AI'). Case-insensitive. Combinable with category.",
    ),
  refresh: z
    .boolean()
    .optional()
    .describe("Set true to bypass the hourly cache and re-fetch the live catalog now."),
};

const inputSchema = z.object(inputShape).strict();

export function registerListModels(server: McpServer): void {
  server.registerTool(
    "list_models",
    {
      title: "List models",
      description:
        "List the model catalog (video, image, audio, upscale) with the short aliases you can pass as 'model'. " +
        "Filter by category and/or provider (e.g. provider: 'google'). " +
        "Use the returned ids or aliases on the generation tools. Refreshed hourly from the live catalog.",
      inputSchema: inputSchema,
      annotations: {
        title: "List models",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawArgs): Promise<ToolResult> => {
      const args = inputSchema.parse(rawArgs);
      const { models: allInCategory, source } = await listModels(args.category as ModelCategory | undefined, {
        force: args.refresh,
      });

      // Provider filter, case-insensitive, trailing slash tolerated
      // ("google/" == "google"). Matches the stable provider KEY, the id's
      // provider segment, or the human display name — an agent relaying what a
      // user said ("Moonshot AI") should not get an empty list when the key is
      // "moonshotai". Display is accepted as INPUT only; identity is the key.
      const provider = args.provider?.trim().toLowerCase().replace(/\/+$/, "");
      const providerKeyOf = (m: { id: string; provider?: string }) => (m.provider ?? m.id.split("/")[0] ?? "").toLowerCase();
      const models = provider
        ? allInCategory.filter(
            (m) =>
              providerKeyOf(m) === provider ||
              m.id.split("/")[0]?.toLowerCase() === provider ||
              m.provider_display?.toLowerCase() === provider,
          )
        : allInCategory;

      if (provider && models.length === 0) {
        // List what to pass next: the key, plus the human name when the catalog
        // gives one and it differs, so a caller who only knows "Black Forest
        // Labs" can see it maps to 'black-forest-labs'.
        const labels = new Map<string, string>();
        for (const m of allInCategory) {
          const key = providerKeyOf(m);
          const display = m.provider_display;
          labels.set(key, display && display.toLowerCase() !== key ? `${key} (${display})` : key);
        }
        const available = [...labels.values()].sort().join(", ");
        return {
          content: [
            {
              type: "text",
              text: `No models for provider '${args.provider}'${args.category ? ` in category '${args.category}'` : ""}. Available providers${args.category ? " in that category" : ""}: ${available}.`,
            },
          ],
          structuredContent: { count: 0, source, models: [] },
        };
      }

      // Reverse the alias map so each model can advertise its shortcuts.
      const aliases = aliasTable();
      const aliasesFor = new Map<string, string[]>();
      for (const [alias, target] of Object.entries(aliases)) {
        const list = aliasesFor.get(target) ?? [];
        list.push(alias);
        aliasesFor.set(target, list);
      }

      const lines = models.map((m) => {
        const shortcuts = aliasesFor.get(m.id);
        const aliasPart = shortcuts?.length ? ` [aliases: ${shortcuts.join(", ")}]` : "";
        const mods = m.input_modalities?.length
          ? ` [${m.input_modalities.join("+")} → ${m.output_modalities?.join("+") ?? m.category}]`
          : "";
        return `- ${m.id} (${m.category}): ${m.description}${mods}${aliasPart}`;
      });
      // Echo the catalog's own display name ("Black Forest Labs"), not the
      // lowercased string the caller typed — the filter is case-insensitive, so
      // reflecting the input back rendered "from black forest labs".
      const matchedDisplay = models[0]?.provider_display ?? models[0]?.provider;
      const providerPart = provider ? ` from ${matchedDisplay ?? provider}` : "";
      const heading = args.category
        ? `${models.length} ${args.category} model(s)${providerPart}:`
        : provider
          ? `${models.length} model(s)${providerPart}:`
          : `${models.length} models across video, image, audio, upscale:`;
      const staleNote =
        source === "fallback"
          ? "NOTE: the live catalog was unreachable — this is the built-in fallback list and may be incomplete or stale. Pass refresh: true to retry the live catalog.\n"
          : "";

      return {
        content: [{ type: "text", text: `${staleNote}${heading}\n${lines.join("\n")}` }],
        structuredContent: {
          count: models.length,
          source,
          models: models.map((m) => ({ ...m, aliases: aliasesFor.get(m.id) ?? [] })),
        },
      };
    },
  );
}
