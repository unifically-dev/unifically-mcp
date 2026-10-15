import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSafeLocalMedia } from "../src/tools/uploadFile.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "unifically-upload-test-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("local file upload safety", () => {
  it("accepts a media file whose signature matches its extension", async () => {
    const path = join(root, "reference.png");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await writeFile(path, png);
    expect((await readSafeLocalMedia(path)).data).toEqual(png);
  });

  it("refuses a secret/config file merely renamed with a media extension", async () => {
    const path = join(root, "reference.png");
    await writeFile(path, "UNIFICALLY_API_KEY=secret");
    await expect(readSafeLocalMedia(path)).rejects.toThrow(/bytes must match|credential/i);
  });

  it("refuses even valid-looking media from a credential directory", async () => {
    const dir = join(root, ".ssh");
    await mkdir(dir);
    const path = join(dir, "reference.png");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(readSafeLocalMedia(path)).rejects.toThrow(/credential|secrets directory/i);
  });

  it("refuses non-media extensions", async () => {
    const path = join(root, "private.pem");
    await writeFile(path, "-----BEGIN PRIVATE KEY-----");
    await expect(readSafeLocalMedia(path)).rejects.toThrow(/image, video, or audio/i);
  });
});
