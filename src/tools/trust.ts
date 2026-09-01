import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { NpmOtpError, NpmRegistryError, PreconditionError } from "#/client/errors";
import { escapePackageName, sleep, type NpmRegistryClient } from "#/client/registry";
import { isRecord, summarizeTrustConfig, type Rec } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { confirmArg, packageArg, wrap } from "#/tools/util";

/**
 * npm paces its own scripting guidance at roughly two seconds between calls.
 * Not configurable downward: the whole reason the batch tool exists is to stay
 * inside npm's cooldown window, and letting a caller sprint through it would
 * trade one browser prompt for twenty-five.
 */
const BATCH_DELAY_MS = 2000;

/**
 * Each package costs up to three OTP-bearing calls (read, delete, create) and
 * npm's window is about eighty. 80 / 3 ≈ 26, so twenty-five keeps even a
 * worst-case full batch inside a single authorization. The answer to "I have
 * forty packages" is to run it twice, not to raise this.
 */
const BATCH_MAX = 25;

const PROVIDERS = ["github", "gitlab", "circleci"] as const;
const PERMISSIONS = ["createPackage", "createStagedPackage"] as const;

type TrustConfig = { id?: string; type: string; claims: Rec; permissions: string[] };

const publisherFields = {
  provider: z
    .enum(PROVIDERS)
    .describe(
      "Which CI provider is allowed to publish. Each needs a different set of the fields below.",
    ),
  repository: z
    .string()
    .optional()
    .describe(
      'GitHub only, required: "owner/repo", e.g. "mgcrea/mcp-ovh-api". Not a URL, and not just ' +
        "the repo name.",
    ),
  project_path: z
    .string()
    .optional()
    .describe('GitLab only, required: the full project path, e.g. "my-group/my-package".'),
  workflow_filename: z
    .string()
    .optional()
    .describe(
      'The workflow file, as a BASENAME only — "ci.yml", not ".github/workflows/ci.yml". ' +
        "Required for GitHub and GitLab. npm matches on the filename, so a path is rejected.",
    ),
  environment: z
    .string()
    .optional()
    .describe(
      'Optional deployment environment the job must run in, e.g. "production". Leave unset ' +
        "unless your workflow actually declares one — a mismatch here fails the publish.",
    ),
  org_id: z.string().uuid().optional().describe("CircleCI only, required: the organisation UUID."),
  project_id: z.string().uuid().optional().describe("CircleCI only, required: the project UUID."),
  pipeline_definition_id: z
    .string()
    .uuid()
    .optional()
    .describe("CircleCI only, required: the pipeline definition UUID."),
  vcs_origin: z
    .string()
    .optional()
    .describe('CircleCI only, required: the VCS origin, e.g. "github.com/myorg/myrepo".'),
  context_ids: z
    .array(z.string().uuid())
    .optional()
    .describe("CircleCI only, optional: context UUIDs the job must run with."),
  permissions: z
    .array(z.enum(PERMISSIONS))
    .min(1)
    .default(["createPackage"])
    .describe(
      "What the trusted workflow may do. `createPackage` is a normal `npm publish`; " +
        "`createStagedPackage` is `npm stage publish`. At least one is required.",
    ),
};

type PublisherInput = {
  provider: (typeof PROVIDERS)[number];
  repository?: string | undefined;
  project_path?: string | undefined;
  workflow_filename?: string | undefined;
  environment?: string | undefined;
  org_id?: string | undefined;
  project_id?: string | undefined;
  pipeline_definition_id?: string | undefined;
  vcs_origin?: string | undefined;
  context_ids?: string[] | undefined;
  permissions: string[];
};

/**
 * Validate the provider-specific fields.
 *
 * These are flat and optional rather than a zod discriminated union on purpose:
 * a union renders as `anyOf` in JSON Schema, and models pick badly from that.
 * Flat fields plus this refinement give the same guarantee with a much better
 * error — one that names the missing field for the provider actually chosen.
 */
