import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError } from "#/client/errors";
import type { NpmRegistryClient } from "#/client/registry";
import { isRecord } from "#/client/shape";
import { packageArg, wrap } from "#/tools/util";

/** npm's own documented ceiling for the comma-separated bulk form. */
const BULK_MAX = 128;

const periodArg = z
  .string()
  .default("last-week")
  .describe(
    'A period: "last-day", "last-week", "last-month", "last-year", or an explicit range ' +
      '"YYYY-MM-DD:YYYY-MM-DD". npm keeps roughly 18 months of history.',
  );

export const registerDownloadTools = (server: McpServer, client: NpmRegistryClient): void => {
  server.registerTool(
    "npm_get_downloads",
    {
      title: "npm: Get Downloads",
      description:
        "Download counts for one or more packages. One package returns a total (or a daily " +
        "series with `daily: true`). Several packages return a total each in a single call — " +
        "but note npm's bulk form is a genuinely different endpoint: it caps at 128 packages, " +
        "supports totals only (never a daily series), and REJECTS scoped names, so " +
        "`@scope/name` has to be queried on its own.",
      inputSchema: z.object({
        packages: z
          .array(packageArg)
          .min(1)
          .describe("One or more package names. See the note above about scoped names in bulk."),
        period: periodArg,
        daily: z
          .boolean()
          .default(false)
          .describe(
            "Return a per-day series instead of a total. Single package only — npm's bulk " +
              "endpoint cannot do it.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ packages, period, daily }) =>
      wrap(async () => {
        if (packages.length > BULK_MAX) {
          throw new PreconditionError(
            `npm's bulk downloads endpoint accepts at most ${BULK_MAX} packages; ${packages.length} were given.`,
            { remedy: `Split the list into batches of ${BULK_MAX}.` },
          );
        }

        if (packages.length > 1) {
          const scoped = packages.filter((p) => p.startsWith("@"));
          if (scoped.length > 0) {
            throw new PreconditionError(
              "npm's bulk downloads endpoint does not support scoped packages.",
              {
                scoped,
                remedy:
                  "Query each scoped package on its own — the single-package form handles " +
                  "`@scope/name` fine.",
              },
            );
          }
          if (daily) {
            throw new PreconditionError(
              "A per-day series is only available for one package at a time.",
              { remedy: "Set daily=false, or pass a single package." },
            );
          }
          return client.downloads(`/downloads/point/${period}/${packages.join(",")}`);
        }

        const only = packages[0] as string;
        const kind = daily ? "range" : "point";
        // Scoped names go through unencoded here: this API keys on the literal
        // `@scope/name`, unlike the registry's `/-/package/` routes.
        return client.downloads(`/downloads/${kind}/${period}/${only}`);
      }),
  );

  server.registerTool(
    "npm_get_version_downloads",
    {
      title: "npm: Get Version Downloads",
      description:
        "Last week's downloads broken down by version — the way to see how much traffic still " +
        "goes to an old major before dropping support for it. This endpoint is live but is not " +
        "in npm's published API spec, so treat it as unofficial and expect it to move without " +
        "notice. Only the last week is available; there is no range form.",
      inputSchema: z.object({ package: packageArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ package: pkg }) =>
      wrap(async () => {
        const body = await client.downloads<unknown>(`/versions/${pkg}/last-week`);
        if (!isRecord(body) || !isRecord(body.downloads)) return body;
        // Sort by count: the list is one line per version and the interesting
        // ones are always the busiest few, not the numerically first.
        const entries = Object.entries(body.downloads)
          .filter((entry): entry is [string, number] => typeof entry[1] === "number")
          .toSorted((a, b) => b[1] - a[1]);
        return {
          package: body.package,
          version_count: entries.length,
          total: entries.reduce((sum, [, n]) => sum + n, 0),
          downloads: Object.fromEntries(entries),
        };
      }),
  );
};
