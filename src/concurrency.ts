interface CloseEmitter {
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

export function releaseOnce(releaseReservation: () => void): () => void {
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    releaseReservation();
  };
}

/** Run reservation cleanup on disconnect or completion, but never twice. */
export function releaseOnResponseClose(res: CloseEmitter, releaseReservation: () => void): () => void {
  const release = releaseOnce(() => {
    res.off("close", release);
    releaseReservation();
  });
  res.once("close", release);
  return release;
}

export type ConcurrencyScope = "key" | "user" | "global";

export type ConcurrencyReservation =
  | { ok: true; release: () => void }
  | { ok: false; scope: ConcurrencyScope; limit: number };

/** Atomic, process-local concurrency accounting for MCP message execution. */
export class MessageConcurrencyGate {
  private total = 0;
  private readonly byKey = new Map<string, number>();
  private readonly byUser = new Map<string, number>();

  constructor(
    private readonly globalLimit: number,
    private readonly perKeyLimit: number,
    private readonly perUserLimit: number,
  ) {}

  reserve(key: string, user: string, requestedCount: number): ConcurrencyReservation {
    const count = Math.trunc(requestedCount);
    if (!Number.isFinite(count) || count < 1) {
      throw new RangeError("Concurrency reservation count must be a positive finite integer.");
    }

    const keyCount = this.byKey.get(key) ?? 0;
    if (keyCount + count > this.perKeyLimit) {
      return { ok: false, scope: "key", limit: this.perKeyLimit };
    }
    const userCount = this.byUser.get(user) ?? 0;
    if (userCount + count > this.perUserLimit) {
      return { ok: false, scope: "user", limit: this.perUserLimit };
    }
    if (this.total + count > this.globalLimit) {
      return { ok: false, scope: "global", limit: this.globalLimit };
    }

    this.total += count;
    this.byKey.set(key, keyCount + count);
    this.byUser.set(user, userCount + count);

    return {
      ok: true,
      release: releaseOnce(() => {
        this.total = Math.max(0, this.total - count);
        this.decrement(this.byKey, key, count);
        this.decrement(this.byUser, user, count);
      }),
    };
  }

  /** Test/diagnostic view containing counts only, never credentials. */
  snapshot(): { total: number; keys: number; users: number } {
    return { total: this.total, keys: this.byKey.size, users: this.byUser.size };
  }

  private decrement(map: Map<string, number>, identity: string, count: number): void {
    const remaining = Math.max(0, (map.get(identity) ?? 0) - count);
    if (remaining === 0) map.delete(identity);
    else map.set(identity, remaining);
  }
}

type JsonRpcId = string | number;

function requestId(message: unknown): JsonRpcId | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const candidate = message as Record<string, unknown>;
  if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") return undefined;
  return typeof candidate.id === "string" || typeof candidate.id === "number" ? candidate.id : undefined;
}

function responseId(message: unknown): JsonRpcId | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const candidate = message as Record<string, unknown>;
  if (candidate.jsonrpc !== "2.0" || !("result" in candidate || "error" in candidate)) return undefined;
  return typeof candidate.id === "string" || typeof candidate.id === "number" ? candidate.id : undefined;
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

/**
 * Legacy SSE acknowledges POST /messages before the async MCP handler finishes.
 * Hold each request's concurrency lease until its result/error is written to the
 * SSE stream, and release every remaining lease when the stream closes.
 */
export class SseRequestLeaseTracker {
  private readonly releases = new Map<string, () => void>();

  track(message: unknown, releaseReservation: () => void): "tracked" | "notification" | "duplicate" {
    const id = requestId(message);
    if (id === undefined) return "notification";
    const key = idKey(id);
    if (this.releases.has(key)) return "duplicate";
    this.releases.set(key, releaseOnce(releaseReservation));
    return "tracked";
  }

  complete(message: unknown): void {
    const id = responseId(message);
    if (id === undefined) return;
    this.releaseKey(idKey(id));
  }

  cancel(message: unknown): void {
    const id = requestId(message);
    if (id === undefined) return;
    this.releaseKey(idKey(id));
  }

  releaseAll(): void {
    const releases = [...this.releases.values()];
    this.releases.clear();
    for (const release of releases) release();
  }

  get size(): number {
    return this.releases.size;
  }

  private releaseKey(key: string): void {
    const release = this.releases.get(key);
    if (!release) return;
    this.releases.delete(key);
    release();
  }
}