const refinePublisher = (value: PublisherInput, ctx: z.RefinementCtx): void => {
  const require = (field: keyof PublisherInput, label: string): void => {
    if (!value[field]) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${label} is required when provider is "${value.provider}".`,
      });
    }
  };

  if (value.provider === "github") {
    require("repository", "`repository` (owner/repo)");
    require("workflow_filename", "`workflow_filename`");
  } else if (value.provider === "gitlab") {
    require("project_path", "`project_path`");
    require("workflow_filename", "`workflow_filename`");
  } else {
    require("org_id", "`org_id`");
    require("project_id", "`project_id`");
    require("pipeline_definition_id", "`pipeline_definition_id`");
    require("vcs_origin", "`vcs_origin`");
  }

  if (value.workflow_filename?.includes("/")) {
    ctx.addIssue({
      code: "custom",
      path: ["workflow_filename"],
      message:
        "`workflow_filename` must be a bare filename, not a path. Use `ci.yml`, not " +
        "`.github/workflows/ci.yml`.",
    });
  }
};

/**
 * Build npm's claims map for one provider.
 *
 * The `{ file: … }` object form is npm's documented partial match — it matches
 * the workflow by filename wherever it lives. A bare string would be an exact
 * match on the full ref, which is not what a filename means.
 *
 * GitLab's key is `ci_config_ref_uri` even though what goes in it is a
 * filename, not a URI. That is npm's own naming, commented on in npm's source,
 * and not a mistake to "fix" here.
 */
const buildClaims = (input: PublisherInput): Rec => {
  if (input.provider === "github") {
    return {
      repository: input.repository,
      workflow_ref: { file: input.workflow_filename },
      ...(input.environment ? { environment: input.environment } : {}),
    };
  }
  if (input.provider === "gitlab") {
    return {
      project_path: input.project_path,
      ci_config_ref_uri: { file: input.workflow_filename },
      ...(input.environment ? { environment: input.environment } : {}),
    };
  }
  return {
    "oidc.circleci.com/org-id": input.org_id,
    "oidc.circleci.com/project-id": input.project_id,
    "oidc.circleci.com/pipeline-definition-id": input.pipeline_definition_id,
    "oidc.circleci.com/vcs-origin": input.vcs_origin,
    ...(input.context_ids?.length ? { "oidc.circleci.com/context-ids": input.context_ids } : {}),
  };
};

const trustPath = (pkg: string): string => `/-/package/${escapePackageName(pkg)}/trust`;

/** npm returns an array even though it permits at most one configuration. */
const listTrust = async (client: NpmRegistryClient, pkg: string): Promise<TrustConfig[]> => {
  const body = await client.get<unknown>(trustPath(pkg), undefined, {
    otp: "auto",
    command: "trust",
  });
  return Array.isArray(body) ? (body.filter(isRecord) as unknown as TrustConfig[]) : [];
};

/** Deep structural equality, enough for the small JSON npm stores here. */
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const matches = (existing: TrustConfig, provider: string, claims: Rec, perms: string[]): boolean =>
  existing.type === provider &&
  sameJson(existing.claims, claims) &&
  sameJson((existing.permissions ?? []).toSorted(), perms.toSorted());

export type ApplyOutcome = {
  package: string;
  status: "created" | "replaced" | "unchanged" | "failed";
  publisher?: unknown;
  replaced_id?: string;
  error?: string;
  remedy?: string;
};

/**
 * Apply one configuration, owning the whole read → delete → create transaction.
 *
 * npm has no update endpoint and allows exactly one configuration per package,
 * so changing one genuinely means deleting it first. Keeping that inside a
 * single tool is a safety property, not a convenience: split across two tools,
 * a model can delete and then fail to create, leaving the package with NO
 * trusted publisher and its release pipeline quietly broken. That is the only
 * irreversible outcome in this feature.
 */
export const applyTrustConfig = async (
  client: NpmRegistryClient,
  pkg: string,
  input: PublisherInput,
  replaceExisting: boolean,
  dryRun: boolean,
): Promise<ApplyOutcome> => {
  const claims = buildClaims(input);
  const existing = (await listTrust(client, pkg))[0];

  if (existing && matches(existing, input.provider, claims, input.permissions)) {
    // Skipping here is what keeps a re-run cheap: without it, twenty-five
    // already-correct packages would spend seventy-five OTP uses to change
    // nothing and blow through npm's window.
    return { package: pkg, status: "unchanged", publisher: summarizeTrustConfig(existing) };
  }

  if (existing && !replaceExisting) {
    throw new PreconditionError(
      `${pkg} already has a trusted publisher, and it differs from the one requested.`,
      {
        existing: summarizeTrustConfig(existing),
        remedy:
          "npm permits one configuration per package and has no update endpoint. Pass " +
          "replace_existing=true to delete the existing one and create yours in its place.",
      },
    );
  }

  if (dryRun) {
    return {
      package: pkg,
      status: existing ? "replaced" : "created",
      ...(existing?.id ? { replaced_id: existing.id } : {}),
      publisher: summarizeTrustConfig({
        type: input.provider,
        claims,
        permissions: input.permissions,
      }),
    };
  }

  if (existing?.id) {
    await client.del(`${trustPath(pkg)}/${encodeURIComponent(existing.id)}`, undefined, {
      otp: "auto",
      command: "trust",
    });
  }

  // The POST body is an ARRAY, not the object it looks like it should be.
  const created = await client.post<unknown>(
    trustPath(pkg),
    [{ type: input.provider, claims, permissions: input.permissions }],
    { otp: "auto", command: "trust" },
  );
  const config = Array.isArray(created) ? created[0] : created;

  return {
    package: pkg,
    status: existing ? "replaced" : "created",
    ...(existing?.id ? { replaced_id: existing.id } : {}),
    publisher: summarizeTrustConfig(config),
  };
};

/**
 * Conditions that will fail identically for every remaining package. Twenty-five
 * copies of one error is worse than one, and worse still if each costs a browser
 * prompt, so the batch stops and says what to fix.
 */
const isFatalForBatch = (err: unknown): string | undefined => {
  if (err instanceof NpmOtpError) {
    return (
      "npm asked for a one-time password again after one had already been confirmed, so its " +
      "cooldown is not applying to this account. Continuing would mean one browser prompt per " +
      "package. " +
      (err.remedy ?? "")
    );
  }
  // A 403 is always about the token or the account, never about this package,
  // so every package left in the batch would fail exactly the same way.
  if (err instanceof NpmRegistryError && err.status === 403) return err.remedy ?? err.message;
  return undefined;
};

export const registerTrustTools = (
  server: McpServer,
  client: NpmRegistryClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "npm_get_trusted_publisher",
    {
      title: "npm: Get Trusted Publisher",
      description:
        "Read which CI workflow npm allows to publish a package without a token. Returns the " +
        "configuration's id — needed to delete it — along with the repository, workflow file " +
        "and permissions. NOTE: npm requires a one-time password even for this read, so the " +
        "first call in a session opens a browser confirmation. Answers `configured: false` " +
        "when the package has no trusted publisher, which is not an error.",
      inputSchema: z.object({ package: packageArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ package: pkg }) =>
      wrap(async () => {
        const configs = await listTrust(client, pkg);
        const first = configs[0];
        return {
          package: pkg,
          configured: first !== undefined,
          ...(first ? { publisher: summarizeTrustConfig(first) } : {}),
        };
      }),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "npm_set_trusted_publisher",
    {
      title: "npm: Set Trusted Publisher",
      description:
        "Allow a CI workflow to publish this package over OIDC, with no npm token stored " +
        "anywhere. This owns the whole change: it reads the current configuration, and — " +
        "because npm permits only one per package and offers no update endpoint — deletes it " +
        "before creating the replacement when `replace_existing` is set. A configuration that " +
        "already matches is reported as `unchanged` and costs nothing. Requires a one-time " +
        "password; call npm_auth_otp first if you would rather approve the browser prompt at a " +
        "moment of your choosing. Use npm_set_trusted_publisher_batch for several packages — " +
        "it spends one authorization instead of one per package.",
      inputSchema: z
        .object({
          package: packageArg,
          ...publisherFields,
          replace_existing: z
            .boolean()
            .default(false)
            .describe(
              "Delete an existing, different configuration and create this one in its place. " +
                "Without it, a package that already has a different publisher is left alone " +
                "and reported.",
            ),
          dry_run: z
            .boolean()
            .default(false)
            .describe(
              "Report what would change without changing it. Still needs a one-time password, " +
                "because reading the current configuration requires one.",
            ),
          confirm: confirmArg,
        })
        .superRefine(refinePublisher),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      wrap(() => applyTrustConfig(client, args.package, args, args.replace_existing, args.dry_run)),
  );

  server.registerTool(
    "npm_set_trusted_publisher_batch",
    {
      title: "npm: Set Trusted Publisher (Batch)",
      description:
        "Apply the same trusted publisher across up to 25 packages, spending ONE browser " +
        "authorization for the whole run rather than one per package. Packages whose " +
        "configuration already matches are skipped. Failures on individual packages are " +
        "reported and do not stop the run; a token or account problem that would fail every " +
        "remaining package stops it immediately and reports what is left, so it can be resumed. " +
        "Paces itself at 2s between packages, per npm's own scripting guidance. The 25 cap is " +
        "derived from npm's ~80-uses-per-window limit at up to 3 calls per package — for more " +
        "packages, run it twice rather than raising it.",
      inputSchema: z
        .object({
          packages: z
            .array(packageArg)
            .min(1)
            .max(BATCH_MAX)
            .describe(
              `The packages to configure (1-${BATCH_MAX}). All get the same repository and ` +
                "workflow, so use this for one repo that publishes several packages, or a " +
                "monorepo where the same workflow publishes all of them.",
            ),
          ...publisherFields,
          replace_existing: z
            .boolean()
            .default(false)
            .describe(
              "Replace a package's existing, different configuration instead of leaving it " +
                "alone. Applies to every package in the batch, so check the dry run first.",
            ),
          dry_run: z
            .boolean()
            .default(false)
            .describe(
              "Report the change for every package without making any. Still needs one " +
                "authorization, because reading each configuration requires an OTP.",
            ),
          confirm: confirmArg,
        })
        .superRefine(refinePublisher),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      wrap(async () => {
        const results: ApplyOutcome[] = [];
        let aborted: { after: number; reason: string } | undefined;

        for (const [index, pkg] of args.packages.entries()) {
          // Pace between packages, not before the first: the delay exists to
          // stay inside npm's window, and there is nothing to space out yet.
          if (index > 0) await sleep(BATCH_DELAY_MS);

          try {
            results.push(
              await applyTrustConfig(client, pkg, args, args.replace_existing, args.dry_run),
            );
          } catch (err) {
            const fatal = isFatalForBatch(err);
            const messageText = err instanceof Error ? err.message : String(err);
            const remedy = err instanceof NpmRegistryError ? err.remedy : undefined;
            results.push({
              package: pkg,
              status: "failed",
              error: messageText,
              ...(remedy ? { remedy } : {}),
            });
            if (fatal) {
              aborted = { after: index + 1, reason: fatal };
              break;
            }
          }
        }

        const counts = results.reduce<Record<string, number>>((acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        }, {});

        return {
          dry_run: args.dry_run,
          summary: { requested: args.packages.length, ...counts },
          results,
          ...(aborted
            ? {
                aborted_after: aborted.after,
                remaining: args.packages.slice(aborted.after),
                reason: aborted.reason,
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "npm_delete_trusted_publisher",
    {
      title: "npm: Delete Trusted Publisher",
      description:
        "Remove a package's trusted publisher. The CI workflow that relied on it can no longer " +
        "publish, and any release pipeline depending on it will start failing — so prefer " +
        "npm_set_trusted_publisher with replace_existing=true when you mean to change it rather " +
        "than remove it. The configuration id is regenerated whenever a publisher is recreated, " +
        "so read it fresh with npm_get_trusted_publisher rather than reusing an older one.",
      inputSchema: z.object({
        package: packageArg,
        id: z
          .string()
          .uuid("A trusted-publisher id is a UUID from npm_get_trusted_publisher.")
          .optional()
          .describe(
            "The configuration UUID. Optional — when omitted the package's single existing " +
              "configuration is used, which is what you want in almost every case.",
          ),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ package: pkg, id }) =>
      wrap(async () => {
        const existing = (await listTrust(client, pkg))[0];
        if (!existing) return { package: pkg, deleted: false, note: "No trusted publisher set." };

        const targetId = id ?? existing.id;
        if (!targetId) throw new PreconditionError(`npm returned no id for ${pkg}'s publisher.`);
        if (id && existing.id && id !== existing.id) {
          // Deleting by a stale id would 404; saying so beats letting the
          // caller believe the wrong configuration was removed.
          throw new PreconditionError(
            `${pkg}'s trusted publisher has id ${existing.id}, not ${id}.`,
            {
              remedy:
                "These ids change whenever the configuration is recreated. Re-read it with " +
                "npm_get_trusted_publisher and retry, or omit `id` entirely.",
            },
          );
        }

        await client.del(`${trustPath(pkg)}/${encodeURIComponent(targetId)}`, undefined, {
          otp: "auto",
          command: "trust",
        });
        return { package: pkg, deleted: true, deleted_id: targetId };
      }),
  );
};
