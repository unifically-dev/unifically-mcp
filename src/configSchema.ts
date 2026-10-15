/**
 * What a caller must supply to actually USE this server.
 *
 * Now that discovery is public (publicDiscovery.ts), a scanner or client can
 * read the whole tool list without a credential — and the failure mode of that
 * is a listing that looks like it needs no setup. Smithery says as much:
 * "No config schema provided. If your server requires configuration (API keys,
 * credentials, etc.), users will not be prompted for these values." A user who
 * is never prompted connects successfully, sees 14 tools, calls one, and gets a
 * 401 they had no way to anticipate.
 *
 * So the same server that gives the tool list away for free also publishes,
 * machine-readably, the one thing it will not work without.
 *
 * The property is named `api_key` on purpose: a gateway that simply forwards
 * config as query parameters produces `?api_key=<value>`, which extractApiKey()
 * already accepts. `x-to` asks a gateway that understands it to send a header
 * instead — which is preferable, since query strings reach proxy logs. Either
 * path lands on a supported credential, so neither behavior leaves the user
 * stuck.
 */
export const CONFIG_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "UnificAlly",
  description:
    "Listing this server's tools needs no credential. Running one spends money, so it needs your API key.",
  type: "object",
  required: ["api_key"],
  additionalProperties: false,
  properties: {
    api_key: {
      type: "string",
      title: "UnificAlly API key",
      description:
        "Get one at https://unifically.com/api-keys. Every generation, upscale, and transcription is billed to this key's account.",
      format: "password",
      writeOnly: true,
      minLength: 1,
      "x-to": { header: "X-API-Key" },
    },
  },
};
