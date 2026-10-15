import { describe, expect, it } from "vitest";

import { screenPassthroughValues } from "../src/tools/_helpers.js";

/**
 * provider_options and dry_run_cost's `input` are passthrough bags merged into
 * the API payload verbatim. Removing the base64 PARAMETER from upload_file did
 * not close them: `provider_options: { image_b64: "<raw>" }` was a working
 * base64 upload that bypassed every gate — verified reaching POST /v1/tasks.
 *
 * That is the same channel we deleted for making agents degrade the user's file,
 * so it has to be shut here too. The named media params are screened by
 * resolveMediaRef; these tests cover the open bags.
 */

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
const RAW_B64 = PNG.repeat(40); // >=200 chars of pure base64 alphabet
const DATA_URI = `data:image/png;base64,${PNG}`;

const screen = (bag: Record<string, unknown>) => screenPassthroughValues(bag, "provider_options");

describe("inline file data cannot ride in through a passthrough bag", () => {
  it("blocks raw base64 under an unmanaged key", () => {
    const r = screen({ image_b64: RAW_B64 });
    expect(r?.isError).toBe(true);
    // Must name the way out (the keyless upload flow), not just refuse.
    expect(JSON.stringify(r)).toMatch(/content_type|upload_url/i);
  });

  it("blocks base64 nested in an object", () => {
    expect(screen({ image: { b64_json: RAW_B64 } })?.isError).toBe(true);
  });

  it("blocks base64 nested in an array", () => {
    expect(screen({ frames: [{ data: RAW_B64 }] })?.isError).toBe(true);
  });

  it("blocks a data: URI under any key", () => {
    expect(screen({ whatever: DATA_URI })?.isError).toBe(true);
    expect(screen({ deep: { nested: { src: DATA_URI } } })?.isError).toBe(true);
  });

  it("names the direct upload rather than just refusing", () => {
    const text = JSON.stringify(screen({ image_b64: RAW_B64 }));
    expect(text).toMatch(/curl -X PUT/);
    expect(text.toLowerCase()).toMatch(/shrunk|degrade|full quality/);
  });
});

describe("legitimate provider_options still pass", () => {
  it("allows ordinary scalars and short strings", () => {
    expect(screen({ seed: 42, cfg_scale: 7.5, style: "anime", aspect_ratio: "16:9", negative: "blurry" })).toBeNull();
  });

  it("allows public URLs", () => {
    expect(screen({ image_url: "https://cdn.example.com/a.png" })).toBeNull();
  });

  it("does not misfire on long non-base64 text", () => {
    // A long prompt contains spaces/punctuation, so it is not a base64 run.
    expect(screen({ prompt: "a very ".repeat(60) + "long descriptive prompt, with punctuation!" })).toBeNull();
  });

  it("does not misfire on ids, tokens, or hashes under 200 chars", () => {
    expect(screen({ task_id: "5b96f3bc-b045-4ffd-82f0-ddf9721c1463" })).toBeNull();
    expect(screen({ hash: "a".repeat(64) })).toBeNull(); // sha256 hex
    expect(screen({ clip_id: "abc123XYZ_-" })).toBeNull();
  });
});

describe("passthrough validation budget fails closed", () => {
  it("rejects more than 1,000 visited items", () => {
    const result = screen({ values: Array.from({ length: 1_001 }, (_, i) => i) });
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/too large|1000 items/i);
  });

  it("rejects nesting beyond 16 levels", () => {
    let value: unknown = "safe";
    for (let i = 0; i < 18; i++) value = { nested: value };
    expect(screen({ value })?.isError).toBe(true);
  });

  it("cannot hide an unsafe URL beyond the scan budget", () => {
    const result = screen({ values: [...Array.from({ length: 1_001 }, () => "ok"), "http://169.254.169.254/"] });
    expect(result?.isError).toBe(true);
  });
});
