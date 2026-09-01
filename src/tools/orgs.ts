import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { NpmRegistryClient } from "#/client/registry";
import type { ToolContext } from "#/tools/index";
import { confirmArg, packageArg, scopeOrgArg, wrap } from "#/tools/util";

const ROLES = ["developer", "admin", "owner"] as const;

export const registerOrgTools = (
  server: McpServer,
  client: NpmRegistryClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "npm_list_org_members",
    {
      title: "npm: List Org Members",
      description:
        'Everyone in an npm organisation, as `{username: role}` where role is "developer", ' +
        '"admin" or "owner". NOTE: session token only — npm refuses a granular access token on ' +
        "this read even though it accepts one for the corresponding writes.",
      inputSchema: z.object({ org: scopeOrgArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ org }) => wrap(() => client.get(`/-/org/${encodeURIComponent(org)}/user`)),
  );

  server.registerTool(
    "npm_list_org_teams",
    {
      title: "npm: List Org Teams",
      description:
        'The teams in an organisation, returned as "org:team" strings. Session token only, the ' +
        "same as npm_list_org_members.",
      inputSchema: z.object({ org: scopeOrgArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ org }) => wrap(() => client.get(`/-/org/${encodeURIComponent(org)}/team`)),
  );

  server.registerTool(
    "npm_list_org_packages",
    {
      title: "npm: List Org Packages",
      description:
        'Every package the organisation owns, as `{package: "read-write" | "read-only"}`. For a ' +
        "personal scope rather than an org this returns 404 — npm keeps those under a different " +
        "route, so use npm_request against `/-/user/<username>/package` in that case. Session " +
        "token only.",
      inputSchema: z.object({ org: scopeOrgArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ org }) => wrap(() => client.get(`/-/org/${encodeURIComponent(org)}/package`)),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "npm_set_org_member_role",
    {
      title: "npm: Set Org Member Role",
      description:
        "Add someone to an organisation, or change their role. Used on an existing member this " +
        'is a role change — promoting to "owner" grants full control of the org including ' +
        "billing and the ability to remove you. Seats are billed, so adding a member to a paid " +
        "org costs money.",
      inputSchema: z.object({
        org: scopeOrgArg,
        user: z.string().min(1).describe("npm username, without a leading @."),
        role: z
          .enum(ROLES)
          .default("developer")
          .describe(
            '"developer" can publish to the org\'s packages; "admin" can also manage teams; ' +
              '"owner" can do everything including billing.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ org, user, role }) =>
      wrap(async () => {
        await client.put(
          `/-/org/${encodeURIComponent(org)}/user`,
          { user, role },
          {
            otp: "auto",
            command: "org",
          },
        );
        return { org, user, role, ok: true };
      }),
  );

  server.registerTool(
    "npm_remove_org_member",
    {
      title: "npm: Remove Org Member",
      description:
        "Remove someone from an organisation. They immediately lose access to every package the " +
        "org owns, including any they personally maintain within it. Removing the last owner is " +
        "refused by npm.",
      inputSchema: z.object({
        org: scopeOrgArg,
        user: z.string().min(1).describe("npm username, without a leading @."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ org, user }) =>
      wrap(async () => {
        await client.del(
          `/-/org/${encodeURIComponent(org)}/user`,
          { user },
          {
            otp: "auto",
            command: "org",
          },
        );
        return { org, user, removed: true };
      }),
  );

  server.registerTool(
    "npm_grant_team_package_access",
    {
      title: "npm: Grant Team Package Access",
      description:
        "Give a team read-only or read-write access to a package. Read-write means every member " +
        "of that team can publish it, so it is the main way publish rights spread through an " +
        "org.",
      inputSchema: z.object({
        org: scopeOrgArg,
        team: z.string().min(1).describe('Team name, without the "org:" prefix.'),
        package: packageArg,
        permissions: z
          .enum(["read-only", "read-write"])
          .default("read-only")
          .describe("`read-write` lets every team member publish this package."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ org, team, package: pkg, permissions }) =>
      wrap(async () => {
        await client.put(
          `/-/team/${encodeURIComponent(org)}/${encodeURIComponent(team)}/package`,
          { package: pkg, permissions },
          { otp: "auto", command: "access" },
        );
        return { org, team, package: pkg, permissions, ok: true };
      }),
  );

  server.registerTool(
    "npm_revoke_team_package_access",
    {
      title: "npm: Revoke Team Package Access",
      description:
        "Take a package away from a team. Members lose whatever access the team gave them, so " +
        "anyone whose publish rights came only from this grant can no longer publish — which " +
        "will break their CI if it relies on a personal token.",
      inputSchema: z.object({
        org: scopeOrgArg,
        team: z.string().min(1).describe('Team name, without the "org:" prefix.'),
        package: packageArg,
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ org, team, package: pkg }) =>
      wrap(async () => {
        await client.del(
          `/-/team/${encodeURIComponent(org)}/${encodeURIComponent(team)}/package`,
          { package: pkg },
          { otp: "auto", command: "access" },
        );
        return { org, team, package: pkg, revoked: true };
      }),
  );
};
