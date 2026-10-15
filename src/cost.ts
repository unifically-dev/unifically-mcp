import { getConfig } from "./config.js";
import { dryRunTask, type RequestContext } from "./unifically.js";

export interface CostGateInput {
  model: string;
  input: Record<string, unknown>;
  confirm_cost?: boolean;
}

export interface CostQuote {
  status: "needs_confirmation";
  model: string;
  cost_usd: number;
  threshold_usd: number;
  message: string;
}

/**
 * Optional spend guard. Disabled by default (confirmCostAbove === null): the
 * generation runs in a single step. When the operator sets
 * UNIFICALLY_CONFIRM_COST_ABOVE, calls above that dry-run cost return a quote
 * and must be retried with confirm_cost=true.
 */
export async function runCostGate(
  args: CostGateInput,
  ctx: RequestContext = {},
): Promise<CostQuote | null> {
  const cfg = getConfig();
  // A dry-run is needed if either guard is active. The hard cap always needs
  // it; the confirm gate needs it only when the caller hasn't pre-confirmed.
  const confirmActive = cfg.confirmCostAbove !== null && args.confirm_cost !== true;
  if (cfg.maxCostPerTask === null && !confirmActive) return null;

  // A hard cap makes the dry-run mandatory, so confirm_cost cannot skip it —
  // only advertise that bypass when the confirm gate is the sole reason.
  const capActive = cfg.maxCostPerTask !== null;
  const bypassHint = capActive
    ? "This server enforces a hard cost cap, so the price check is mandatory — pick a different/cheaper model or fix the request; confirm_cost will not skip it."
    : "If the request itself is valid, retry with confirm_cost: true to skip the price check.";

  let cost: number;
  try {
    const result = await dryRunTask({ model: args.model, input: args.input }, ctx);
    cost = result.cost;
  } catch (err) {
    // The pre-check failing must not read as "the generation is broken" —
    // and it must not silently skip the gate either. Tell the agent exactly
    // what failed and how to proceed.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `The cost pre-check (dry run) failed before any task was created: ${reason} No money was spent. ${bypassHint}`,
    );
  }
  if (typeof cost !== "number" || !Number.isFinite(cost)) {
    throw new Error(
      `The cost pre-check returned an unexpected response for ${args.model} (no cost figure). No task should have been created. ${bypassHint}`,
    );
  }

  // Hard cap: a firm ceiling the caller CANNOT bypass with confirm_cost.
  if (cfg.maxCostPerTask !== null && cost > cfg.maxCostPerTask) {
    throw new Error(
      `This generation would cost $${cost.toFixed(4)}, above this server's hard limit of $${cfg.maxCostPerTask.toFixed(2)} per task — it was not run and nothing was charged. ` +
        `Use a cheaper model or lower settings (e.g. smaller resolution/duration), or ask the operator to raise the limit.`,
    );
  }

  // Confirm threshold: bypassable with confirm_cost: true.
  if (cfg.confirmCostAbove === null || args.confirm_cost === true || cost <= cfg.confirmCostAbove) return null;

  return {
    status: "needs_confirmation",
    model: args.model,
    cost_usd: cost,
    threshold_usd: cfg.confirmCostAbove,
    message:
      `This request needs confirmation (dry-run cost $${cost.toFixed(4)}, ` +
      `above the $${cfg.confirmCostAbove.toFixed(2)} confirm threshold). ` +
      `Ask the user, then call again with the SAME arguments plus confirm_cost: true to proceed.`,
  };
}
