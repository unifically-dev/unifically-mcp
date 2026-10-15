import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";

process.env.UNIFICALLY_API_KEY = process.env.UNIFICALLY_API_KEY ?? "sk-test";

const { createServer, TOOL_NAMES, TOOL_SUMMARIES, serverCard } = await import("../dist/server.js");
const { resolveModel } = await import("../dist/aliases.js");

const expected = [
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

assert.deepEqual([...TOOL_NAMES].sort(), [...expected].sort(), "TOOL_NAMES export must match the documented tools");

// The server card (registry metadata) must cover exactly the registered tools.
const cardToolNames = serverCard().tools.map((t) => t.name).sort();
assert.deepEqual(cardToolNames, [...expected].sort(), "serverCard tools must match TOOL_NAMES — add a TOOL_SUMMARIES entry for new tools");
for (const name of expected) {
  assert.ok(TOOL_SUMMARIES[name] && TOOL_SUMMARIES[name].length > 10, `TOOL_SUMMARIES missing a real summary for ${name}`);
}

const server = createServer();
const client = new Client({ name: "smoke", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

// Server should advertise usage instructions to the model.
const instructions = client.getInstructions?.();
assert.ok(instructions && instructions.length > 50, "server must expose instructions");

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, [...expected].sort(), `Server must list the expected tools, got: ${names.join(", ")}`);

for (const tool of tools) {
  assert.ok(tool.description && tool.description.length > 0, `${tool.name} missing description`);
  assert.ok(tool.inputSchema, `${tool.name} missing inputSchema`);
  assert.ok(!/\$\d/.test(tool.description), `${tool.name} description must not contain hardcoded pricing`);
}

const readOnly = ["get_task", "list_tasks", "dry_run_cost", "list_models", "check_balance", "list_resources"];
for (const name of readOnly) {
  const tool = tools.find((t) => t.name === name);
  assert.equal(tool?.annotations?.readOnlyHint, true, `${name} must be readOnlyHint=true`);
}

const generation = ["generate_video", "generate_image", "generate_audio", "generate_music", "edit_video", "upscale_media", "extend_video"];
for (const name of generation) {
  const tool = tools.find((t) => t.name === name);
  assert.equal(tool?.annotations?.openWorldHint, true, `${name} must be openWorldHint=true`);
  // destructiveHint=true is deliberate and load-bearing — do NOT "fix" this back
  // to false by reading the spec's "destructive UPDATE" wording literally. These
  // tools spend real money on tasks that cannot be canceled once submitted. The
  // annotation's only consumer is the client's auto-approval logic, so what it
  // must communicate here is irreversibility, not whether bytes get overwritten.
  assert.equal(tool?.annotations?.destructiveHint, true, `${name} must be destructiveHint=true (spends money irreversibly)`);
  assert.equal(tool?.annotations?.idempotentHint, false, `${name} must be idempotentHint=false (a retry is a second paid task)`);
  assert.ok(tool?.inputSchema?.properties?.wait, `${name} must expose the wait parameter`);
}

// Alias resolution.
assert.equal(resolveModel("veo", "fallback"), "google/veo-3.1-fast");
assert.equal(resolveModel("FLUX", "fallback"), "black-forest-labs/flux.2-pro");
assert.equal(resolveModel(undefined, "google/nano-banana-pro"), "google/nano-banana-pro");
assert.equal(resolveModel("openai/gpt-image-2", "fallback"), "openai/gpt-image-2", "full ids pass through");

const result = await client.callTool({ name: "list_models", arguments: { category: "video" } });
assert.equal(result.isError, undefined, "list_models should not error");
assert.ok(result.structuredContent, "list_models must return structuredContent");
assert.ok((result.structuredContent.count ?? 0) > 10, "video catalog should list >10 models");

// The models resource should be exposed and readable.
const { resources } = await client.listResources();
assert.ok(resources.some((r) => r.uri === "unifically://models"), "models resource must be registered");
const read = await client.readResource({ uri: "unifically://models" });
assert.ok(read.contents?.[0]?.text?.includes("models"), "models resource must return catalog JSON");

await client.close();
await server.close();

console.log(`OK: ${tools.length} tools, instructions present, aliases resolve, models resource readable, ${result.structuredContent.count} video models.`);
