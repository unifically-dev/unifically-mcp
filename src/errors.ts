export class UnificallyError extends Error {
  override readonly name = "UnificallyError";
  readonly code: number;
  readonly apiMessage: string;

  constructor(code: number, apiMessage: string) {
    super(apiMessage || `UnificAlly API error ${code}`);
    this.code = code;
    this.apiMessage = apiMessage;
  }
}

export class TaskTimeoutError extends Error {
  override readonly name = "TaskTimeoutError";
  readonly taskId: string;
  constructor(taskId: string, timeoutMs: number) {
    super(`Task ${taskId} did not complete within ${Math.round(timeoutMs / 1000)}s`);
    this.taskId = taskId;
  }
}

export class TaskFailedError extends Error {
  override readonly name = "TaskFailedError";
  readonly taskId: string;
  readonly apiMessage: string;
  constructor(taskId: string, apiMessage: string) {
    super(apiMessage || `Task ${taskId} failed`);
    this.taskId = taskId;
    this.apiMessage = apiMessage;
  }
}

export interface ToolErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}

const POLICY_HINTS = [
  "policy",
  "moderation",
  "safety",
  "rejected",
  "violat",
  "prohibited",
  "nsfw",
];

function isPolicyMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return POLICY_HINTS.some((hint) => lower.includes(hint));
}

// The API answers GET /v1/tasks/<unknown-id> with a misleading 500
// ("Polling URL is not configured for this model") instead of a 404.
// Recognize it so callers get "task not found" rather than a retry hint.
export function isUnknownTaskMessage(message: string): boolean {
  return /polling url is not configured/i.test(message);
}

export function mapErrorToTextMessage(err: unknown): string {
  if (err instanceof UnificallyError) {
    if (isUnknownTaskMessage(err.apiMessage)) {
      return "No task found with that task_id. Check the id — it may be mistyped, expired, or from a different account.";
    }
    switch (err.code) {
      case 401:
        return "UNIFICALLY_API_KEY is missing or invalid. Set it from https://unifically.com/api-keys.";
      case 402:
        return `Insufficient balance. ${err.apiMessage || ""} Top up at https://unifically.com/payments.`.trim();
      case 404:
        return `Not found: ${err.apiMessage}`;
      case 422:
        return `Invalid request: ${err.apiMessage}`;
      case 429:
        return "Rate limit exceeded. Wait a few seconds and retry.";
      default:
        if (err.code >= 500) {
          return `UnificAlly server error (${err.code}): ${err.apiMessage}. Retry shortly.`;
        }
        return `UnificAlly API error (${err.code}): ${err.apiMessage}`;
    }
  }
  if (err instanceof TaskFailedError) {
    if (isPolicyMessage(err.apiMessage)) {
      return (
        `Task ${err.taskId} was rejected by the model's safety/content policy: "${err.apiMessage}". ` +
        "If the prompt was flagged, rephrase it; if a reference image/audio was flagged, replace that input."
      );
    }
    return `Task ${err.taskId} failed: ${err.apiMessage}`;
  }
  if (err instanceof TaskTimeoutError) {
    return `Task did not complete in time. Resume with get_task task_id=${err.taskId}.`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function toolError(err: unknown): ToolErrorResult {
  return {
    isError: true,
    content: [{ type: "text", text: mapErrorToTextMessage(err) }],
  };
}

/**
 * A completed-but-failed task's error_message comes from the model provider.
 * When it mentions credits/quota/points it is the PROVIDER's capacity, not the
 * user's UnificAlly balance (a real balance error is a 402 that blocks creation
 * and never appears as a task error_message). Annotate so read paths — get_task,
 * list_tasks — don't read as "top up your balance".
 */
export function annotateProviderCredit(message: string): string {
  if (/insufficient credit|no credit|not enough credit|quota|insufficient point|not enough point|credit balance|out of credit/i.test(message)) {
    return `${message} — note: this is the model provider's own capacity/quota, NOT your UnificAlly balance (check_balance confirms). Retry later or switch models.`;
  }
  return message;
}
