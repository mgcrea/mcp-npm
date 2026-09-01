import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { WritesDisabledError } from "#/client/errors";
import type { NpmRegistryClient } from "#/client/registry";
import { wrap } from "#/tools/util";

/**
 * Keep the escape hatch pointed at the registry: at another host it would leak
 * the token, and `..` segments could climb out of the API root.
 */
export const assertSafePath = (path: string): void => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new Error("`path` must be a path, not an absolute URL — the server sets the host.");
  }
  if (path.split("/").includes("..")) {
    throw new Error("`path` must not contain `..` segments.");
  }
};

/** Paths where npm demands a one-time password, so the escape hatch opts in too. */
const OTP_PATHS = [/\/trust(\/|$)/, /^\/-\/npm\/v1\/tokens/, /\/access$/];

export const registerRequestTool = (
  server: McpServer,
  client: NpmRegistryClient,
  allowWrites: boolean,
): void => {
  const methods = allowWrites ? (["GET", "POST", "PUT", "DELETE"] as const) : (["GET"] as const);

  server.registerTool(
    "npm_request",
    {
      title: "npm: Request",
      description:
        "Escape hatch: call any npm registry endpoint directly. Use it when no curated tool " +
        "fits — a personal scope's package list (`/-/user/<username>/package`), the OIDC token " +
        "exchange, or a corner of the API this server does not wrap. `path` is relative to the " +
        "registry root. A one-time password is attached automatically on the paths that need " +
        "one (trust, tokens, access). " +
        (allowWrites
          ? "Writes are ENABLED, so POST/PUT/DELETE are permitted — there is no confirmation " +
            "step here, so check the path before you call it."
          : "Writes are DISABLED: only GET is permitted. Set NPM_ALLOW_WRITES=1 to allow " +
            "mutations."),
      inputSchema: z.object({
        method: z
          .enum(methods)
          .default("GET")
          .describe(
            allowWrites
              ? "HTTP method. POST/PUT/DELETE go through with no confirmation step."
              : "HTTP method. Only GET is available while NPM_ALLOW_WRITES is unset.",
          ),
        path: z
          .string()
          .min(1)
          .describe(
            "Path relative to the registry root, e.g. `/-/whoami`, `/-/npm/v1/user`, " +
              "`/-/user/mgcrea/package`. Scoped package names need escaping in `/-/package/` " +
              "routes: `%40scope%2Fname`.",
          ),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query string parameters."),
        body: z.unknown().optional().describe("JSON request body, for POST/PUT/DELETE."),
      }),
      annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites },
    },
    async ({ method, path, query, body }) =>
      wrap(async () => {
        // Belt and braces: the enum already excludes writes, but a client could
        // hand-roll a call that skips schema validation.
        if (!allowWrites && method !== "GET") {
          throw new WritesDisabledError(`npm_request with method ${method}`);
        }
        assertSafePath(path);
        const resolved = path.startsWith("/") ? path : `/${path}`;
        return client.request(method, resolved, {
          ...(query ? { query } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(OTP_PATHS.some((re) => re.test(resolved)) ? { otp: "auto" as const } : {}),
        });
      }),
  );
};
