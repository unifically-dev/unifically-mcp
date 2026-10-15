import { BlockList, isIPv4, isIPv6 } from "node:net";

type IpFamily = "ipv4" | "ipv6";

function normalizedIp(value: string | undefined): { address: string; family: IpFamily } | null {
  if (!value) return null;
  const trimmed = value.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  const address = mapped?.[1] ?? trimmed;
  if (isIPv4(address)) return { address, family: "ipv4" };
  if (isIPv6(address)) return { address, family: "ipv6" };
  return null;
}

function addLoopback(list: BlockList): void {
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("::1", 128, "ipv6");
}

function addPrivate(list: BlockList): void {
  for (const [address, prefix] of [
    ["10.0.0.0", 8],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["169.254.0.0", 16],
    ["100.64.0.0", 10],
  ] as const) list.addSubnet(address, prefix, "ipv4");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
}

/**
 * Build the explicit proxy trust boundary.
 *
 * Default: loopback only. `private` is convenient for an isolated Docker
 * network, but it must be opted into by that deployment. Automatically trusting
 * every private peer lets any process on a LAN/container network forge a fresh
 * X-Forwarded-For value and evade the per-IP validation budget.
 *
 * UNIFICALLY_TRUSTED_PROXIES accepts comma-separated `loopback`, `private`,
 * exact IPs, or CIDRs. Use `none` to trust no proxy at all.
 */
function trustedProxyList(): BlockList {
  const list = new BlockList();
  const configured = process.env.UNIFICALLY_TRUSTED_PROXIES?.trim();
  const entries = (configured || "loopback").split(",").map((v) => v.trim()).filter(Boolean);
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (lower === "none") continue;
    if (lower === "loopback") {
      addLoopback(list);
      continue;
    }
    if (lower === "private") {
      addPrivate(list);
      continue;
    }
    const slash = entry.lastIndexOf("/");
    const rawAddress = slash === -1 ? entry : entry.slice(0, slash);
    const parsed = normalizedIp(rawAddress);
    if (!parsed) continue; // fail closed on malformed configuration
    if (slash === -1) {
      list.addAddress(parsed.address, parsed.family);
      continue;
    }
    const prefix = Number(entry.slice(slash + 1));
    const max = parsed.family === "ipv4" ? 32 : 128;
    if (Number.isInteger(prefix) && prefix >= 0 && prefix <= max) {
      list.addSubnet(parsed.address, prefix, parsed.family);
    }
  }
  return list;
}

export function isTrustedProxy(peer: string | undefined): boolean {
  const parsed = normalizedIp(peer);
  return parsed ? trustedProxyList().check(parsed.address, parsed.family) : false;
}

export function trustCfConnectingIp(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.UNIFICALLY_TRUST_CF_CONNECTING_IP?.trim() ?? "");
}

/** Resolve a reported client IP without ever accepting malformed hops. */
export function forwardedClientIp(
  peer: string | undefined,
  cfConnectingIp: string | undefined,
  xForwardedFor: string | undefined,
): string {
  const parsedPeer = normalizedIp(peer);
  if (!parsedPeer) return peer ?? "unknown";
  const trusted = trustedProxyList();
  if (!trusted.check(parsedPeer.address, parsedPeer.family)) return parsedPeer.address;

  if (trustCfConnectingIp()) {
    const cf = normalizedIp(cfConnectingIp);
    if (cf) return cf.address;
  }

  if (xForwardedFor?.trim()) {
    const hops = xForwardedFor.split(",").map((hop) => normalizedIp(hop));
    // A malformed hop makes the chain untrustworthy; use the authenticated TCP
    // peer rather than trying to guess around attacker-controlled text.
    if (hops.some((hop) => hop === null)) return parsedPeer.address;
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i]!;
      if (!trusted.check(hop.address, hop.family)) return hop.address;
    }
  }
  return parsedPeer.address;
}
