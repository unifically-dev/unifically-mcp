import { afterEach, describe, expect, it } from "vitest";

import { forwardedClientIp, isTrustedProxy } from "../src/trustedProxy.js";

afterEach(() => {
  delete process.env.UNIFICALLY_TRUSTED_PROXIES;
  delete process.env.UNIFICALLY_TRUST_CF_CONNECTING_IP;
});

describe("explicit proxy trust boundary", () => {
  it("trusts loopback only by default", () => {
    expect(isTrustedProxy("127.0.0.1")).toBe(true);
    expect(isTrustedProxy("::1")).toBe(true);
    expect(isTrustedProxy("::ffff:127.0.0.1")).toBe(true);
    expect(isTrustedProxy("172.17.0.1")).toBe(false);
    expect(isTrustedProxy("10.0.0.5")).toBe(false);
    expect(isTrustedProxy("8.8.8.8")).toBe(false);
  });

  it("allows isolated deployments to opt into private proxy ranges", () => {
    process.env.UNIFICALLY_TRUSTED_PROXIES = "loopback,private";
    expect(isTrustedProxy("172.17.0.1")).toBe(true);
    expect(isTrustedProxy("10.0.0.5")).toBe(true);
    expect(isTrustedProxy("192.168.1.10")).toBe(true);
    expect(isTrustedProxy("fd00::1")).toBe(true);
    expect(isTrustedProxy("8.8.8.8")).toBe(false);
  });

  it("accepts exact IPs and CIDRs and fails closed on malformed entries", () => {
    process.env.UNIFICALLY_TRUSTED_PROXIES = "203.0.113.9,198.51.100.0/24,bad,10.0.0.0/999";
    expect(isTrustedProxy("203.0.113.9")).toBe(true);
    expect(isTrustedProxy("198.51.100.24")).toBe(true);
    expect(isTrustedProxy("198.51.101.24")).toBe(false);
    expect(isTrustedProxy("10.0.0.1")).toBe(false);
    expect(isTrustedProxy("10.0.0.1; forged")).toBe(false);
  });

  it("uses X-Forwarded-For only from a trusted peer and walks it right-to-left", () => {
    process.env.UNIFICALLY_TRUSTED_PROXIES = "loopback,private";
    expect(forwardedClientIp("8.8.8.8", undefined, "198.51.100.7")).toBe("8.8.8.8");
    expect(forwardedClientIp("127.0.0.1", undefined, "198.51.100.7, 172.18.0.4")).toBe("198.51.100.7");
    expect(forwardedClientIp("127.0.0.1", undefined, "forged, 172.18.0.4")).toBe("127.0.0.1");
  });

  it("ignores CF-Connecting-IP unless explicitly enabled", () => {
    expect(forwardedClientIp("127.0.0.1", "198.51.100.10", "198.51.100.20")).toBe("198.51.100.20");
    process.env.UNIFICALLY_TRUST_CF_CONNECTING_IP = "true";
    expect(forwardedClientIp("127.0.0.1", "198.51.100.10", "198.51.100.20")).toBe("198.51.100.10");
  });

  it("compose opts into private peers only on its unpublished container port", async () => {
    const { readFileSync } = await import("node:fs");
    const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
    expect(compose).toMatch(/UNIFICALLY_TRUSTED_PROXIES:\s*private/);
    expect(compose).not.toMatch(/^\s*-\s*"8787:8787"\s*$/m);
    expect(compose).toMatch(/expose:/);
  });
});
