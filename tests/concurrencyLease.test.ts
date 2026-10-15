import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { MessageConcurrencyGate, releaseOnResponseClose, SseRequestLeaseTracker } from "../src/concurrency.js";

describe("in-flight message lease", () => {
  it("releases immediately when the client disconnects", () => {
    const response = new EventEmitter();
    const releaseReservation = vi.fn();
    releaseOnResponseClose(response, releaseReservation);

    response.emit("close");

    expect(releaseReservation).toHaveBeenCalledTimes(1);
  });

  it("does not double-release when close races with finally cleanup", () => {
    const response = new EventEmitter();
    const releaseReservation = vi.fn();
    const release = releaseOnResponseClose(response, releaseReservation);

    response.emit("close");
    release();
    response.emit("close");

    expect(releaseReservation).toHaveBeenCalledTimes(1);
  });

  it("removes the close listener after normal completion", () => {
    const response = new EventEmitter();
    const releaseReservation = vi.fn();
    const release = releaseOnResponseClose(response, releaseReservation);

    release();
    response.emit("close");

    expect(releaseReservation).toHaveBeenCalledTimes(1);
    expect(response.listenerCount("close")).toBe(0);
  });
});

describe("legacy SSE request leases", () => {
  const request = (id: string | number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: {} });
  const result = (id: string | number) => ({ jsonrpc: "2.0", id, result: {} });

  it("holds a request until its matching SSE response is sent", () => {
    const tracker = new SseRequestLeaseTracker();
    const release = vi.fn();

    expect(tracker.track(request(7), release)).toBe("tracked");
    expect(tracker.size).toBe(1);
    expect(release).not.toHaveBeenCalled();

    tracker.complete(result(7));
    expect(release).toHaveBeenCalledTimes(1);
    expect(tracker.size).toBe(0);
  });

  it("keeps numeric and string request ids distinct", () => {
    const tracker = new SseRequestLeaseTracker();
    const numeric = vi.fn();
    const textual = vi.fn();
    expect(tracker.track(request(1), numeric)).toBe("tracked");
    expect(tracker.track(request("1"), textual)).toBe("tracked");

    tracker.complete(result(1));
    expect(numeric).toHaveBeenCalledTimes(1);
    expect(textual).not.toHaveBeenCalled();
    tracker.complete(result("1"));
    expect(textual).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate in-flight ids without replacing the original lease", () => {
    const tracker = new SseRequestLeaseTracker();
    const original = vi.fn();
    const duplicate = vi.fn();
    expect(tracker.track(request("same"), original)).toBe("tracked");
    expect(tracker.track(request("same"), duplicate)).toBe("duplicate");

    tracker.complete(result("same"));
    expect(original).toHaveBeenCalledTimes(1);
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("releases all outstanding requests when the SSE stream closes", () => {
    const tracker = new SseRequestLeaseTracker();
    const releases = [vi.fn(), vi.fn(), vi.fn()];
    releases.forEach((release, id) => tracker.track(request(id), release));

    tracker.releaseAll();
    tracker.releaseAll();
    releases.forEach((release) => expect(release).toHaveBeenCalledTimes(1));
    expect(tracker.size).toBe(0);
  });

  it("does not hold notifications or client responses", () => {
    const tracker = new SseRequestLeaseTracker();
    const release = vi.fn();
    expect(tracker.track({ jsonrpc: "2.0", method: "notifications/initialized" }, release)).toBe("notification");
    expect(tracker.track({ jsonrpc: "2.0", id: 3, result: {} }, release)).toBe("notification");
    expect(tracker.size).toBe(0);
  });
});

describe("message concurrency gate", () => {
  it("enforces one account limit across several API keys", () => {
    const gate = new MessageConcurrencyGate(100, 16, 16);
    const a = gate.reserve("key-a", "user-1", 8);
    const b = gate.reserve("key-b", "user-1", 8);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(gate.reserve("key-c", "user-1", 1)).toMatchObject({ ok: false, scope: "user" });
    expect(gate.reserve("key-c", "user-2", 1).ok).toBe(true);
  });

  it("enforces per-key and global limits independently", () => {
    const gate = new MessageConcurrencyGate(3, 2, 3);
    expect(gate.reserve("key-a", "user-a", 2).ok).toBe(true);
    expect(gate.reserve("key-a", "user-b", 1)).toMatchObject({ ok: false, scope: "key" });
    expect(gate.reserve("key-b", "user-b", 1).ok).toBe(true);
    expect(gate.reserve("key-c", "user-c", 1)).toMatchObject({ ok: false, scope: "global" });
  });

  it("releases a multi-message reservation exactly once and removes identities", () => {
    const gate = new MessageConcurrencyGate(16, 16, 16);
    const reservation = gate.reserve("key", "user", 16);
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error("expected reservation");
    expect(gate.snapshot()).toEqual({ total: 16, keys: 1, users: 1 });

    reservation.release();
    reservation.release();
    expect(gate.snapshot()).toEqual({ total: 0, keys: 0, users: 0 });
    expect(gate.reserve("key", "user", 16).ok).toBe(true);
  });

  it("returns to zero after heavily interleaved reservations and releases", () => {
    const gate = new MessageConcurrencyGate(256, 16, 16);
    for (let round = 0; round < 100; round++) {
      const leases: Array<() => void> = [];
      for (let i = 0; i < 16; i++) {
        const reservation = gate.reserve(`key-${i % 4}`, `user-${i % 8}`, 1);
        expect(reservation.ok).toBe(true);
        if (reservation.ok) leases.push(reservation.release);
      }
      leases.filter((_, i) => i % 2 === 0).forEach((release) => release());
      leases.filter((_, i) => i % 2 === 1).reverse().forEach((release) => release());
      expect(gate.snapshot()).toEqual({ total: 0, keys: 0, users: 0 });
    }
  });

  it("rejects invalid reservation counts without mutating state", () => {
    const gate = new MessageConcurrencyGate(16, 16, 16);
    expect(() => gate.reserve("key", "user", 0)).toThrow(RangeError);
    expect(() => gate.reserve("key", "user", Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(gate.snapshot()).toEqual({ total: 0, keys: 0, users: 0 });
  });
});
