import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { NpmRegistryError, PreconditionError } from "#/client/errors";
import { packumentPath, type NpmRegistryClient } from "#/client/registry";
import { isRecord, type Rec } from "#/client/shape";
import { buildPublishBody, packDirectory, tarballFilename } from "#/client/tarball";
import type { ToolContext } from "#/tools/index";
import { confirmArg, dryRunArg, packageArg, versionArg, wrap } from "#/tools/util";

/**
 * Correct the 404-on-write remedy when the package demonstrably already exists.
 *
 * `registry.ts` maps every non-GET 404 to the first-publish story — the token
 * may not CREATE a package here — because that is the case nobody guesses. It
 * is the wrong story for a package with thirty published versions, and it sends
 * a maintainer off to check whether they can claim a name they claimed years
 * ago. Only this tool can tell the two apart, because only this tool has
 * already read the packument, so the mapping is done here rather than in the
 * client, where `toError` is private and knows nothing about the package.
 *
 * npm answers 404 rather than 403 on a write the token may not perform, which
 * is what makes both stories look identical from the status code alone.
 */
const explainPublishFailure = (
  err: unknown,
  name: string,
  existing: Rec | undefined,
  preflightError: unknown,
): unknown => {
  if (!(err instanceof NpmRegistryError) || err.status !== 404) return err;

  if (existing) {
    const versions = isRecord(existing.versions) ? Object.keys(existing.versions).length : 0;
    return new NpmRegistryError(err.message, {
      status: err.status,
      errors: err.errors,
      remedy:
        `${name} already exists on this registry with ${versions} published ` +
        `version${versions === 1 ? "" : "s"}, so this is not a create and the name is not the ` +
        "problem. npm answers 404 on a write the token may not perform, so read this as: this " +
        "token cannot write THIS package. Two causes account for nearly all of it — a granular " +
        "access token whose selected-packages list does not include it (or whose scope does " +
        "not cover it), and a token with 'Bypass 2FA' enabled, which npm no longer accepts for " +
        "direct publishing even though it still passes reads. Check the token at " +
        "https://www.npmjs.com/settings/~/tokens, or run npm_auth_login for a session token " +
        "and retry. npm_auth_status reports which kind this one is.",
    });
  }

  // A 404 on the pre-flight READ is npm's ordinary, correct answer for a name
  // nobody has published: the package really is absent, and registry.ts's
  // first-publish remedy is exactly right. Reading this as "the read failed, so
  // we cannot tell" would blur the one case that was already clear.
  if (preflightError instanceof NpmRegistryError && preflightError.status === 404) return err;

  if (preflightError !== undefined) {
    const detail =
      preflightError instanceof Error ? preflightError.message : String(preflightError);
    return new NpmRegistryError(err.message, {
      status: err.status,
      errors: err.errors,
      remedy:
        `Whether ${name} already exists could not be established: the pre-flight read failed ` +
        `too (${detail}). If the package DOES exist, this 404 means the token may not write ` +
        "that particular package — a granular token that does not name it, or one with " +
        "'Bypass 2FA' enabled, which npm refuses for direct publishing. If it does not exist, " +
        "the token may not CREATE a package here. A session token from npm_auth_login (or " +
        "`npm login` plus npm_auth_reload) settles both; npm_auth_status reports which kind " +
        "this token is.",
    });
  }

  // The packument really is absent: registry.ts's first-publish remedy is the
  // right one, and rewriting it here would only make it worse.
  return err;
};

/** One step of an unpublish, reported by `dry_run` before any of it happens. */
type Step = { step: string; method: string; path: string; note?: string };

