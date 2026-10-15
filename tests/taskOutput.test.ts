import { describe, expect, it } from "vitest";

import { collectUrls, taskOutput } from "../src/tools/_helpers.js";

describe("taskOutput", () => {
  it("returns the nested output when the task has one", () => {
    expect(taskOutput({ task_id: "t", status: "completed", output: { video_url: "https://x/v.mp4" } })).toEqual({
      video_url: "https://x/v.mp4",
    });
  });

  it("falls back to top-level result fields for Suno-shaped tasks", () => {
    const task = {
      task_id: "t",
      status: "completed" as const,
      audio_url1: "https://files.unifically.com/audio/a.mp3",
      audio_url2: "https://files.unifically.com/audio/b.mp3",
      clips: [
        { id: "c1", audio_url: "https://files.unifically.com/audio/a.mp3", image_url: "https://x/a.jpg" },
        { id: "c2", audio_url: "https://files.unifically.com/audio/b.mp3", image_url: "https://x/b.jpg" },
      ],
    };
    const output = taskOutput(task);
    expect(output.task_id).toBeUndefined();
    expect(output.status).toBeUndefined();
    expect(collectUrls(output, "audio")).toEqual([
      "https://files.unifically.com/audio/a.mp3",
      "https://files.unifically.com/audio/b.mp3",
    ]);
  });
});
