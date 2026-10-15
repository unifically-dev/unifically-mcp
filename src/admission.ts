import { createHash } from "node:crypto";

import { UnificallyError } from "./errors.js";
import { getAccount } from "./unifically.js";

/**
 * Admission control for SSE streams.
 *
 * An SSE stream is the one place a caller makes this server hold resources (an
 * McpServer instance, a keepalive timer, a socket) before proving anything. The
 * MCP spec covers who may USE a session (auth every request; never treat a
 * session id as identity — see handleSseMessage), but not who may OPEN one. That
 * gap is what lets a bot with no credential squat every slot until real users
 * get 503s.
 *
 * Three gates, cheapest first, so the expensive one is never the flood target:
 *
 *   1. FORMAT   — free, no I/O. Kills junk like "not-a-real-key-at-all".
 *   2. RATE     — per-IP budget on *validation attempts*. Without this, "validate
 *                 on connect" turns an anonymous flood into an authenticated
 *                 flood against api.unifically.com — we'd DDoS ourselves on the
 *                 attacker's behalf. This is the load-bearing gate.
 *   3. UPSTREAM — one GET /account, memoized (positive + NEGATIVE), so a repeated
 *                 key costs nothing after the first attempt.
 *
 * Then a per-key concurrency cap, tiered by balance. A $0 key is NOT refused: it
 * still needs check_balance to see it's at $0, get_task to collect work already
 * paid for, and dry_run_cost to price a top-up. Refusing it would break the exact
 * user who is about to pay. It cannot spend anything regardless — the API 402s it
 * — so it costs only a slot, and a tighter cap is the proportionate answer.
 */

/**
 * There is deliberately NO key-format check here. The API is the only authority
 * on what a valid key looks like; this server does not get a vote.
 *
 * A regex used to guard this path as a "free" filter for junk. It cost a total
 * production outage: it pinned 32 chars, real keys are 33, so every genuine key
 * was refused before anything that could tell it was real ever ran. The upside
 * was never worth it either — an attacker who knows the format just generates
 * matching keys, at which point the regex stops nothing and the IP budget below
 * is doing all the work regardless. It only ever caught lazy junk, and the
 * failure mode was locking out paying customers.
 *
 * So junk now costs one upstream validation, bounded by reserveIpBudget() and
 * then remembered by the negative cache. That is the correct price for not
 * guessing.
 */

const VALIDATION_TTL_OK_MS = 60_000; // re-check a good key every minute (balance moves)
const VALIDATION_TTL_BAD_MS = 300_000; // remember a bad key longer than a good one
// An unavailable upstream (timeout/429/5xx) is memoized too, briefly. This keeps
// fail-closed validation from re-probing a sick upstream on EVERY request while
// allowing the MCP server to recover promptly when the account API returns.
const VALIDATION_TTL_UNAVAILABLE_MS = 8_000;
const VALIDATIONS_PER_IP_PER_MIN = 20;

export const SESSIONS_PER_FUNDED_KEY = 8;
export const SESSIONS_PER_ZERO_BALANCE_KEY = 2;

type Verdict =
  | { ok: true; keyId: string; userId: string; funded: boolean }
  | { ok: false; status: number; message: string };

type CacheEntry =
  | { at: number; valid: true; userId: string; funded: boolean; ttl: number }
  | { at: number; valid: false; funded: false; ttl: number; status: 401 | 503; message: string };

const validationCache = new Map<string, CacheEntry>();
const ipBudget = new Map<string, { windowStart: number; count: number }>();
// Single-flight: N concurrent requests for one uncached key must produce ONE
// upstream call, not N. The cache only populates after the await, so without
// this the first burst stampedes straight past gate 3.
const inFlightValidations = new Map<string, Promise<Verdict>>();

