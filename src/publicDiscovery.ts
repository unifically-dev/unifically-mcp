/**
 * Which MCP methods an UNAUTHENTICATED caller may reach.
 *
 * Directories, registry scanners, and clients need to SEE the tool surface
 * before anyone has pasted a key. A server that 401s `tools/list` gets listed
 * with zero tools, and an agent whose client forgot the key cannot even tell
 * the user what it would have been able to do. So discovery is public and USE
 * is not: listing is free, calling costs money and needs a credential.
 *
 * Nothing in this set touches the UnificAlly API, spends anything, or reveals
 * more than the static card already served at
 * /.well-known/mcp/server-card.json — it is the same information over the live
 * protocol instead of a hand-maintained JSON file.
 *
 * Everything else stays behind the key. That explicitly includes
 * `resources/read`: unifically://models fetches the live catalog with the
 * caller's own credential, so it is a keyed read, not a listing.
 *
 * This is an ALLOWLIST and the classifier below fails closed — an unknown
 * method, a malformed message, a JSON-RPC response, or anything that is not a
 * plain object is not discovery. A method added to the protocol later is
 * private until someone deliberately adds it here.
 */
export const PUBLIC_DISCOVERY_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);

function isDiscoveryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const method = (message as Record<string, unknown>).method;
  return typeof method === "string" && PUBLIC_DISCOVERY_METHODS.has(method);
}

/**
 * True when EVERY message in this JSON-RPC body is a public discovery call.
 *
 * One privileged message makes the whole batch privileged: an anonymous batch
 * must not be able to smuggle a `tools/call` in behind a `tools/list`, because
 * the transport would execute both.
 */
export function isPublicDiscoveryBody(body: unknown): boolean {
  if (Array.isArray(body)) return body.length > 0 && body.every(isDiscoveryMessage);
  return isDiscoveryMessage(body);
}
