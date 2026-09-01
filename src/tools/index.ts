import type { McpServer } from "@modelcontextprotocol/server";

import type { NpmRegistryClient } from "#/client/registry";
import { isConfigured, type Config } from "#/config";
import { registerAuthTools } from "#/tools/auth";
import { registerDownloadTools } from "#/tools/downloads";
import { registerOrgTools } from "#/tools/orgs";
import { registerPackageTools } from "#/tools/packages";
import { registerPublishTools } from "#/tools/publish";
import { registerRequestTool } from "#/tools/request";
import { registerSecurityTools } from "#/tools/security";
import { registerTeamTools } from "#/tools/teams";
import { registerTokenTools } from "#/tools/tokens";
import { registerTrustTools } from "#/tools/trust";

export type ToolContext = {
  config: Config;
  /** Register the mutating tools too. Off by default — see NPM_ALLOW_WRITES. */
  allowWrites: boolean;
  hasCredentials: boolean;
};

/**
 * Register the npm tools. All capability decisions live here, so "why can't I
 * call X" is answered by one file.
 *
 * Three layers, in order:
 *
 *  1. The credential-free tools are registered first and unconditionally, so an
 *     unconfigured server is a useful one rather than a connection that closes.
 *     npm_audit_dependencies is here because npm's advisory endpoint genuinely
 *     takes no authentication.
 *  2. Everything else needs a token.
 *  3. Write tools are registered only when `allowWrites` is set — so with the
 *     flag off they are not refused, they do not exist, and an agent cannot
 *     call them at all. Each domain module makes that cut itself, at a single
 *     `if (!ctx.allowWrites) return;` between its reads and its writes.
 */
export const registerTools = (
  server: McpServer,
  client: NpmRegistryClient,
  ctx: ToolContext,
): void => {
  registerAuthTools(server, client, ctx);
  registerSecurityTools(server, client);

  if (!isConfigured(ctx.config)) return;

  registerPackageTools(server, client, ctx);
  registerDownloadTools(server, client);
  registerTrustTools(server, client, ctx);
  registerOrgTools(server, client, ctx);
  registerTeamTools(server, client, ctx);
  registerTokenTools(server, client, ctx);
  registerRequestTool(server, client, ctx.allowWrites);

  // Publishing and unpublishing have no read half, so the whole module is
  // behind the flag rather than splitting inside it.
  if (ctx.allowWrites) registerPublishTools(server, client, ctx);
};
