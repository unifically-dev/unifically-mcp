import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
vi.mock("../src/unifically.js", () => ({ getAccount: (...a: unknown[]) => getAccount(...a) }));

import {
  admitStream,
  consumePrincipalRequestTokens,
  consumeRequestToken,
  consumeRequestTokens,
  keyId,
  resetAdmissionForTests,
  sessionLimitFor,
} from "../src/admission.js";
// Use the REAL error class. An earlier version of this file invented
// `{statusCode: 401}`, which made the tests pass while the server admitted every
// invalid key — the mock asserted a shape the code under test never produces.
import { UnificallyError } from "../src/errors.js";

// REAL key shape: 'sk-' + 33 chars. The API builds it as
//   'sk-' + generateApiKey({method:'bytes',min:36,max:36}).substring(3)
// These fixtures used 32 — a length invented rather than measured — which is
// exactly how the format gate shipped rejecting every real key and 401'd all of
// production. Keep them the true length.
const VALID = "sk-" + "a".repeat(33);
const OTHER = "sk-" + "b".repeat(33);

const funded = () => getAccount.mockResolvedValue({ balance_usd: 12.5, email: "u@x.com", user_id: 1 });
const zero = () => getAccount.mockResolvedValue({ balance_usd: 0, email: "u@x.com", user_id: 1 });
const invalid = () => getAccount.mockRejectedValue(new UnificallyError(401, "invalid api key"));

beforeEach(() => {
  resetAdmissionForTests();
  getAccount.mockReset();
});

describe("admission: the API decides what a key is, not us", () => {
  // The v1.9.0 outage: a format regex pinned 32 chars, real keys are 33, so every
  // genuine key was refused before anything that could tell it was real ran. The
  // fix was not a better regex — it was deleting the regex. These tests pin that
  // this server makes NO assumption about key shape.
  it("accepts whatever the API accepts, whatever it looks like", async () => {
    for (const k of [
      VALID, // current shape: sk- + 33, constructed above so no credential is embedded
      OTHER,
      "sk-" + "a".repeat(32), // a different length must not matter
      "sk-" + "b".repeat(64),
      "sk-UPPER-and_mixed.Chars",
      "pk_live_totally_different_scheme", // no sk- prefix at all
      "a", // absurd, but the API's call
    ]) {
      resetAdmissionForTests();
      funded();
      expect((await admitStream(k, "1.2.3.4")).ok, k).toBe(true);
    }
  });

  it("rejects a key the API rejects, and remembers it", async () => {
    invalid();
    const v = await admitStream("total-junk", "1.2.3.4");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.status).toBe(401);
    // Cost is bounded: one upstream call, then the negative cache answers.
    for (let i = 0; i < 10; i++) await admitStream("total-junk", "1.2.3.4");
    expect(getAccount).toHaveBeenCalledTimes(1);
  });

  it("carries the authenticated user_id into the admission verdict", async () => {
    funded();
    const verdict = await admitStream(VALID, "1.2.3.4");
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.userId).toBe("1");
  });

  it("fails closed if account validation returns no usable user_id", async () => {
    getAccount.mockResolvedValue({ balance_usd: 12.5, email: "u@x.com" });
    const verdict = await admitStream(VALID, "1.2.3.4");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.status).toBe(503);
  });

  it("still refuses a missing key for free — that needs no authority to judge", async () => {
    for (const k of [undefined, "", "   "]) {
      resetAdmissionForTests();
      getAccount.mockReset();
      const v = await admitStream(k, "1.2.3.4");
      expect(v.ok, JSON.stringify(k)).toBe(false);
      expect(getAccount, JSON.stringify(k)).not.toHaveBeenCalled();
    }
  });

  it("bounds a junk flood with the IP budget instead of a format guess", async () => {
    // This is what actually protects upstream — and it works regardless of what
    // the attacker's keys look like, which the regex never did.
    invalid();
    let throttled = 0;
    for (let i = 0; i < 60; i++) {
      const v = await admitStream(`whatever-${i}`, "6.6.6.6");
      if (!v.ok && v.status === 429) throttled++;
    }
    expect(throttled).toBeGreaterThan(0);
    expect(getAccount.mock.calls.length).toBeLessThanOrEqual(20);
  });
});

