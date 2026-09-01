import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { NpmRegistryClient } from "#/client/registry";
import { summarizeAdvisoryResponse } from "#/client/shape";
import { wrap } from "#/tools/util";

/**
 * Registered unconditionally, with no credentials at all: npm's bulk advisory
 * endpoint takes no authentication. That is worth keeping — it means an
 * unconfigured server is still useful for something real rather than being a
 * setup guide and nothing else.
 */
export const registerSecurityTools = (server: McpServer, client: NpmRegistryClient): void => {
  server.registerTool(
    "npm_audit_dependencies",
    {
      title: "npm: Audit Dependencies",
      description:
        "Check a set of package versions against npm's security advisories — the same data " +
        "`npm audit` uses, queried directly. Takes a flat map of package name to the versions " +
        "you have installed, and returns only the packages with advisories against them. Needs " +
        "no npm token, so it works on an otherwise unconfigured server. The `references` field " +
        "is stripped from each advisory: it is about 1.5 KB of markdown links apiece, and `url` " +
        "already points at the write-up.",
      inputSchema: z.object({
        dependencies: z
          .record(z.string(), z.array(z.string().min(1)).min(1))
          .describe(
            'Installed versions per package, e.g. {"lodash": ["4.17.20"], "minimist": ' +
              '["1.2.0", "0.0.8"]}. Exact versions, not ranges — an advisory match is computed ' +
              "against the version you actually have.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ dependencies }) =>
      wrap(async () =>
        summarizeAdvisoryResponse(
          await client.post("/-/npm/v1/security/advisories/bulk", dependencies, {
            anonymous: true,
          }),
        ),
      ),
  );
};
