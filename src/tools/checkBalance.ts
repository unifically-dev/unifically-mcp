import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toolError } from "../errors.js";
import { getAccount } from "../unifically.js";
import type { ToolResult } from "./_helpers.js";

export function registerCheckBalance(server: McpServer): void {
  server.registerTool(
    "check_balance",
    {
      // No vendor name in the title. The client already namespaces every tool
      // under this server, so "Check UnificAlly balance" renders as the name
      // twice; the tool is identified by where it comes from, not by saying so.
      title: "Check balance",
      description:
        "Return the account's current balance in USD. Takes no parameters.",
      inputSchema: z.object({}).strict(),
      annotations: {
        title: "Check balance",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (): Promise<ToolResult> => {
      try {
        const account = await getAccount();
        return {
          content: [
            {
              type: "text",
              text: `Balance: $${account.balance_usd.toFixed(2)} (${account.email}).`,
            },
          ],
          structuredContent: {
            user_id: account.user_id,
            email: account.email,
            balance_usd: account.balance_usd,
          },
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