/** Never key a cache or a log by the raw secret. */
export function keyId(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/**
 * Bound the maps so the defenses can't themselves become the memory leak.
 *
 * Evicts in Map insertion order, which is only LRU if readers call touch() —
 * Map.set on an EXISTING key does not move it to the back. Without touch() this
 * is closer to anti-LRU: a long-lived paying customer keeps its original
 * front-of-map slot and gets evicted FIRST, while a flood of one-shot bot keys
 * sits at the back. That turns a key flood into a permanent revalidation storm
 * against our own API.
 */
function prune<T>(map: Map<string, T>, max: number): void {
  if (map.size <= max) return;
  const excess = map.size - max;
  let i = 0;
  for (const k of map.keys()) {
    if (i++ >= excess) break;
    map.delete(k);
  }
}

/** Move a key to the back of the insertion order, making prune() a real LRU. */
function touch<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
}

/**
 * RESERVE budget, atomically, before the upstream await. Returns false when the
 * caller is over budget.
 *
 * Read-then-charge-later is a check/act window: concurrent requests all observe
 * count=0 and pass before any of them charges, so the budget never bites — 40
 * parallel bad keys produced 40 upstream calls against a limit of 20. JS is
 * single-threaded, so reserving synchronously here is atomic with respect to the
 * event loop; the await happens strictly after.
 *
 * A SUCCESSFUL validation is refunded (see refundIpBudget), preserving the
 * property that honest traffic is invisible to this gate: a real user's key
 * validates fine, but a flooder sharing their egress IP — which is EVERY user if
 * a proxy strips the forwarded headers — would otherwise lock them out.
 */
function reserveIpBudget(ip: string, now: number): boolean {
  const b = ipBudget.get(ip);
  if (!b || now - b.windowStart >= 60_000) {
    ipBudget.set(ip, { windowStart: now, count: 1 });
    prune(ipBudget, 10_000);
    return true;
  }
  if (b.count >= VALIDATIONS_PER_IP_PER_MIN) return false;
  b.count += 1;
  return true;
}

/** Give the reservation back — the key turned out to be real. */
function refundIpBudget(ip: string, now: number): void {
  const b = ipBudget.get(ip);
  if (b && now - b.windowStart < 60_000 && b.count > 0) b.count -= 1;
}

/**
 * Decide whether this key may open a stream. `now` is injected so tests can move
 * time without sleeping.
 */
export async function admitStream(
  apiKey: string | undefined,
  ip: string,
  now: number = Date.now(),
): Promise<Verdict> {
  // The one free rejection worth keeping: no key at all needs no authority to
  // judge. Anything else goes to the API.
  if (!apiKey?.trim()) {
    return { ok: false, status: 401, message: "Missing API key. Send 'Authorization: Bearer <key>' (get one at https://unifically.com/api-keys)." };
  }

  const id = keyId(apiKey);
  const cached = validationCache.get(id);
  if (cached && now - cached.at < cached.ttl) {
    touch(validationCache, id, cached); // real LRU — see prune()
    if (!cached.valid) {
      return { ok: false, status: cached.status, message: cached.message };
    }
    return { ok: true, keyId: id, userId: cached.userId, funded: cached.funded };
  }

  // Coalesce concurrent misses for the same key onto one upstream call.
  const pending = inFlightValidations.get(id);
  if (pending) return await pending;

  // Reserve BEFORE the await, atomically. Only an unmemoized key gets here, so
  // the budget bites on genuinely new keys — exactly a random-key flood's shape.
  if (!reserveIpBudget(ip, now)) {
    return { ok: false, status: 429, message: "Too many failed key validations from this address. Retry shortly." };
  }

  const work = validateUpstream(apiKey, id, ip, now);
  inFlightValidations.set(id, work);
  try {
    return await work;
  } finally {
    inFlightValidations.delete(id);
  }
}

