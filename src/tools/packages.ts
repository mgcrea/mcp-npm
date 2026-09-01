import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError } from "#/client/errors";
import { escapePackageName, packumentPath, type NpmRegistryClient } from "#/client/registry";
import {
  isRecord,
  summarizePackument,
  summarizeSearchResponse,
  summarizeVersion,
  summarizeVersionTimes,
  type Rec,
} from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { compact, confirmArg, packageArg, versionArg, wrap } from "#/tools/util";

/**
 * The media type that makes npm return the *abbreviated* packument: names,
 * dist-tags and a three-field stub per version. A full packument for a popular
 * package is megabytes — mostly the rendered README and one complete metadata
 * document per version — so anything that only needs the version list asks for
 * this instead.
 */
const ABBREVIATED = "application/vnd.npm.install-v1+json";

export const registerPackageTools = (
  server: McpServer,
  client: NpmRegistryClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "npm_whoami",
    {
      title: "npm: Whoami",
      description:
        "Which npm account this server's token belongs to. Cheap, and the fastest way to check " +
        "a token works at all. npm_auth_status reports the same thing plus what the token can do.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => client.get("/-/whoami")),
  );

  server.registerTool(
    "npm_get_package",
    {
      title: "npm: Get Package",
      description:
        "Everything worth knowing about a published package: dist-tags, the full version list, " +
        "the latest version's dependencies and metadata, and when it was first and last " +
        "published. The README, the per-version metadata documents and npm's internal " +
        "bookkeeping are stripped — a raw packument runs to megabytes for a popular package. " +
        "Use npm_get_package_version for one specific version's full detail, and " +
        "npm_list_versions when you only need the version numbers.",
      inputSchema: z.object({
        package: packageArg,
        include_publish_times: z
          .boolean()
          .default(false)
          .describe(
            "Add a `{version: publishedAt}` map. Off by default: it is one line per version, " +
              "so a package with 400 releases spends 400 lines on it.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ package: pkg, include_publish_times }) =>
      wrap(async () => {
        const packument = await client.get<unknown>(packumentPath(pkg));
        const summary = summarizePackument(packument);
        if (!include_publish_times) return summary;
        return { ...(summary as Rec), publish_times: summarizeVersionTimes(packument) };
      }),
  );

  server.registerTool(
    "npm_get_package_version",
    {
      title: "npm: Get Package Version",
      description:
        "One published version in full: its dependencies, peer dependencies, engines, bin " +
        "entries, license, deprecation status and tarball. `version` accepts a dist-tag like " +
        '"latest" or "next" as well as an exact number, but NOT a semver range.',
      inputSchema: z.object({
        package: packageArg,
        version: z
          .string()
          .min(1)
          .default("latest")
          .describe('An exact version ("4.17.21") or a dist-tag ("latest", "next"). Not a range.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ package: pkg, version }) =>
      wrap(async () => {
        const doc = await client.get<unknown>(
          `${packumentPath(pkg)}/${encodeURIComponent(version)}`,
        );
        return isRecord(doc) ? summarizeVersion(doc) : doc;
      }),
  );

  server.registerTool(
    "npm_list_versions",
    {
      title: "npm: List Versions",
      description:
        "Just the published version numbers and the dist-tags pointing into them. Uses npm's " +
        "abbreviated packument, so this is far cheaper than npm_get_package on a package with " +
        "hundreds of releases — reach for it when the question is 'what versions exist'.",
      inputSchema: z.object({ package: packageArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ package: pkg }) =>
      wrap(async () => {
        const packument = await client.get<unknown>(packumentPath(pkg), undefined, {
          accept: ABBREVIATED,
        });
        const versions =
          isRecord(packument) && isRecord(packument.versions) ? packument.versions : {};
        return {
          name: isRecord(packument) ? packument.name : pkg,
          "dist-tags": isRecord(packument) ? packument["dist-tags"] : {},
          version_count: Object.keys(versions).length,
          versions: Object.keys(versions),
        };
      }),
  );

  server.registerTool(
    "npm_search_packages",
    {
      title: "npm: Search Packages",
      description:
        "Search the registry. `text` takes npm's qualifiers as well as plain words: " +
        "`author:sindresorhus`, `maintainer:mgcrea`, `scope:babel`, `keywords:cli,tool` " +
        "(comma is OR, `+` is AND, `,-` excludes), `not:unstable`, `not:insecure`. Note these " +
        "BIAS the ranking rather than filtering strictly — a `scope:` search still returns other " +
        "scopes further down, so read the names rather than trusting the qualifier. Scores and " +
        "maintainer lists are stripped; the ranking is already the result order.",
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .describe('Search text, e.g. "mcp server" or "scope:mgcrea keywords:mcp".'),
        size: z
          .number()
          .int()
          .min(1)
          .max(250)
          .default(20)
          .describe("How many results to return (1-250). Defaults to 20."),
        from: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Offset for paging. npm's search pages by offset, not a cursor."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ text, size, from }) =>
      wrap(async () =>
        summarizeSearchResponse(await client.get("/-/v1/search", { text, size, from })),
      ),
  );

  server.registerTool(
    "npm_get_dist_tags",
    {
      title: "npm: Get Dist Tags",
      description:
        'The package\'s dist-tags as a flat `{tag: version}` map — "latest" plus whatever else ' +
        'the maintainers publish under ("next", "beta", "canary").',
      inputSchema: z.object({ package: packageArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ package: pkg }) =>
      wrap(() => client.get(`/-/package/${escapePackageName(pkg)}/dist-tags`)),
  );

  server.registerTool(
    "npm_get_package_visibility",
    {
      title: "npm: Get Package Visibility",
      description:
        "Whether a package is public or private. NOTE: npm accepts only a session token from " +
        "`npm login` on this endpoint — a granular access token is refused, so this read can " +
        "fail where a corresponding write succeeds. npm_auth_status reports which kind you have.",
      inputSchema: z.object({ package: packageArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ package: pkg }) =>
      wrap(() => client.get(`/-/package/${escapePackageName(pkg)}/visibility`)),
  );

  server.registerTool(
    "npm_list_collaborators",
    {
      title: "npm: List Collaborators",
      description:
        'Who can write to a package, as `{username: "read-write" | "read-only"}`. NOTE: session ' +
        "token only — a granular access token is refused here, the same way it is for " +
        "npm_get_package_visibility.",
      inputSchema: z.object({ package: packageArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ package: pkg }) =>
      wrap(() => client.get(`/-/package/${escapePackageName(pkg)}/collaborators`)),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "npm_add_dist_tag",
    {
      title: "npm: Add Dist Tag",
      description:
        'Point a dist-tag at a version. Moving "latest" changes what a plain `npm install ' +
        "<pkg>` resolves to for everyone, immediately — that is a publishing decision, not a " +
        "label change. The version must already be published.",
      inputSchema: z.object({
        package: packageArg,
        tag: z
          .string()
          .min(1)
          .regex(
            /^[a-zA-Z][a-zA-Z0-9._-]*$/,
            "A dist-tag must start with a letter and cannot look like a semver version.",
          )
          .describe('The tag to set, e.g. "next" or "latest".'),
        version: versionArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ package: pkg, tag, version }) =>
      wrap(async () => {
        // The body is the bare version string as JSON — `"1.2.3"`, not an
        // object. npm rejects anything else with an unhelpful 400.
        await client.put(
          `/-/package/${escapePackageName(pkg)}/dist-tags/${encodeURIComponent(tag)}`,
          version,
          { otp: "auto", command: "dist-tag" },
        );
        return { package: pkg, tag, version, ok: true };
      }),
  );

  server.registerTool(
    "npm_remove_dist_tag",
    {
      title: "npm: Remove Dist Tag",
      description:
        "Delete a dist-tag. Anyone installing `<pkg>@<tag>` starts failing straight away. npm " +
        'refuses to remove "latest", since every package must have one.',
      inputSchema: z.object({
        package: packageArg,
        tag: z.string().min(1).describe('The tag to remove. Cannot be "latest".'),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ package: pkg, tag }) =>
      wrap(async () => {
        if (tag === "latest") {
          throw new PreconditionError(
            'The "latest" dist-tag cannot be removed — every package must have one.',
            { remedy: "Use npm_add_dist_tag to point it at a different version instead." },
          );
        }
        await client.del(
          `/-/package/${escapePackageName(pkg)}/dist-tags/${encodeURIComponent(tag)}`,
          undefined,
          { otp: "auto", command: "dist-tag" },
        );
        return { package: pkg, tag, removed: true };
      }),
  );

  server.registerTool(
    "npm_deprecate_package",
    {
      title: "npm: Deprecate Package",
      description:
        "Attach a deprecation warning to one or all versions. Everyone installing them sees the " +
        "message. This is the REVERSIBLE alternative to unpublishing and is almost always what " +
        "is actually wanted — pass an empty `message` to UNdeprecate. Note npm has no " +
        "deprecate endpoint: this reads the whole package document, edits it and writes it " +
        "back, so it is a heavier call than it looks.",
      inputSchema: z.object({
        package: packageArg,
        message: z
          .string()
          .describe(
            'The warning to show, e.g. "Use @scope/newpkg instead". An EMPTY string removes an ' +
              "existing deprecation.",
          ),
        version: z
          .string()
          .optional()
          .describe(
            "A single version to deprecate. Omit to apply the message to EVERY published " +
              "version, which is how a whole package is deprecated.",
          ),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ package: pkg, message, version }) =>
      wrap(async () => {
        // `?write=true` bypasses npm's edge cache and returns the document with
        // the `_rev` a write needs. This document must NOT be shaped — it is
        // written straight back, and a summarized packument would destroy the
        // package.
        const doc = await client.get<Rec>(packumentPath(pkg), { write: "true" });
        const versions = isRecord(doc.versions) ? doc.versions : {};
        const targets = version ? [version] : Object.keys(versions);

        if (version && !versions[version]) {
          throw new PreconditionError(`${pkg} has no published version ${version}.`, {
            available: Object.keys(versions).slice(-10),
          });
        }

        for (const name of targets) {
          const entry = versions[name];
          if (!isRecord(entry)) continue;
          if (message === "") delete entry.deprecated;
          else entry.deprecated = message;
        }

        await client.put(packumentPath(pkg), doc, { otp: "auto", command: "deprecate" });
        return {
          package: pkg,
          action: message === "" ? "undeprecated" : "deprecated",
          versions: targets.length,
          ...(message !== "" ? { message } : {}),
        };
      }),
  );

  server.registerTool(
    "npm_set_package_access",
    {
      title: "npm: Set Package Access",
      description:
        "Change a package's visibility, or the two-factor requirement for publishing it. " +
        "Making a public package private removes it from public view and breaks every install " +
        "by anyone outside the org; making a private one public cannot be undone on the free " +
        "tier. Setting `publish_requires_tfa` off weakens the account's publishing security.",
      inputSchema: z.object({
        package: packageArg,
        access: z
          .enum(["public", "private"])
          .optional()
          .describe("Package visibility. Private packages need a paid npm plan."),
        publish_requires_tfa: z
          .boolean()
          .optional()
          .describe("Whether publishing this package demands two-factor authentication."),
        automation_token_overrides_tfa: z
          .boolean()
          .optional()
          .describe(
            "Whether an automation token may publish without a second factor. This is npm's " +
              "`mfa=automation` setting; true weakens the requirement above.",
          ),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ package: pkg, access, publish_requires_tfa, automation_token_overrides_tfa }) =>
      wrap(async () => {
        const body = compact({
          access,
          publish_requires_tfa,
          automation_token_overrides_tfa,
        });
        if (Object.keys(body).length === 0) {
          throw new PreconditionError(
            "Nothing to change — pass at least one of `access`, `publish_requires_tfa` or " +
              "`automation_token_overrides_tfa`.",
          );
        }
        await client.post(`/-/package/${escapePackageName(pkg)}/access`, body, {
          otp: "auto",
          command: "access",
        });
        return { package: pkg, updated: body };
      }),
  );
};
