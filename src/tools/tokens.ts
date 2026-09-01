import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { NpmRegistryClient } from "#/client/registry";
import { summarizePaginated, summarizeToken } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { compact, confirmArg, wrap } from "#/tools/util";

export const registerTokenTools = (
  server: McpServer,
  client: NpmRegistryClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "npm_list_tokens",
    {
      title: "npm: List Tokens",
      description:
        "The access tokens on this npm account, with their key, permissions, CIDR restrictions " +
        "and expiry. Token values come back redacted — npm shows the full value only once, at " +
        "creation. Watch the `bypass_2fa` column: a token with it set is refused by every " +
        "trusted-publisher write, which is the most common reason those fail. NOTE: session " +
        "token only — a granular access token cannot read this list at all.",
      inputSchema: z.object({
        per_page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe("Tokens per page (1-100). Follow the returned `next` for more."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ per_page }) =>
      wrap(async () =>
        summarizePaginated(
          await client.get("/-/npm/v1/tokens", { perPage: per_page }),
          summarizeToken,
        ),
      ),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "npm_create_token",
    {
      title: "npm: Create Token",
      description:
        "Create an npm access token. THE VALUE IS RETURNED ONCE AND NEVER AGAIN — capture it " +
        "from this response or the token is only revocable, not usable. Prefer trusted " +
        "publishing over creating a CI token at all: it needs no stored secret. If you do need " +
        "one, leave `bypass_2fa` off — npm refuses such tokens for every trusted-publisher " +
        "write and for most account operations.",
      inputSchema: z.object({
        password: z
          .string()
          .min(1)
          .describe(
            "Your npm account password. npm requires it to mint a token; it is sent to the " +
              "registry and not stored by this server.",
          ),
        name: z
          .string()
          .min(1)
          .describe('A name you will recognise later, e.g. "ci-release-2026".'),
        readonly: z
          .boolean()
          .default(true)
          .describe("Read-only unless you say otherwise. A read-write token can publish."),
        cidr: z
          .array(z.string())
          .optional()
          .describe('Restrict the token to these CIDR ranges, e.g. ["10.0.0.0/8"].'),
        expires_days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe(
            "Lifetime in days. npm caps a read-write token at 90 days and defaults to 7; " +
              "read-only tokens may live longer.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ password, name, readonly, cidr, expires_days }) =>
      wrap(async () => {
        const created = await client.post<Record<string, unknown>>(
          "/-/npm/v1/tokens",
          compact({ password, name, readonly, cidr, expires: expires_days }),
          { otp: "auto", command: "token" },
        );
        return {
          ...created,
          warning:
            "This is the only time npm will show the token value. Store it now — it cannot be " +
            "retrieved again, only revoked.",
        };
      }),
  );

  server.registerTool(
    "npm_revoke_token",
    {
      title: "npm: Revoke Token",
      description:
        "Revoke an access token by its key. Anything using it stops working immediately, " +
        "including CI. The key is the `key` field from npm_list_tokens, NOT the token value.",
      inputSchema: z.object({
        key: z
          .string()
          .min(1)
          .describe("The token's `key` from npm_list_tokens. Not the `npm_...` value itself."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ key }) =>
      wrap(async () => {
        await client.del(`/-/npm/v1/tokens/token/${encodeURIComponent(key)}`, undefined, {
          otp: "auto",
          command: "token",
        });
        return { key, revoked: true };
      }),
  );
};
