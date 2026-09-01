import { describe, expect, it, vi } from "vitest";

import { escapePackageName, packumentPath } from "#/client/registry";
import { connect, jsonResponse } from "#test/helpers";

describe("scoped package encoding", () => {
  /**
   * Two routes, two encodings. Picking the wrong one yields a 404 that reads
   * like "this package does not exist", which sends people looking in entirely
   * the wrong place.
   */
  it("escapes a scoped name differently for the two route families", () => {
    expect(packumentPath("@babel/core")).toBe("/@babel%2fcore");
    expect(escapePackageName("@babel/core")).toBe("%40babel%2Fcore");
  });

  it("leaves an unscoped name alone in both", () => {
    expect(packumentPath("lodash")).toBe("/lodash");
    expect(escapePackageName("lodash")).toBe("lodash");
  });

  it("uses the packument encoding on npm_get_package", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(jsonResponse({ name: "@babel/core", versions: {} }));
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock);

    await harness.call("npm_get_package", { package: "@babel/core" });

    expect(harness.urls()[0]).toBe("https://registry.npmjs.org/@babel%2fcore");
  });

  it("uses the escaped encoding on the /-/package/ routes", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValue(jsonResponse({}));
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock);

    await harness.call("npm_get_dist_tags", { package: "@babel/core" });

    expect(harness.urls()[0]).toBe(
      "https://registry.npmjs.org/-/package/%40babel%2Fcore/dist-tags",
    );
  });

  it("rejects an invalid package name before spending a request", async () => {
    const harness = await connect({ NPM_TOKEN: "t" });
    const result = await harness.call("npm_get_package", { package: "Not A Package" });

    expect(result.isToolError).toBe(true);
    expect(harness.callCount()).toBe(0);
  });
});

describe("npm_list_versions", () => {
  it("asks for the abbreviated packument", async () => {
    // The full document is megabytes for a popular package, and this tool needs
    // only the names.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(
        jsonResponse({ name: "lodash", "dist-tags": {}, versions: { "1.0.0": {} } }),
      );
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock);

    await harness.call("npm_list_versions", { package: "lodash" });

    expect(harness.headerAt(0, "Accept")).toBe("application/vnd.npm.install-v1+json");
  });
});

describe("npm_get_downloads", () => {
  it("uses the downloads host, not the registry", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(jsonResponse({ downloads: 1, package: "lodash" }));
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock);

    await harness.call("npm_get_downloads", { packages: ["lodash"] });

    expect(harness.urls()[0]).toBe("https://api.npmjs.org/downloads/point/last-week/lodash");
  });

  it("never sends the token to the downloads host", async () => {
    // That API wants no authentication at all, so there is no reason to hand it
    // a credential.
    const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValue(jsonResponse({}));
    const harness = await connect({ NPM_TOKEN: "secret" }, fetchMock);

    await harness.call("npm_get_downloads", { packages: ["lodash"] });

    expect(harness.headerAt(0, "Authorization")).toBeUndefined();
  });

  it("passes a scoped name through unencoded in the single-package form", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValue(jsonResponse({}));
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock);

    await harness.call("npm_get_downloads", { packages: ["@babel/core"] });

    expect(harness.urls()[0]).toContain("/downloads/point/last-week/@babel/core");
  });

  it("refuses scoped names in the bulk form, which npm rejects", async () => {
    const harness = await connect({ NPM_TOKEN: "t" });

    const result = await harness.call("npm_get_downloads", {
      packages: ["lodash", "@babel/core"],
    });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/scoped/);
    expect(harness.callCount()).toBe(0);
  });

  it("refuses a daily series for several packages, which the bulk form cannot do", async () => {
    const harness = await connect({ NPM_TOKEN: "t" });

    const result = await harness.call("npm_get_downloads", {
      packages: ["lodash", "minimist"],
      daily: true,
    });

    expect(result.isToolError).toBe(true);
    expect(harness.callCount()).toBe(0);
  });

  it("refuses more than npm's 128-package bulk limit", async () => {
    const harness = await connect({ NPM_TOKEN: "t" });

    const result = await harness.call("npm_get_downloads", {
      packages: Array.from({ length: 129 }, (_, i) => `pkg-${i}`),
    });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/128/);
  });

  it("switches to the range endpoint for a daily series", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValue(jsonResponse({}));
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock);

    await harness.call("npm_get_downloads", { packages: ["lodash"], daily: true });

    expect(harness.urls()[0]).toContain("/downloads/range/");
  });
});

describe("dist-tags", () => {
  it("sends the bare version string as the body, which is what npm expects", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValue(jsonResponse({}));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    await harness.call("npm_add_dist_tag", {
      package: "@mgcrea/demo",
      tag: "next",
      version: "2.0.0",
    });

    expect(harness.bodyAt(0)).toBe("2.0.0");
    expect(harness.requests()[0]?.init.method).toBe("PUT");
  });

  it("refuses to remove latest, which every package must have", async () => {
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" });

    const result = await harness.call("npm_remove_dist_tag", {
      package: "@mgcrea/demo",
      tag: "latest",
      confirm: true,
    });

    expect(result.isToolError).toBe(true);
    expect(harness.callCount()).toBe(0);
  });
});

describe("npm_audit_dependencies", () => {
  it("works with no token at all and sends no Authorization header", async () => {
    // npm's advisory endpoint takes no authentication, which is what lets an
    // unconfigured server still do something real.
    const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValue(jsonResponse({}));
    const harness = await connect({}, fetchMock);

    const result = await harness.call("npm_audit_dependencies", {
      dependencies: { lodash: ["4.17.20"] },
    });

    expect(result.isToolError).toBeFalsy();
    expect(harness.headerAt(0, "Authorization")).toBeUndefined();
    expect(harness.bodyAt(0)).toEqual({ lodash: ["4.17.20"] });
  });
});

describe("npm_set_package_access", () => {
  it("refuses an update that would change nothing", async () => {
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" });

    const result = await harness.call("npm_set_package_access", {
      package: "@mgcrea/demo",
      confirm: true,
    });

    expect(result.isToolError).toBe(true);
    expect(harness.callCount()).toBe(0);
  });
});