async function validateUpstream(apiKey: string, id: string, ip: string, now: number): Promise<Verdict> {
  try {
    // maxRetries:0 — this is a liveness probe on a hot path, not a user's read.
    // The default 3 retries would hit a struggling upstream 4x per request.
    const account = await getAccount({ apiKey }, { maxRetries: 0 });
    const userId = String(account.user_id ?? "").trim();
    if (!/^\d+$/.test(userId)) {
      throw new Error("Account validation returned no usable user_id.");
    }
    const funded = (account.balance_usd ?? 0) > 0;
    validationCache.set(id, { at: now, valid: true, userId, funded, ttl: VALIDATION_TTL_OK_MS });
    prune(validationCache, 10_000);
    refundIpBudget(ip, now); // success costs no budget
    return { ok: true, keyId: id, userId, funded };
  } catch (err) {
    // UnificallyError carries `code`, NOT `statusCode`. Getting this wrong makes
    // every 401 look inconclusive and silently admits invalid keys — read the
    // real error type rather than guessing its shape.
    const status = err instanceof UnificallyError ? err.code : undefined;
    if (status === 401 || status === 403) {
      const message = "Invalid API key. Get one at https://unifically.com/api-keys.";
      validationCache.set(id, {
        at: now,
        valid: false,
        funded: false,
        ttl: VALIDATION_TTL_BAD_MS,
        status: 401,
        message,
      });
      prune(validationCache, 10_000);
      return { ok: false, status: 401, message };
    }
    // The account API is the only authority on whether a key is valid. If it is
    // unavailable, fail closed: no unverified caller may enter MCP. Cache that
    // 503 briefly so an outage does not become a validation retry storm. The IP
    // reservation is deliberately not refunded because the round-trip still
    // consumed upstream capacity.
    const message = "Unable to validate the API key because the UnificAlly API is temporarily unavailable. Retry shortly.";
    validationCache.set(id, {
      at: now,
      valid: false,
      funded: false,
      ttl: VALIDATION_TTL_UNAVAILABLE_MS,
      status: 503,
      message,
    });
    prune(validationCache, 10_000);
    return { ok: false, status: 503, message };
  }
}

/** Per-key and per-user SSE ceiling, tiered by account balance. */
export function sessionLimitFor(funded: boolean): number {
  return funded ? SESSIONS_PER_FUNDED_KEY : SESSIONS_PER_ZERO_BALANCE_KEY;
}

/**
 * Per-key and per-user request rate limits. Both use the same token-bucket
 * allowance, so creating extra keys cannot multiply one account's budget.
 *
 * This applies to EVERY authenticated MCP request, not just stream opens. Without
 * it, a valid key (free signup, $0 balance) can hammer POST /mcp forever: each
 * request builds a fresh McpServer, and `tools/list` never touches upstream, so
 * nothing else throttles it. Balance is deliberately NOT a factor here — a $0 user
 * doing real work (polling get_task, browsing models) looks identical to a paying
 * one, and this limit is about request volume, not spend.
 *
 * Burst covers a client that opens with tools/list + resources/list + a few calls;
 * the refill rate is what a busy polling agent actually needs, with headroom.
 */
/**
 * Read once at module load, not per call: two process.env lookups + a Number()
 * on every request is waste, and reading them separately mid-flight let capacity
 * and refill come from different configs. Malformed values are clamped into a
 * sane range rather than silently reverting to the default (a typo'd
 * UNIFICALLY_RATE_PER_MIN=1e308 previously disabled the limiter outright).
 */
function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

const BUCKET_CAPACITY = num("UNIFICALLY_RATE_BURST", 40, 1, 10_000);
const REFILL_PER_MINUTE = num("UNIFICALLY_RATE_PER_MIN", 120, 1, 100_000);

/**
 * Budget for UNAUTHENTICATED discovery (initialize / tools/list — see
 * publicDiscovery.ts), metered per IP.
 *
 * Every other gate in this file rests on a validated key. This one has no key
 * to rest on, so the IP bucket IS the entire defense: it is the only thing
 * between a credential-free bot and the CPU cost of parsing its body and
 * building an McpServer per request. Deliberately far tighter than the
 * authenticated budget — a real discovery client sends a handshake and a
 * listing once, then either presents a key or goes away. A caller that needs
 * sustained throughput has a key and gets the normal allowance.
 */
