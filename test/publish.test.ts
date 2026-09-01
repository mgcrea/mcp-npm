import { describe, expect, it, vi } from "vitest";

import { tarballFilename, tarballUrl } from "#/client/tarball";
import { connect, jsonResponse } from "#test/helpers";

const packument = (versions: string[], distTags: Record<string, string>) => ({
  _id: "@mgcrea/demo",
  _rev: "5-abcdef",
  name: "@mgcrea/demo",
  "dist-tags": distTags,
  versions: Object.fromEntries(versions.map((v) => [v, { name: "@mgcrea/demo", version: v }])),
  _revisions: [{ rev: "5-abcdef" }],
  _attachments: {},
});

describe("tarball naming", () => {
  it("drops the scope, as npm does", () => {
    // The name appears in both `_attachments` and the dist.tarball URL, and the
    // two must agree or the registry stores a package whose tarball link 404s.
    expect(tarballFilename("@mgcrea/mcp-npm", "1.0.0")).toBe("mcp-npm-1.0.0.tgz");
    expect(tarballFilename("lodash", "4.17.21")).toBe("lodash-4.17.21.tgz");
  });

  it("builds the canonical tarball URL with the scope intact in the path", () => {
    expect(tarballUrl("https://registry.npmjs.org", "@mgcrea/mcp-npm", "1.0.0")).toBe(
      "https://registry.npmjs.org/@mgcrea/mcp-npm/-/mcp-npm-1.0.0.tgz",
    );
  });
});

describe("npm_unpublish", () => {
  it("reports every step and sends nothing when dry_run is set", async () => {
    // Each step below is a place to damage a package permanently, so the dry
    // run has to show all of them before any of them happen.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(packument(["1.0.0", "1.1.0"], { latest: "1.1.0" })));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_unpublish", {
      package: "@mgcrea/demo",
      version: "1.0.0",
      dry_run: true,
      confirm: true,
    });

    expect(result.dry_run).toBe(true);
    expect((result.steps as unknown[]).length).toBe(3);
    // Only the read happened.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.urls()[0]).toContain("write=true");
  });

  /**
   * Removing the version `latest` points at, without moving the tag, leaves the
   * package with a dist-tag aimed at nothing — and `npm install <pkg>` fails
   * for everyone.
   */
  it("repoints latest before removing the version it pointed at", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(packument(["1.0.0", "1.1.0"], { latest: "1.1.0" })));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_unpublish", {
      package: "@mgcrea/demo",
      version: "1.1.0",
      dry_run: true,
      confirm: true,
    });

    expect(result.dist_tags_after).toEqual({ latest: "1.0.0" });
  });

  it("runs the full five-step sequence, threading a fresh revision", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(packument(["1.0.0", "1.1.0"], { latest: "1.1.0" })))
      .mockResolvedValueOnce(jsonResponse({ ok: true })) // PUT the rewritten document
      .mockResolvedValueOnce(
        jsonResponse({ ...packument(["1.0.0"], { latest: "1.0.0" }), _rev: "6-fresh" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // DELETE the tarball
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_unpublish", {
      package: "@mgcrea/demo",
      version: "1.1.0",
      confirm: true,
    });

    expect(result.unpublished).toBe("1.1.0");
    const requests = harness.requests();

    expect(requests[1]?.init.method).toBe("PUT");
    expect(requests[1]?.url).toContain("/-rev/5-abcdef");
    const written = harness.bodyAt(1) as Record<string, unknown>;
    expect(Object.keys(written.versions as object)).toEqual(["1.0.0"]);
    // CouchDB bookkeeping sent back would make the registry reject the write.
    expect(written).not.toHaveProperty("_revisions");
    expect(written).not.toHaveProperty("_attachments");

    // The PUT invalidates the revision, so the tarball delete needs a new one.
    expect(requests[3]?.init.method).toBe("DELETE");
    expect(requests[3]?.url).toContain("/-rev/6-fresh");
    expect(requests[3]?.url).toContain("/-/demo-1.1.0.tgz");
  });

  it("removes the whole package when the last version would go", async () => {
    // npm requires the whole-package form here; the per-version dance does not
    // apply and would leave an empty document behind.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(packument(["1.0.0"], { latest: "1.0.0" })));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_unpublish", {
      package: "@mgcrea/demo",
      version: "1.0.0",
      dry_run: true,
      confirm: true,
    });

    expect(result.scope).toBe("entire package");
    expect((result.steps as { method: string }[])[0]?.method).toBe("DELETE");
  });

  it("refuses a version that was never published", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(packument(["1.0.0"], { latest: "1.0.0" })));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_unpublish", {
      package: "@mgcrea/demo",
      version: "9.9.9",
      confirm: true,
    });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/no published version 9\.9\.9/);
  });

  it("requires confirm, and never reads the package without it", async () => {
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" });
    const result = await harness.call("npm_unpublish", { package: "@mgcrea/demo" });

    expect(result.isToolError).toBe(true);
    expect(harness.callCount()).toBe(0);
  });
});

describe("npm_deprecate_package", () => {
  it("edits the packument in place and writes the whole document back", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(packument(["1.0.0", "1.1.0"], { latest: "1.1.0" })))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_deprecate_package", {
      package: "@mgcrea/demo",
      message: "Use @mgcrea/other instead",
      version: "1.0.0",
      confirm: true,
    });

    expect(result.action).toBe("deprecated");
    const written = harness.bodyAt(1) as { versions: Record<string, { deprecated?: string }> };
    expect(written.versions["1.0.0"]?.deprecated).toBe("Use @mgcrea/other instead");
    // Only the named version is touched.
    expect(written.versions["1.1.0"]?.deprecated).toBeUndefined();
  });

  it("deprecates every version when none is named", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(packument(["1.0.0", "1.1.0"], { latest: "1.1.0" })))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_deprecate_package", {
      package: "@mgcrea/demo",
      message: "unmaintained",
      confirm: true,
    });

    expect(result.versions).toBe(2);
  });

  it("undeprecates on an empty message", async () => {
    const doc = packument(["1.0.0"], { latest: "1.0.0" });
    (doc.versions["1.0.0"] as Record<string, unknown>).deprecated = "old warning";
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(doc))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_deprecate_package", {
      package: "@mgcrea/demo",
      message: "",
      confirm: true,
    });

    expect(result.action).toBe("undeprecated");
    const written = harness.bodyAt(1) as { versions: Record<string, object> };
    expect(written.versions["1.0.0"]).not.toHaveProperty("deprecated");
  });
});
