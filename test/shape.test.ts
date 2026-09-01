import { describe, expect, it } from "vitest";

import {
  summarizeAdvisoryResponse,
  summarizePackument,
  summarizeSearchResponse,
  summarizeTrustConfig,
  summarizeVersion,
} from "#/client/shape";

describe("summarizePackument", () => {
  const packument = {
    _id: "lodash",
    _rev: "927-abc",
    name: "lodash",
    "dist-tags": { latest: "4.17.21" },
    versions: {
      "4.17.20": { name: "lodash", version: "4.17.20", dist: { tarball: "…" } },
      "4.17.21": {
        name: "lodash",
        version: "4.17.21",
        dist: { tarball: "https://…/lodash-4.17.21.tgz", integrity: "sha512-x", shasum: "abc" },
      },
    },
    time: { created: "2011-01-01", modified: "2021-02-20", "4.17.21": "2021-02-20" },
    readme: "# lodash\n".repeat(5000),
    users: { alice: true, bob: true },
    description: "Lodash modular utilities.",
  };

  it("drops the README, the star map and npm's internal bookkeeping", () => {
    // These three are the whole reason a raw packument is unusable: the README
    // alone is often larger than everything else combined.
    const summary = summarizePackument(packument) as Record<string, unknown>;

    expect(summary).not.toHaveProperty("readme");
    expect(summary).not.toHaveProperty("users");
    expect(summary).not.toHaveProperty("_rev");
    expect(summary).not.toHaveProperty("_id");
  });

  it("keeps dist-tags, which is what everything else is looked up through", () => {
    const summary = summarizePackument(packument) as Record<string, unknown>;
    expect(summary["dist-tags"]).toEqual({ latest: "4.17.21" });
  });

  it("lists version names only, and expands just the latest", () => {
    const summary = summarizePackument(packument) as Record<string, unknown>;

    expect(summary.versions).toEqual(["4.17.20", "4.17.21"]);
    expect(summary.version_count).toBe(2);
    expect((summary.latest as Record<string, unknown>).version).toBe("4.17.21");
  });

  it("collapses the time map to created and modified", () => {
    // The full map is one ISO timestamp per version and grows without bound.
    const summary = summarizePackument(packument) as Record<string, unknown>;

    expect(summary.created).toBe("2011-01-01");
    expect(summary.modified).toBe("2021-02-20");
    expect(summary).not.toHaveProperty("time");
  });

  it("passes a non-packument through untouched", () => {
    expect(summarizePackument("nope")).toBe("nope");
  });
});

describe("summarizeVersion", () => {
  it("strips registry-internal fields but keeps what a caller reads", () => {
    const version = {
      name: "x",
      version: "1.0.0",
      dependencies: { y: "^1" },
      deprecated: "use z",
      _npmUser: { name: "someone" },
      _nodeVersion: "22.0.0",
      _hasShrinkwrap: false,
      gitHead: "abc123",
      directories: {},
      dist: { tarball: "t", integrity: "i", shasum: "s", signatures: [{ sig: "…" }] },
    };

    const summary = summarizeVersion(version) as Record<string, unknown>;

    expect(summary.dependencies).toEqual({ y: "^1" });
    expect(summary.deprecated).toBe("use z");
    expect(summary).not.toHaveProperty("_npmUser");
    expect(summary).not.toHaveProperty("gitHead");
    // The signature block is large and nobody reads it out of a tool.
    expect(summary.dist).toEqual({ tarball: "t", integrity: "i" });
  });
});