describe("admission: cost ordering", () => {
  it("validates a well-formed key upstream exactly once, then memoizes", async () => {
    funded();
    expect((await admitStream(VALID, "1.2.3.4")).ok).toBe(true);
    expect((await admitStream(VALID, "1.2.3.4")).ok).toBe(true);
    expect((await admitStream(VALID, "9.9.9.9")).ok).toBe(true);
    expect(getAccount).toHaveBeenCalledTimes(1);
  });

  it("negative-caches a bad key so retries are free", async () => {
    invalid();
    expect((await admitStream(VALID, "1.2.3.4")).ok).toBe(false);
    for (let i = 0; i < 10; i++) await admitStream(VALID, "1.2.3.4");
    expect(getAccount).toHaveBeenCalledTimes(1);
  });

  it("re-checks a good key once its TTL lapses (balance moves)", async () => {
    funded();
    const t0 = 1_000_000;
    await admitStream(VALID, "1.2.3.4", t0);
    await admitStream(VALID, "1.2.3.4", t0 + 59_000);
    expect(getAccount).toHaveBeenCalledTimes(1);
    await admitStream(VALID, "1.2.3.4", t0 + 61_000);
    expect(getAccount).toHaveBeenCalledTimes(2);
  });
});

describe("admission: the amplification guard", () => {
  it("caps upstream validations per IP so a random-key flood cannot DDoS our own API", async () => {
    invalid();
    let admitted = 0;
    let throttled = 0;
    // 60 DISTINCT well-formed keys: each misses the cache, so each would be an
    // upstream call without the budget. This is the flood shape that matters.
    for (let i = 0; i < 60; i++) {
      const key = `sk-${i.toString(16).padStart(32, "0")}`;
      const v = await admitStream(key, "6.6.6.6");
      if (v.ok) admitted++;
      else if (v.status === 429) throttled++;
    }
    expect(admitted).toBe(0);
    expect(throttled).toBeGreaterThan(0);
    // Without the budget this would be 60.
    expect(getAccount.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("keeps serving an ESTABLISHED user through a flood on their own IP", async () => {
    // The protection that has to hold even in the worst case (a proxy strips the
    // forwarded headers, so every caller shares one apparent IP): a key we have
    // already validated is served from cache and never reaches the budget gate.
    funded();
    expect((await admitStream(OTHER, "5.5.5.5")).ok).toBe(true); // establish
    invalid();
    for (let i = 0; i < 60; i++) await admitStream(`sk-${i.toString(16).padStart(32, "0")}`, "5.5.5.5");
    expect((await admitStream(OTHER, "5.5.5.5")).ok).toBe(true); // still served
  });

  it("throttles UNKNOWN keys from an IP that is actively failing (documented tradeoff)", async () => {
    // A first-time key arriving from an IP mid-flood waits out the window. This
    // is the accepted cost of bounding amplification, and it is why an accurate
    // client IP matters: behind Cloudflare, CF-Connecting-IP makes the flooder's
    // budget theirs alone rather than everyone's.
    invalid();
    for (let i = 0; i < 60; i++) await admitStream(`sk-${i.toString(16).padStart(32, "0")}`, "5.5.5.5");
    funded();
    const v = await admitStream(OTHER, "5.5.5.5");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.status).toBe(429);
    // ...and it clears on the next window rather than being sticky.
    const later = await admitStream(OTHER, "5.5.5.5", Date.now() + 61_000);
    expect(later.ok).toBe(true);
  });

  it("a valid key's validation costs no budget at all", async () => {
    funded();
    for (let i = 0; i < 50; i++) {
      resetAdmissionForTests(); // force a cache miss each time
      funded();
      expect((await admitStream(VALID, "4.4.4.4")).ok).toBe(true);
    }
  });

  it("budgets per IP, so one flooder cannot throttle everyone else", async () => {
    funded();
    for (let i = 0; i < 40; i++) await admitStream(`sk-${i.toString(16).padStart(32, "0")}`, "6.6.6.6");
    // A different IP with a fresh key is unaffected.
    const v = await admitStream(OTHER, "7.7.7.7");
    expect(v.ok).toBe(true);
  });
});

describe("admission: upstream outage fails closed", () => {
  it("rejects an unverified key with 503 when the account API is unavailable", async () => {
    getAccount.mockRejectedValue(new UnificallyError(503, "gateway timeout"));
    const v = await admitStream(VALID, "1.2.3.4");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.status).toBe(503);
  });

  it("briefly caches the 503 and retries validation after the outage cache expires", async () => {
    const start = 1_000_000;
    getAccount.mockRejectedValueOnce(new UnificallyError(500, "boom"));
    const first = await admitStream(VALID, "1.2.3.4", start);
    expect(first.ok).toBe(false);
    expect(first.ok === false && first.status).toBe(503);

    funded();
    const cached = await admitStream(VALID, "1.2.3.4", start + 7_000);
    expect(cached.ok).toBe(false);
    expect(cached.ok === false && cached.status).toBe(503);
    expect(getAccount).toHaveBeenCalledTimes(1);

    expect((await admitStream(VALID, "1.2.3.4", start + 9_000)).ok).toBe(true);
    expect(getAccount).toHaveBeenCalledTimes(2);
  });
});

describe("admission: $0 balance is admitted, not dropped", () => {
  it("admits a zero-balance key", async () => {
    zero();
    const v = await admitStream(VALID, "1.2.3.4");
    // A $0 user still needs check_balance to SEE they're at $0, get_task to
    // collect work already paid for, and dry_run_cost to price a top-up.
    // Dropping them would break the exact user who is about to pay.
    expect(v.ok).toBe(true);
    expect(v.ok && v.funded).toBe(false);
  });

  it("gives a zero-balance key a tighter session allowance than a funded one", async () => {
    expect(sessionLimitFor(false)).toBeLessThan(sessionLimitFor(true));
    expect(sessionLimitFor(false)).toBeGreaterThan(0);
  });
});

describe("rate limit: token bucket", () => {
  it("shares one account-wide budget across several API keys", () => {
    const t0 = 1_000_000;
    expect(consumePrincipalRequestTokens("key-a", "user-1", 20, t0).ok).toBe(true);
    expect(consumePrincipalRequestTokens("key-b", "user-1", 20, t0).ok).toBe(true);
    expect(consumePrincipalRequestTokens("key-c", "user-1", 1, t0).ok).toBe(false);

    // The account-wide rejection was atomic: key-c kept its full key budget,
    // and another account can use it here without inheriting user-1's debt.
    expect(consumePrincipalRequestTokens("key-c", "user-2", 40, t0).ok).toBe(true);
  });

  it("still limits an individual API key inside the account-wide allowance", () => {
    const t0 = 1_000_000;
    expect(consumePrincipalRequestTokens("one-key", "user-a", 40, t0).ok).toBe(true);
    expect(consumePrincipalRequestTokens("one-key", "user-b", 1, t0).ok).toBe(false);
    expect(consumePrincipalRequestTokens("another-key", "user-b", 1, t0).ok).toBe(true);
  });

  it("charges every message in a JSON-RPC batch", () => {
    const t0 = 1_000_000;
    expect(consumeRequestTokens("batch", 16, t0).ok).toBe(true);
    let remaining = 0;
    while (consumeRequestToken("batch", t0).ok) remaining++;
    expect(remaining).toBe(24); // default burst 40 minus the 16-message batch
  });

  it("rejects an oversized charge atomically", () => {
    const t0 = 1_000_000;
    expect(consumeRequestTokens("atomic", 30, t0).ok).toBe(true);
    expect(consumeRequestTokens("atomic", 16, t0).ok).toBe(false);
    // The refused 16-item charge did not consume the 10 tokens that remained.
    expect(consumeRequestTokens("atomic", 10, t0).ok).toBe(true);
  });

  it("absorbs a normal client's opening burst", async () => {
    // tools/list + resources/list + a few calls must never trip the limiter.
    for (let i = 0; i < 10; i++) expect(consumeRequestToken("k1", 1_000_000).ok).toBe(true);
  });

  it("stops a sustained flood from a valid key", () => {
    let served = 0;
    for (let i = 0; i < 500; i++) if (consumeRequestToken("k2", 1_000_000).ok) served++;
    // Bounded by burst capacity when no time passes.
    expect(served).toBeLessThan(60);
    expect(served).toBeGreaterThan(0);
  });

  it("refills over time so a throttled client recovers on its own", () => {
    const t0 = 1_000_000;
    while (consumeRequestToken("k3", t0).ok) { /* drain */ }
    expect(consumeRequestToken("k3", t0).ok).toBe(false);
    // A minute later the bucket has refilled.
    expect(consumeRequestToken("k3", t0 + 60_000).ok).toBe(true);
  });

  it("tells a throttled client when to retry", () => {
    const t0 = 1_000_000;
    while (consumeRequestToken("k4", t0).ok) { /* drain */ }
    const denied = consumeRequestToken("k4", t0);
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("budgets per key, so one noisy key cannot throttle another", () => {
    const t0 = 1_000_000;
    while (consumeRequestToken("noisy", t0).ok) { /* drain */ }
    expect(consumeRequestToken("noisy", t0).ok).toBe(false);
    expect(consumeRequestToken("quiet", t0).ok).toBe(true);
  });

  it("does not consider balance — a $0 user gets the same request budget", () => {
    // Rate limiting is about request volume, not spend. A $0 user polling
    // get_task looks identical to a paying one and must not be penalised.
    const t0 = 1_000_000;
    let zeroServed = 0;
    for (let i = 0; i < 30; i++) if (consumeRequestToken("zero-bal", t0).ok) zeroServed++;
    let paidServed = 0;
    for (let i = 0; i < 30; i++) if (consumeRequestToken("paid-bal", t0).ok) paidServed++;
    expect(zeroServed).toBe(paidServed);
  });
});

describe("admission: key handling", () => {
  it("never uses the raw secret as an identifier", () => {
    const id = keyId(VALID);
    expect(id).not.toContain(VALID);
    expect(VALID).not.toContain(id);
    expect(keyId(VALID)).toBe(keyId(VALID));
    expect(keyId(VALID)).not.toBe(keyId(OTHER));
  });
});
