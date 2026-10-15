/**
 * SSRF defense-in-depth for any URL this server hands to a server-side fetcher:
 * media inputs (the backend downloads them for the models), callback webhooks,
 * and upload-by-URL imports (the CDN fetches the source). Per the OWASP file-
 * upload guidance and SSRF-in-upload research, we:
 *   - allow ONLY http/https schemes (blocks file:, gopher:, dict:, data:, ftp:)
 *   - reject embedded credentials (user:pass@host)
 *   - reject private / loopback / link-local / reserved IP LITERALS, including
 *     the cloud metadata endpoint 169.254.169.254 and its decimal/hex/IPv6
 *     obfuscations
 *
 * What this deliberately does NOT do: resolve DNS names to catch a hostname
 * that points at an internal IP (or a DNS-rebind mid-request). That check must
 * happen at fetch time, against every redirect hop, and belongs to the backend
 * that actually makes the request — doing async DNS in input validation would
 * be both unreliable and a new DoS lever. This layer removes the cheap,
 * literal SSRF vectors; the fetcher owns the rest.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal", // GCP IMDS
]);

/**
 * Normalize a host to IPv4 octets if it is any IPv4 literal form — dotted
 * decimal, a single 32-bit decimal integer (2130706433), or hex (0x7f000001).
 * The WHATWG URL parser already canonicalizes most of these, but we re-derive
 * them so an obfuscated literal can never slip past the range check.
 */
function toIPv4Octets(host: string): number[] | null {
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (dotted) {
    const parts = dotted.slice(1).map(Number);
    return parts.every((n) => n <= 255) ? parts : null;
  }
  let n: number | null = null;
  if (/^\d+$/.test(host)) n = Number(host);
  else if (/^0x[0-9a-f]+$/i.test(host)) n = parseInt(host, 16);
  if (n !== null && Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  return null;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl 169.254.169.254 (IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  // /24, not /16 — 192.0.2.0/24 (TEST-NET) and the rest of 192.0/16 are public.
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved (incl 255.255.255.255)
  return false;
}

/**
 * Decode the IPv4 address embedded in the tail of an IPv6 literal and test it
 * against the v4 blocklist. The WHATWG parser serializes an embedded v4 either
 * as dotted (169.254.169.254) or as two hex groups (a9fe:a9fe), so handle both —
 * otherwise the hex form silently bypasses the check.
 */
function isEmbeddedIPv4Blocked(tail: string): boolean {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) {
    const octets = toIPv4Octets(tail);
    return !!octets && isPrivateIPv4(octets);
  }
  const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (hexPair) {
    const hi = parseInt(hexPair[1]!, 16);
    const lo = parseInt(hexPair[2]!, 16);
    return isPrivateIPv4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255]);
  }
  return false;
}

function isBlockedIPv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (/^fe[89ab][0-9a-f](:|$)/.test(h)) return true; // link-local fe80::/10 (fe80–febf)
  if (/^f[cd][0-9a-f]{2}(:|$)/.test(h)) return true; // unique-local fc00::/7
  if (/^fe[cdef][0-9a-f](:|$)/.test(h)) return true; // deprecated site-local fec0::/10
  // NAT64 (64:ff9b::/96) reaches IPv4 — incl. IMDS — from an IPv6-only network.
  // IPv4-compatible (::a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d) likewise
  // embed a v4 target. Extract the trailing v4 and screen it like any other.
  const embedded = /^(?:64:ff9b(?::0)*|::ffff:0|:):+([0-9a-f.]+(?::[0-9a-f]{1,4})?)$/.exec(h);
  if (embedded?.[1] && isEmbeddedIPv4Blocked(embedded[1])) return true;
  // IPv4-mapped (::ffff:0:0/96). The WHATWG parser serializes the embedded v4
  // either as dotted (::ffff:169.254.169.254) or as two hex groups
  // (::ffff:a9fe:a9fe) — handle both so 169.254.169.254 can't slip through.
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped && isEmbeddedIPv4Blocked(mapped[1]!)) return true;
  return false;
}

/**
 * Validate a caller-supplied URL that will be fetched server-side. Throws a
 * descriptive Error if it is unsafe; returns the original (trimmed) string on
 * success — NOT a re-serialized form, so signed/presigned CDN URLs keep their
 * exact byte-for-byte encoding.
 */
export function assertSafeRemoteUrl(raw: string, label = "URL"): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} is not a valid URL (malformed). Check for typos or unencoded characters like spaces.`);
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    throw new Error(
      `${label} must be an http(s) URL — "${scheme}:" is not allowed (blocks file:, gopher:, dict:, data:, ftp:).`,
    );
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not embed credentials (no "user:pass@host").`);
  }

  // Strip the FQDN root dot: WHATWG preserves it, so "localhost." would miss the
  // blocklist while resolving exactly like "localhost".
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new Error(`${label} points at a local/internal host ("${host}") that a public server must not fetch.`);
  }
  const octets = toIPv4Octets(host);
  if (octets && isPrivateIPv4(octets)) {
    throw new Error(
      `${label} points at a private, loopback, or link-local address (${host}) — blocked to prevent SSRF (e.g. cloud metadata at 169.254.169.254). Media must be a publicly reachable URL.`,
    );
  }
  if (host.includes(":") && isBlockedIPv6(host)) {
    throw new Error(`${label} points at a private/loopback IPv6 address (${host}) — blocked to prevent SSRF.`);
  }

  return trimmed;
}
