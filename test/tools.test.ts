import { describe, expect, it } from "vitest";

import { connect } from "#test/helpers";

/** Read one argument's enum, failing the test rather than throwing if the tool is absent. */
const enumOf = async (
  harness: Awaited<ReturnType<typeof connect>>,
  toolName: string,
  field: string,
): Promise<string[] | undefined> => {
  const tool = await harness.tool(toolName);
  expect(tool, `${toolName} is not registered`).toBeDefined();
  const props = tool?.inputSchema.properties as Record<string, { enum?: string[] }>;
  return props[field]?.enum;
};

const READ_TOOLS = [
  "npm_audit_dependencies",
  "npm_auth_clear_otp",
  "npm_auth_otp",
  "npm_auth_reload",
  "npm_auth_status",
  "npm_get_dist_tags",
  "npm_get_downloads",
  "npm_get_package",
  "npm_get_package_version",
  "npm_get_package_visibility",
  "npm_get_trusted_publisher",
  "npm_get_version_downloads",
  "npm_list_collaborators",
  "npm_list_org_members",
  "npm_list_org_packages",
  "npm_list_org_teams",
  "npm_list_team_members",
  "npm_list_team_packages",
  "npm_list_tokens",
  "npm_list_versions",
  "npm_request",
  "npm_search_packages",
  "npm_whoami",
];

const WRITE_TOOLS = [
  "npm_add_dist_tag",
  "npm_add_team_member",
  "npm_create_team",
  "npm_create_token",
  "npm_delete_team",
  "npm_delete_trusted_publisher",
  "npm_deprecate_package",
  "npm_grant_team_package_access",
  "npm_publish",
  "npm_remove_dist_tag",
  "npm_remove_org_member",
  "npm_remove_team_member",
  "npm_revoke_team_package_access",
  "npm_revoke_token",
  "npm_set_org_member_role",
  "npm_set_package_access",
  "npm_set_trusted_publisher",
  "npm_set_trusted_publisher_batch",
  "npm_unpublish",
];

describe("tool registration", () => {
  /**
   * The regression that produces "MCP error -32000: Connection closed": a
   * server that exits when nothing is configured takes its own explanation with
   * it, because the client swallows stderr. It must connect and say what to set.
   */
  it("still connects with no token at all, and serves the credential-free tools", async () => {
    const names = await (await connect({})).toolNames();
    // npm's advisory endpoint needs no authentication, so an unconfigured
    // server is still good for something real rather than being a setup guide.
    // npm_auth_reload is here on purpose: an unconfigured server is exactly the
    // one that needs to be told a token has appeared since it started.
    expect(names).toEqual(["npm_audit_dependencies", "npm_auth_reload", "npm_auth_status"]);
  });

  it("answers npm_auth_status with setup instructions when unconfigured", async () => {
    const harness = await connect({});
    const status = await harness.call("npm_auth_status");

    expect(status.isToolError).toBeFalsy();
    expect(status.configured).toBe(false);
    expect(status.trusted_publishing_available).toBe(false);
    expect(Array.isArray(status.setup)).toBe(true);
    expect((status.setup as string[]).join(" ")).toMatch(/npm login|NPM_TOKEN/);
  });

  it("registers exactly the read tools when a token is set and writes are off", async () => {
    const names = await (await connect({ NPM_TOKEN: "t" })).toolNames();
    expect(names).toEqual(READ_TOOLS.toSorted());
  });

  it("registers the write tools only when NPM_ALLOW_WRITES is set", async () => {
    const names = await (await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" })).toolNames();
    expect(names).toEqual([...READ_TOOLS, ...WRITE_TOOLS].toSorted());
  });

  /**
   * The negative half of rule 1, and the one a unit test is uniquely good at:
   * a write tool registered outside its `if (allowWrites)` block is otherwise
   * invisible until someone calls it.
   */
  it("does not merely refuse the write tools when writes are off — they do not exist", async () => {
    const names = await (await connect({ NPM_TOKEN: "t" })).toolNames();
    for (const tool of WRITE_TOOLS) expect(names, tool).not.toContain(tool);
  });

  it("an env var beats a config file, so NPM_ALLOW_WRITES=0 always wins", async () => {
    const names = await (await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "0" })).toolNames();
    expect(names).not.toContain("npm_publish");
  });
});

describe("annotations", () => {
  it("marks reads read-only and irreversible writes destructive", async () => {
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" });

    expect((await harness.tool("npm_get_package"))?.annotations?.readOnlyHint).toBe(true);
    expect((await harness.tool("npm_get_trusted_publisher"))?.annotations?.readOnlyHint).toBe(true);
    expect((await harness.tool("npm_unpublish"))?.annotations?.destructiveHint).toBe(true);
    expect((await harness.tool("npm_delete_trusted_publisher"))?.annotations?.destructiveHint).toBe(
      true,
    );
    expect((await harness.tool("npm_delete_team"))?.annotations?.destructiveHint).toBe(true);
    // Publishing creates something new; it does not destroy anything.
    expect((await harness.tool("npm_publish"))?.annotations?.destructiveHint).toBe(false);
  });

  it("gives every tool a service-prefixed title, so a permission dialog is unambiguous", async () => {
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" });
    const tools = (await harness.client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeDefined();
      expect(tool.title, tool.name).toMatch(/^npm: /);
    }
  });

  it("describes every input field, since that is all a model reads before choosing", async () => {
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" });
    for (const tool of (await harness.client.listTools()).tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [field, schema] of Object.entries(props)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });
});

describe("destructive tools", () => {
  it("refuse to run without an explicit confirm, and never reach npm", async () => {
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" });

    const result = await harness.call("npm_delete_team", { org: "mgcrea", team: "dev" });

    expect(result.isToolError).toBe(true);
    expect(harness.callCount()).toBe(0);
  });
});

describe("npm_request", () => {
  it("offers only GET when writes are disabled", async () => {
    const harness = await connect({ NPM_TOKEN: "t" });
    expect(await enumOf(harness, "npm_request", "method")).toEqual(["GET"]);
    expect((await harness.tool("npm_request"))?.annotations?.readOnlyHint).toBe(true);
  });

  it("offers the write methods when writes are enabled", async () => {
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" });
    expect(await enumOf(harness, "npm_request", "method")).toEqual([
      "GET",
      "POST",
      "PUT",
      "DELETE",
    ]);
  });

  it("refuses an absolute URL, so the token cannot be sent to another host", async () => {
    const harness = await connect({ NPM_TOKEN: "t" });
    const result = await harness.call("npm_request", { path: "https://evil.example.com/steal" });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/absolute URL/);
    expect(harness.callCount()).toBe(0);
  });

  it("refuses traversal out of the registry root", async () => {
    const harness = await connect({ NPM_TOKEN: "t" });
    const result = await harness.call("npm_request", { path: "/-/npm/../../etc" });

    expect(result.isToolError).toBe(true);
    expect(harness.callCount()).toBe(0);
  });
});
