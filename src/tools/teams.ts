import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { NpmRegistryClient } from "#/client/registry";
import type { ToolContext } from "#/tools/index";
import { confirmArg, scopeOrgArg, teamArg, wrap } from "#/tools/util";

/**
 * Team routes live under `/-/team/{org}/{team}`.
 *
 * npm's published OpenAPI spec puts several of these under
 * `/-/org/{org}/{team}` instead. The spec and the shipped CLI disagree, and the
 * CLI's paths are the ones exercised by every `npm team` invocation in
 * production — so those are what this uses. Do not "correct" it to match the
 * spec without testing against a real org first.
 */
const teamPath = (org: string, team: string): string =>
  `/-/team/${encodeURIComponent(org)}/${encodeURIComponent(team)}`;

export const registerTeamTools = (
  server: McpServer,
  client: NpmRegistryClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "npm_list_team_members",
    {
      title: "npm: List Team Members",
      description:
        "The usernames in one team. Combine with npm_list_team_packages to see who can publish " +
        "what. Session token only, like the other org governance reads.",
      inputSchema: z.object({ org: scopeOrgArg, team: teamArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ org, team }) => wrap(() => client.get(`${teamPath(org, team)}/user`)),
  );

  server.registerTool(
    "npm_list_team_packages",
    {
      title: "npm: List Team Packages",
      description:
        'The packages a team has been granted, as `{package: "read-write" | "read-only"}`. This ' +
        "is the answer to 'why can this person publish that package'. Session token only.",
      inputSchema: z.object({ org: scopeOrgArg, team: teamArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ org, team }) => wrap(() => client.get(`${teamPath(org, team)}/package`)),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "npm_create_team",
    {
      title: "npm: Create Team",
      description:
        "Create a team in an organisation. A new team has no members and no package grants, so " +
        "it changes nobody's access until you add both.",
      inputSchema: z.object({
        org: scopeOrgArg,
        team: teamArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ org, team }) =>
      wrap(async () => {
        await client.put(
          `/-/org/${encodeURIComponent(org)}/team`,
          { name: team },
          {
            otp: "auto",
            command: "team",
          },
        );
        return { org, team, created: true };
      }),
  );

  server.registerTool(
    "npm_delete_team",
    {
      title: "npm: Delete Team",
      description:
        "Delete a team. Every package grant the team held disappears with it, so members lose " +
        "any access they had only through this team — including publish rights their CI may " +
        "depend on. The members themselves stay in the org.",
      inputSchema: z.object({ org: scopeOrgArg, team: teamArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ org, team }) =>
      wrap(async () => {
        await client.del(teamPath(org, team), undefined, { otp: "auto", command: "team" });
        return { org, team, deleted: true };
      }),
  );

  server.registerTool(
    "npm_add_team_member",
    {
      title: "npm: Add Team Member",
      description:
        "Add an existing org member to a team. They immediately gain every package grant the " +
        "team holds, so check npm_list_team_packages first if you are not sure what that is. " +
        "The user must already be in the organisation.",
      inputSchema: z.object({
        org: scopeOrgArg,
        team: teamArg,
        user: z.string().min(1).describe("npm username, without a leading @."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ org, team, user }) =>
      wrap(async () => {
        await client.put(
          `${teamPath(org, team)}/user`,
          { user },
          {
            otp: "auto",
            command: "team",
          },
        );
        return { org, team, user, added: true };
      }),
  );

  server.registerTool(
    "npm_remove_team_member",
    {
      title: "npm: Remove Team Member",
      description:
        "Remove someone from a team. They lose the team's package grants but stay in the " +
        "organisation. If their publish rights came only from this team, their CI stops working.",
      inputSchema: z.object({
        org: scopeOrgArg,
        team: teamArg,
        user: z.string().min(1).describe("npm username, without a leading @."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ org, team, user }) =>
      wrap(async () => {
        await client.del(
          `${teamPath(org, team)}/user`,
          { user },
          {
            otp: "auto",
            command: "team",
          },
        );
        return { org, team, user, removed: true };
      }),
  );
};
