import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getConfig } from "../config.js";
import { annotateProviderCredit, TaskFailedError, TaskTimeoutError, toolError } from "../errors.js";
import { taskIdSchema } from "../schemas.js";
import { getTask, waitForTask, type GetTaskResponse } from "../unifically.js";
import { collectUrls, outputFallbackText, taskOutput, type ToolResult } from "./_helpers.js";
import { fenceUntrusted, sanitizeUntrusted } from "../untrusted.js";

const inputShape = {
  task_id: taskIdSchema,
  wait: z
    .boolean()
    .optional()
    .describe(
      "Set true to block until the task reaches a final state (completed/failed) and return the result, instead of returning the current status immediately.",
    ),
};

const inputSchema = z.object(inputShape).strict();

function describe(task: GetTaskResponse, waitExpired = false): string {
  if (task.status === "completed") {
    const output = taskOutput(task);
    const urls = collectUrls(output);
    if (urls.length === 1) return `Task ${task.task_id} completed. Result: ${urls[0]}`;
    if (urls.length > 1) {
      const shown = urls.slice(0, 6);
      const more = urls.length > shown.length ? ` (+${urls.length - shown.length} more in output)` : "";
      return `Task ${task.task_id} completed. ${urls.length} outputs:\n${shown.join("\n")}${more}`;
    }
    if (typeof output.text === "string" && output.text) {
      const preview = output.text.length > 280 ? `${output.text.slice(0, 280)}…` : output.text;
      const note = output.text.length > 280 ? ` (full ${output.text.length}-char text in output.text)` : "";
      // Same provenance as the transcript path in _helpers.summarize: this text
      // came from third-party audio, so fence it rather than echoing it raw.
      return `Task ${task.task_id} completed${note}.\n${fenceUntrusted("transcript", sanitizeUntrusted(preview, 300))}`;
    }
    return `Task ${task.task_id} completed. ${outputFallbackText(output)}`;
  }
  if (task.status === "failed") {
    return `Task ${task.task_id} failed: ${annotateProviderCredit(task.error_message ?? "unknown error")}`;
  }
  const expiredNote = waitExpired
    ? "The wait window expired while it was still running (long jobs are normal) — "
    : "";
  return `Task ${task.task_id} is ${task.status}. ${expiredNote}call get_task again (optionally wait:true) until status is "completed" or "failed". Do NOT re-run the generation.`;
}

export function registerGetTask(server: McpServer): void {
  server.registerTool(
    "get_task",
    {
      title: "Get task status",
      description:
        "Get the status and (if completed) output URL of a task by id. Use to resume after a webhook, a polling timeout, " +
        "or a generation started with wait:false. Pass wait:true to block until it finishes.",
      inputSchema: inputSchema,
      annotations: {
        title: "Get task status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawArgs): Promise<ToolResult> => {
      const args = inputSchema.parse(rawArgs);
      try {
        let task: GetTaskResponse;
        let waitExpired = false;
        if (args.wait) {
          const cfg = getConfig();
          const budgetCap = cfg.transport === "http" ? cfg.httpWaitBudgetMs : cfg.stdioWaitBudgetMs;
          const budget = Math.min(budgetCap, cfg.pollTimeoutMs);
          try {
            task = await waitForTask(args.task_id, {}, budget);
          } catch (err) {
            // Budget expiry isn't an error — report current status so the
            // caller can keep polling. A failed task is reported the same
            // structured way as the non-wait path.
            if (err instanceof TaskTimeoutError || err instanceof TaskFailedError) {
              waitExpired = err instanceof TaskTimeoutError;
              // Bounded read so this trailing call can't push the response past
              // the proxy cutoff (it isn't counted against the wait budget).
              task = await getTask(args.task_id, {}, { timeoutMs: 8000, maxRetries: 0 });
            } else {
              throw err;
            }
          }
        } else {
          task = await getTask(args.task_id);
        }
        return {
          content: [{ type: "text", text: describe(task, waitExpired) }],
          structuredContent: task as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