export const registerPublishTools = (
  server: McpServer,
  client: NpmRegistryClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "npm_publish",
    {
      title: "npm: Publish Package",
      description:
        "Publish a package from a local directory. THIS PRODUCES NO PROVENANCE ATTESTATION: a " +
        "release published this way is cryptographically weaker than one published by CI over " +
        "OIDC with `npm publish --provenance`, and it requires a long-lived token where CI " +
        "requires none. Prefer the CI path — configure it with npm_set_trusted_publisher and " +
        "push a tag. Use this only for a package CI cannot reach. Runs `npm pack` in the " +
        "directory, which executes that package's own prepack/prepare scripts, so do not point " +
        "it at a directory you have not read. A published version can never be replaced. A " +
        "successful publish can 404 on npm_get_package for several minutes afterward — that is " +
        "registry read-path lag, not a failed write.",
      inputSchema: z.object({
        directory: z
          .string()
          .min(1)
          .describe(
            "Absolute path to the package directory — the one containing package.json. Its " +
              "name and version fields decide what gets published.",
          ),
        tag: z
          .string()
          .min(1)
          .default("latest")
          .describe(
            'The dist-tag to publish under. "latest" is what a plain `npm install` resolves ' +
              'to; use "next" or "beta" for a prerelease you do not want picked up by default.',
          ),
        access: z
          .enum(["public", "restricted"])
          .optional()
          .describe(
            "For a scoped package's FIRST publish only. Scoped packages default to restricted, " +
              "which needs a paid plan — pass `public` for an open-source scoped package.",
          ),
        dry_run: dryRunArg.describe(
          "Pack the tarball and report exactly what would be published — name, version, size " +
            "and file count — without sending anything to npm. Always worth doing first.",
        ),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ directory, tag, access, dry_run }) =>
      wrap(async () => {
        // npmBin matters only when npm is not on PATH — which is the normal
        // case for a GUI-spawned server. See resolveNpmCli in client/tarball.ts.
        const packed = await packDirectory(directory, { npmBin: ctx.config.npmBin });

        // Ask before pushing. A version already on npm cannot be replaced, and
        // the error npm returns for a duplicate is far less clear than this.
        // The failure is kept rather than swallowed. A bare `.catch(() =>
        // undefined)` collapses three different answers — the name is free, the
        // token may not READ this package, the network is down — into one
        // `undefined`, and that is precisely the distinction the 404 handling
        // below needs to tell a first publish from a permission problem.
        const preflight = await client
          .get<Rec>(packumentPath(packed.name))
          .then((packument) => ({ packument, error: undefined }))
          .catch((error: unknown) => ({ packument: undefined, error }));
        const existing = preflight.packument;
        if (existing && isRecord(existing.versions) && existing.versions[packed.version]) {
          throw new PreconditionError(
            `${packed.name}@${packed.version} is already published and cannot be replaced.`,
            {
              remedy:
                "Bump the version in package.json and publish again. npm never allows a " +
                "published version to be overwritten, even by its own author.",
            },
          );
        }

        if (dry_run) {
          return {
            dry_run: true,
            package: packed.name,
            version: packed.version,
            tag,
            ...(access ? { access } : {}),
            tarball: tarballFilename(packed.name, packed.version),
            size_bytes: packed.byteLength,
            integrity: packed.integrity,
            note: "Nothing was sent to npm. Re-run with dry_run=false to publish.",
          };
        }

        try {
          await client.put(
            packumentPath(packed.name),
            buildPublishBody(packed, client.registry, tag, access),
            { otp: "auto", command: "publish" },
          );
        } catch (err) {
          throw explainPublishFailure(err, packed.name, existing, preflight.error);
        }

        return {
          published: true,
          package: packed.name,
          version: packed.version,
          tag,
          size_bytes: packed.byteLength,
          note:
            "Published WITHOUT a provenance attestation. A CI publish over OIDC would have " +
            "attached one; see npm_set_trusted_publisher.",
        };
      }),
  );

  server.registerTool(
    "npm_unpublish",
    {
      title: "npm: Unpublish Package",
      description:
        "Remove a published version, or an entire package, from npm. IRREVERSIBLE, and the " +
        "name and version can never be reused. npm only permits it within 72 hours of " +
        "publishing, and refuses outright if anything else on the registry depends on it. " +
        "npm_deprecate_package is the reversible alternative and is almost always what is " +
        "actually wanted — it warns installers without breaking anyone. npm has no single " +
        "unpublish endpoint, so removing one version is a five-step sequence against a document " +
        "revision; run dry_run=true first and read the steps.",
      inputSchema: z.object({
        package: packageArg,
        version: versionArg
          .optional()
          .describe(
            "The single version to remove. Omit to remove the ENTIRE package and every version " +
              "of it.",
          ),
        dry_run: dryRunArg.describe(
          "Resolve the document revision, compute every step, and report them without running " +
            "any. Do this first — each step below is a place to damage the package permanently.",
        ),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ package: pkg, version, dry_run }) =>
      wrap(async () => {
        // `?write=true` bypasses the edge cache and returns the `_rev` that
        // every step below is threaded through. A cached document carries a
        // stale revision and each write would 409.
        const doc = await client.get<Rec>(packumentPath(pkg), { write: "true" });
        const rev = typeof doc._rev === "string" ? doc._rev : undefined;
        if (!rev) {
          throw new PreconditionError(`npm returned no _rev for ${pkg}; cannot safely unpublish.`);
        }

        const versions = isRecord(doc.versions) ? doc.versions : {};
        const versionNames = Object.keys(versions);
        const distTags = isRecord(doc["dist-tags"]) ? { ...doc["dist-tags"] } : {};

        if (version && !versions[version]) {
          throw new PreconditionError(`${pkg} has no published version ${version}.`, {
            available: versionNames,
            remedy: "Check npm_list_versions — this may already have been unpublished.",
          });
        }

        // Removing the last remaining version is the same operation as removing
        // the package, and npm requires the whole-package form for it.
        const wholePackage = !version || versionNames.length <= 1;

        if (wholePackage) {
          const steps: Step[] = [
            {
              step: "delete the package",
              method: "DELETE",
              path: `${packumentPath(pkg)}/-rev/${rev}`,
              ...(version && versionNames.length <= 1
                ? {
                    note:
                      `${version} is the only published version, so npm removes the whole ` +
                      "package rather than the version.",
                  }
                : {}),
            },
          ];
          if (dry_run) {
            return {
              dry_run: true,
              package: pkg,
              scope: "entire package",
              versions: versionNames,
              steps,
            };
          }
          await client.del(`${packumentPath(pkg)}/-rev/${rev}`, undefined, {
            otp: "auto",
            command: "unpublish",
          });
          return { package: pkg, unpublished: "entire package", versions: versionNames.length };
        }

        const target = version as string;
        const tarball = tarballFilename(pkg, target);
        const tarballPath = `${packumentPath(pkg)}/-/${tarball}`;

        // Repoint `latest` before removing what it points at. Skipping this
        // leaves the package with a dist-tag aimed at a version that no longer
        // exists, and `npm install <pkg>` fails for everyone.
        const remaining = versionNames.filter((v) => v !== target);
        const retagged: Rec = {};
        for (const [tagName, tagVersion] of Object.entries(distTags)) {
          if (tagVersion !== target) {
            retagged[tagName] = tagVersion;
            continue;
          }
          const replacement = remaining[remaining.length - 1];
          if (replacement) retagged[tagName] = replacement;
        }
        if (!retagged.latest && remaining.length > 0) {
          retagged.latest = remaining[remaining.length - 1];
        }

        const steps: Step[] = [
          {
            step: "rewrite the package document without the version",
            method: "PUT",
            path: `${packumentPath(pkg)}/-rev/${rev}`,
            ...(distTags.latest === target
              ? { note: `dist-tag "latest" moves from ${target} to ${String(retagged.latest)}.` }
              : {}),
          },
          {
            step: "re-read for a fresh revision",
            method: "GET",
            path: `${packumentPath(pkg)}?write=true`,
            note: "The PUT above invalidates the revision, so the tarball delete needs a new one.",
          },
          { step: "delete the tarball", method: "DELETE", path: `${tarballPath}/-rev/<fresh-rev>` },
        ];

        if (dry_run) {
          return {
            dry_run: true,
            package: pkg,
            version: target,
            remaining_versions: remaining.length,
            dist_tags_after: retagged,
            steps,
          };
        }

        const nextDoc: Rec = { ...doc, "dist-tags": retagged };
        const nextVersions: Rec = { ...versions };
        delete nextVersions[target];
        nextDoc.versions = nextVersions;
        // `_revisions` and `_attachments` are CouchDB bookkeeping. Sending them
        // back makes the registry reject the write.
        delete nextDoc._revisions;
        delete nextDoc._attachments;

        await client.put(`${packumentPath(pkg)}/-rev/${rev}`, nextDoc, {
          otp: "auto",
          command: "unpublish",
        });

        const refreshed = await client.get<Rec>(packumentPath(pkg), { write: "true" });
        const freshRev = typeof refreshed._rev === "string" ? refreshed._rev : rev;

        await client.del(`${tarballPath}/-rev/${freshRev}`, undefined, {
          otp: "auto",
          command: "unpublish",
        });

        return {
          package: pkg,
          unpublished: target,
          remaining_versions: remaining.length,
          dist_tags: retagged,
        };
      }),
  );
};