describe("summarizeSearchHit", () => {
  it("keeps the identity and drops the scores", () => {
    // The ranking is already expressed by the result order, so repeating it
    // per hit is pure cost.
    const response = {
      total: 1,
      objects: [
        {
          downloads: { monthly: 100, weekly: 25 },
          dependents: "7",
          searchScore: 2710.92,
          package: {
            name: "@mgcrea/mcp-npm",
            version: "0.1.0",
            description: "MCP server for npm",
            date: "2026-09-01T00:00:00.000Z",
            sanitized_name: "mgcrea-mcp-npm",
            keywords: ["mcp"],
            maintainers: [{ username: "mgcrea", email: "x@y.z" }],
            publisher: { username: "mgcrea", email: "x@y.z" },
            links: { npm: "https://npmjs.com/package/@mgcrea/mcp-npm" },
          },
          score: { final: 1, detail: { popularity: 1, quality: 1, maintenance: 1 } },
        },
      ],
    };

    const summary = summarizeSearchResponse(response) as { results: Record<string, unknown>[] };
    const hit = summary.results[0] as Record<string, unknown>;

    expect(hit.name).toBe("@mgcrea/mcp-npm");
    expect(hit.weekly_downloads).toBe(25);
    expect(hit.publisher).toBe("mgcrea");
    expect(hit).not.toHaveProperty("score");
    expect(hit).not.toHaveProperty("searchScore");
    expect(hit).not.toHaveProperty("maintainers");
  });
});

describe("summarizeAdvisoryResponse", () => {
  it("drops the references blob but keeps the canonical url", () => {
    // `references` is ~1.5 KB of markdown links per advisory.
    const response = {
      lodash: [
        {
          id: 1065,
          title: "Prototype Pollution",
          severity: "high",
          vulnerable_versions: "<4.17.21",
          cvss: { score: 7.4, vectorString: "CVSS:3.1/…" },
          cwe: ["CWE-1321"],
          url: "https://github.com/advisories/GHSA-x",
          references: "- https://a\n- https://b\n".repeat(60),
        },
      ],
    };

    const summary = summarizeAdvisoryResponse(response) as Record<string, unknown>;
    const advisory = (summary.advisories as Record<string, unknown[]>).lodash?.[0] as Record<
      string,
      unknown
    >;

    expect(summary.vulnerable_packages).toBe(1);
    expect(summary.advisory_count).toBe(1);
    expect(advisory.cvss_score).toBe(7.4);
    expect(advisory).not.toHaveProperty("references");
  });

  it("says plainly when nothing is vulnerable", () => {
    // An empty object reads equally as "nothing found" and "the call failed".
    const summary = summarizeAdvisoryResponse({}) as Record<string, unknown>;
    expect(summary.vulnerable_packages).toBe(0);
    expect(summary.advisory_count).toBe(0);
  });
});

describe("summarizeTrustConfig", () => {
  it("renders github and gitlab into one comparable shape", () => {
    // Each provider names the same idea differently; flattening is what lets a
    // caller compare two configs without knowing whose vocabulary is whose.
    const github = summarizeTrustConfig({
      id: "abc",
      type: "github",
      claims: { repository: "mgcrea/x", workflow_ref: { file: "ci.yml" } },
      permissions: ["createPackage"],
    }) as Record<string, unknown>;

    const gitlab = summarizeTrustConfig({
      id: "def",
      type: "gitlab",
      claims: { project_path: "g/x", ci_config_ref_uri: { file: ".gitlab-ci.yml" } },
      permissions: ["createPackage"],
    }) as Record<string, unknown>;

    expect(github).toEqual({
      id: "abc",
      provider: "github",
      repository: "mgcrea/x",
      workflow: "ci.yml",
      permissions: ["createPackage"],
    });
    expect(gitlab.workflow).toBe(".gitlab-ci.yml");
    expect(gitlab.project_path).toBe("g/x");
  });

  it("drops a null environment, which npm sends instead of omitting the key", () => {
    // Observed live: npm returns `environment: null` on a config with none.
    const summary = summarizeTrustConfig({
      id: "abc",
      type: "github",
      claims: { repository: "mgcrea/x", workflow_ref: { file: "ci.yml" }, environment: null },
      permissions: ["createPackage"],
    }) as Record<string, unknown>;

    expect(summary).not.toHaveProperty("environment");
  });

  it("keeps circleci's raw claims, which have no flat equivalent", () => {
    const circle = summarizeTrustConfig({
      id: "ghi",
      type: "circleci",
      claims: { "oidc.circleci.com/org-id": "uuid-1" },
      permissions: ["createPackage"],
    }) as Record<string, unknown>;

    expect(circle.claims).toEqual({ "oidc.circleci.com/org-id": "uuid-1" });
  });
});
