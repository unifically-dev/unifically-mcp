import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/unifically.js", () => ({ getAccount: vi.fn() }));

import { consumeAnonymousDiscoveryTokens, resetAdmissionForTests } from "../src/admission.js";
import { isPublicDiscoveryBody, PUBLIC_DISCOVERY_METHODS } from "../src/publicDiscovery.js";

const msg = (method: string, extra: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params: {},
  ...extra,
});

describe("public discovery allowlist", () => {
  it("lets a keyless client complete a handshake and read the tool surface", () => {
    for (const method of ["initialize", "notifications/initialized", "ping", "tools/list", "resources/list", "prompts/list"]) {
      expect(isPublicDiscoveryBody(msg(method)), method).toBe(true);
    }
  });

  it("keeps everything that spends money or reads the account behind the key", () => {
    for (const method of [
      "tools/call", // the whole point: listing is free, running is not
      "resources/read", // unifically://models fetches the live catalog with the caller's key
      "completion/complete",
      "logging/setLevel",
      "sampling/createMessage",
    ]) {
      expect(isPublicDiscoveryBody(msg(method)), method).toBe(false);
    }
  });

  it("fails closed on anything that is not a recognized discovery request", () => {
    expect(isPublicDiscoveryBody(undefined)).toBe(false);
    expect(isPublicDiscoveryBody(null)).toBe(false);
    expect(isPublicDiscoveryBody("tools/list")).toBe(false);
    expect(isPublicDiscoveryBody([])).toBe(false);
    expect(isPublicDiscoveryBody({ jsonrpc: "2.0", id: 1, result: {} })).toBe(false); // a response, not a request
    expect(isPublicDiscoveryBody({ jsonrpc: "2.0", id: 1 })).toBe(false); // no method at all
    expect(isPublicDiscoveryBody(msg("tools/list ")), "trailing space is a different method").toBe(false);
    expect(isPublicDiscoveryBody(msg("TOOLS/LIST"))).toBe(false);
    // A non-string method must not reach Set.has() as something truthy.
    expect(isPublicDiscoveryBody({ jsonrpc: "2.0", id: 1, method: { toString: () => "tools/list" } })).toBe(false);
    expect(isPublicDiscoveryBody({ jsonrpc: "2.0", id: 1, method: ["tools/list"] })).toBe(false);
  });

  it("does not inherit Set/Object members as allowed methods", () => {
    for (const method of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(PUBLIC_DISCOVERY_METHODS.has(method), method).toBe(false);
      expect(isPublicDiscoveryBody(msg(method)), method).toBe(false);
    }
  });

  it("rejects a whole batch when any message needs the key", () => {
    // The transport executes every message in the body, so a batch is only as
    // public as its most privileged member.
    expect(isPublicDiscoveryBody([msg("tools/list"), msg("initialize")])).toBe(true);
    expect(isPublicDiscoveryBody([msg("tools/list"), msg("tools/call")])).toBe(false);
    expect(isPublicDiscoveryBody([msg("tools/call"), msg("tools/list")])).toBe(false);
    expect(isPublicDiscoveryBody([msg("tools/list"), "junk"])).toBe(false);
  });
});

describe("anonymous discovery budget", () => {
  beforeEach(() => resetAdmissionForTests());

  it("allows a handshake burst, then throttles a keyless flood", () => {
    const ip = "203.0.113.7";
    const now = 1_000_000;
    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      if (consumeAnonymousDiscoveryTokens(ip, 1, now).ok) allowed++;
    }
    expect(allowed).toBe(12); // default burst — enough for initialize + tools/list + retries
    const denied = consumeAnonymousDiscoveryTokens(ip, 1, now);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    const ip = "203.0.113.8";
    const now = 2_000_000;
    for (let i = 0; i < 12; i++) consumeAnonymousDiscoveryTokens(ip, 1, now);
    expect(consumeAnonymousDiscoveryTokens(ip, 1, now).ok).toBe(false);
    expect(consumeAnonymousDiscoveryTokens(ip, 1, now + 60_000).ok).toBe(true);
  });

  it("meters each address separately", () => {
    const now = 3_000_000;
    for (let i = 0; i < 12; i++) consumeAnonymousDiscoveryTokens("198.51.100.1", 1, now);
    expect(consumeAnonymousDiscoveryTokens("198.51.100.1", 1, now).ok).toBe(false);
    expect(consumeAnonymousDiscoveryTokens("198.51.100.2", 1, now).ok).toBe(true);
  });

  it("charges a batch by its message count, not per HTTP request", () => {
    const ip = "198.51.100.9";
    const now = 4_000_000;
    expect(consumeAnonymousDiscoveryTokens(ip, 10, now).ok).toBe(true);
    expect(consumeAnonymousDiscoveryTokens(ip, 10, now).ok).toBe(false);
  });
});