const ANON_BUCKET_CAPACITY = num("UNIFICALLY_ANON_RATE_BURST", 12, 1, 1_000);
const ANON_REFILL_PER_MINUTE = num("UNIFICALLY_ANON_RATE_PER_MIN", 30, 1, 10_000);

const buckets = new Map<string, { tokens: number; last: number }>();

/** Returns false when the caller is over budget. `retryAfterMs` guides the client. */
export function consumeRequestToken(
  ident: string,
  now: number = Date.now(),
): { ok: true } | { ok: false; retryAfterMs: number } {
  return consumeRequestTokens(ident, 1, now);
}

/**
 * Atomically charge several MCP messages carried by one HTTP JSON-RPC batch.
 * Charging only the outer HTTP request lets a batch repeat an allowed tool
 * hundreds of times for the price of one rate-limit token.
 */
export function consumeRequestTokens(
  ident: string,
  count: number,
  now: number = Date.now(),
): { ok: true } | { ok: false; retryAfterMs: number } {
  return consumeRequestTokensForIdentities([ident], count, now);
}

/** Charge both a concrete API key and its owning account, atomically. */
export function consumePrincipalRequestToken(
  keyIdent: string,
  userId: string,
  now: number = Date.now(),
): { ok: true } | { ok: false; retryAfterMs: number } {
  return consumePrincipalRequestTokens(keyIdent, userId, 1, now);
}

/**
 * A user may own several API keys. Requiring both buckets prevents rotating
 * those keys from multiplying one account's request allowance.
 */
export function consumePrincipalRequestTokens(
  keyIdent: string,
  userId: string,
  count: number,
  now: number = Date.now(),
): { ok: true } | { ok: false; retryAfterMs: number } {
  return consumeRequestTokensForIdentities([`key:${keyIdent}`, `user:${userId}`], count, now);
}

/**
 * Charge an unauthenticated caller's per-IP discovery budget.
 *
 * Keyed in its own `anon:` namespace so it can never share a bucket with the
 * `key:`/`user:` identities above — an anonymous flood must not be able to
 * spend a paying account's allowance.
 */
export function consumeAnonymousDiscoveryTokens(
  ip: string,
  count: number,
  now: number = Date.now(),
): { ok: true } | { ok: false; retryAfterMs: number } {
  return consumeRequestTokensForIdentities(
    [`anon:${ip}`],
    count,
    now,
    ANON_BUCKET_CAPACITY,
    ANON_REFILL_PER_MINUTE,
  );
}

function consumeRequestTokensForIdentities(
  identities: string[],
  count: number,
  now: number,
  capacity: number = BUCKET_CAPACITY,
  refillPerMinute: number = REFILL_PER_MINUTE,
): { ok: true } | { ok: false; retryAfterMs: number } {
  const perMs = refillPerMinute / 60_000;
  const truncated = Math.trunc(count);
  const cost = Number.isFinite(truncated) ? Math.max(1, truncated) : capacity + 1;
  if (cost > capacity) {
    return { ok: false, retryAfterMs: Math.ceil((cost - capacity) / perMs) };
  }

  const states = [...new Set(identities)].map((ident) => {
    let bucket = buckets.get(ident);
    if (!bucket) {
      bucket = { tokens: capacity, last: now };
      buckets.set(ident, bucket);
    } else {
      // Math.max(0, ...) floors the elapsed time: an NTP step backwards or a
      // suspend/resume must not drive tokens negative.
      bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.last) * perMs);
      bucket.last = now;
      touch(buckets, ident, bucket);
    }
    return bucket;
  });
  prune(buckets, 40_000); // up to one API-key bucket + one account bucket per caller

  const short = states.filter((bucket) => bucket.tokens < cost);
  if (short.length > 0) {
    const missing = Math.max(...short.map((bucket) => cost - bucket.tokens));
    return { ok: false, retryAfterMs: Math.ceil(missing / perMs) };
  }
  for (const bucket of states) bucket.tokens -= cost;
  return { ok: true };
}

export function resetAdmissionForTests(): void {
  validationCache.clear();
  ipBudget.clear();
  buckets.clear();
}
