import { describe, expect, it, vi } from "vitest";

import {
  packDirectory,
  packEnv,
  resolveNpmCli,
  tarballFilename,
  tarballUrl,
} from "#/client/tarball";
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

/**
 * The regression suite for `spawn npm ENOENT`.
 *
 * npm_publish had no coverage at all, and packDirectory — the one code path
 * that shells out — was never exercised. That is exactly why a bare `npm`
 * spawn shipped and only failed for GUI-spawned servers, which inherit a
 * minimal PATH rather than a shell's.
 */
/** An `exists` probe that finds exactly one path and nothing else. */
const only = (wanted: string) => (path: string) => path === wanted;

describe("resolveNpmCli", () => {
  const NODE = "/opt/homebrew/opt/node@24/bin/node";

  it("runs npm through the Node already running this process, not the shebang", () => {
    const cli = resolveNpmCli({
      execPath: NODE,
      exists: only("/opt/homebrew/opt/node@24/lib/node_modules/npm/bin/npm-cli.js"),
    });

    // The command must be the Node binary. Handing back the `npm` shim instead
    // would rely on its `#!/usr/bin/env node` line, and there is no node on the
    // minimal PATH to satisfy it — which is the trap this whole fix exists for.
    expect(cli.command).toBe(NODE);
    expect(cli.args).toEqual(["/opt/homebrew/opt/node@24/lib/node_modules/npm/bin/npm-cli.js"]);
  });

  it("finds npm shipped as a sibling of the node binary, as an app bundle does", () => {
    const bundled = "/Applications/Bastion.app/Contents/Resources";
    const cli = resolveNpmCli({
      execPath: `${bundled}/node`,
      exists: only(`${bundled}/npm/bin/npm-cli.js`),
    });

    expect(cli.command).toBe(`${bundled}/node`);
    expect(cli.args).toEqual([`${bundled}/npm/bin/npm-cli.js`]);
  });

  it("lets NPM_BIN override every probe", () => {
    const cli = resolveNpmCli({
      npmBin: "/custom/npm/bin/npm-cli.js",
      execPath: NODE,
      exists: only("/custom/npm/bin/npm-cli.js"),
    });

    expect(cli.source).toBe("NPM_BIN");
    expect(cli.command).toBe(NODE);
    expect(cli.args).toEqual(["/custom/npm/bin/npm-cli.js"]);
  });

  it("runs a non-.js NPM_BIN directly rather than feeding it to node", () => {
    const cli = resolveNpmCli({
      npmBin: "/usr/local/bin/npm",
      execPath: NODE,
      exists: only("/usr/local/bin/npm"),
    });

    expect(cli.command).toBe("/usr/local/bin/npm");
    expect(cli.args).toEqual([]);
  });

  it("rejects a missing NPM_BIN instead of letting node fail on the module", () => {
    // Spawning this would SUCCEED — node exists — and then die with a
    // MODULE_NOT_FOUND stack naming node's loader rather than the setting at
    // fault. Caught here, the message names NPM_BIN.
    expect(() =>
      resolveNpmCli({ npmBin: "/nope/npm-cli.js", execPath: NODE, exists: () => false }),
    ).toThrow(/NPM_BIN points at \/nope\/npm-cli\.js/);
  });

  it("leaves a bare command name to PATH rather than existence-checking it", () => {
    const cli = resolveNpmCli({ npmBin: "npm", execPath: NODE, exists: () => false });

    expect(cli.command).toBe("npm");
  });

  it("falls back to PATH, so a terminal-launched server behaves as before", () => {
    const cli = resolveNpmCli({ execPath: NODE, exists: () => false });

    expect(cli.command).toBe("npm");
    expect(cli.args).toEqual([]);
    expect(cli.source).toBe("PATH");
  });
});

describe("packEnv", () => {
  it("prepends the running Node's directory to a minimal PATH", () => {
    // npm pack runs the package's prepack/prepare scripts, so the child is
    // about to run the project's build — which dies on /usr/bin:/bin.
    const env = packEnv("/opt/homebrew/opt/node@24/bin/node", { PATH: "/usr/bin:/bin" });

    expect(env.PATH).toBe("/opt/homebrew/opt/node@24/bin:/usr/bin:/bin");
  });

  it("does not duplicate a directory already on PATH", () => {
    const env = packEnv("/usr/bin/node", { PATH: "/usr/bin:/bin" });

    expect(env.PATH).toBe("/usr/bin:/bin");
  });
});

describe("packDirectory", () => {
  it("packs through the injected exec seam without shelling out", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "npm-mcp-test-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.2.3" }));

    const packed = await packDirectory(dir, {
      exec: async (_dir, destination) => {
        writeFileSync(join(destination, "demo-1.2.3.tgz"), "tarball-bytes");
      },
    });

    expect(packed.name).toBe("demo");
    expect(packed.version).toBe("1.2.3");
    expect(packed.filename).toBe("demo-1.2.3.tgz");
    expect(Buffer.from(packed.data, "base64").toString()).toBe("tarball-bytes");
    expect(packed.integrity).toMatch(/^sha512-/);
  });

  // A scoped package has TWO names for one tarball, and they differ: `npm pack`
  // flattens the scope into the file it writes (`mgcrea-demo-1.2.3.tgz`) while
  // the registry's dist.tarball drops it (`demo-1.2.3.tgz`). Reading the file
  // back under the registry-facing name is an ENOENT that only ever reproduces
  // on a scoped package, which is why the unscoped case above missed it.
  it("finds the tarball npm wrote for a scoped package, not the one it publishes as", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "npm-mcp-test-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@mgcrea/demo", version: "1.2.3" }),
    );

    const packed = await packDirectory(dir, {
      exec: async (_dir, destination) => {
        writeFileSync(join(destination, "mgcrea-demo-1.2.3.tgz"), "scoped-bytes");
      },
    });

    expect(packed.name).toBe("@mgcrea/demo");
    expect(packed.filename).toBe("demo-1.2.3.tgz");
    expect(Buffer.from(packed.data, "base64").toString()).toBe("scoped-bytes");
  });
});
