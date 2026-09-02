import { afterEach, describe, expect, it, vi } from "vitest";

import { connect, jsonResponse, otpChallenge, recordingOtpProvider } from "#test/helpers";

const GITHUB_ARGS = {
  provider: "github",
  repository: "mgcrea/mcp-ovh",
  workflow_filename: "ci.yml",
  confirm: true,
};

const existingConfig = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-2222-3333-4444-555555555555",
  type: "github",
  claims: { repository: "mgcrea/mcp-ovh", workflow_ref: { file: "ci.yml" } },
  permissions: ["createPackage"],
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("npm_set_trusted_publisher", () => {
  it("creates a configuration when the package has none", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse([])) // GET /trust — nothing configured
      .mockResolvedValueOnce(jsonResponse([existingConfig()])); // POST /trust
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_set_trusted_publisher", {
      package: "@mgcrea/mcp-ovh",
      ...GITHUB_ARGS,
    });

    expect(result.isToolError).toBeFalsy();
    expect(result.status).toBe("created");

    // Scoped names are fully escaped on the /-/package/ routes.
    expect(harness.urls()[0]).toContain("/-/package/%40mgcrea%2Fmcp-ovh/trust");

    // The POST body is an ARRAY, not the object it looks like it should be.
    const body = harness.bodyAt(1) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toEqual({
      type: "github",
      claims: { repository: "mgcrea/mcp-ovh", workflow_ref: { file: "ci.yml" } },
      permissions: ["createPackage"],
    });
  });

  it("reports `unchanged` and writes nothing when the config already matches", async () => {
    // Without this, re-running a batch would spend three OTP uses per package
    // to change nothing and burn through npm's window.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse([existingConfig()]));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_set_trusted_publisher", {
      package: "@mgcrea/mcp-ovh",
      ...GITHUB_ARGS,
    });

    expect(result.status).toBe("unchanged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to overwrite a different config unless replace_existing is set", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValueOnce(
      jsonResponse([
        existingConfig({
          claims: { repository: "someone/else", workflow_ref: { file: "x.yml" } },
        }),
      ]),
    );
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_set_trusted_publisher", {
      package: "@mgcrea/mcp-ovh",
      ...GITHUB_ARGS,
    });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/already has a trusted publisher/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * npm has no update endpoint, so a change is genuinely delete-then-create.
   * Keeping both inside one tool is a safety property: split apart, a caller
   * can delete and then fail to create, leaving the package with NO trusted
   * publisher and its release pipeline silently broken.
   */
  it("deletes then recreates when replacing, and reports the id it removed", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        jsonResponse([
          existingConfig({ claims: { repository: "old/repo", workflow_ref: { file: "old.yml" } } }),
        ]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse([existingConfig()]));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_set_trusted_publisher", {
      package: "@mgcrea/mcp-ovh",
      ...GITHUB_ARGS,
      replace_existing: true,
    });

    expect(result.status).toBe("replaced");
    expect(result.replaced_id).toBe("11111111-2222-3333-4444-555555555555");

    const requests = harness.requests();
    expect(requests[1]?.init.method).toBe("DELETE");
    expect(requests[1]?.url).toContain("/trust/11111111-2222-3333-4444-555555555555");
    expect(requests[2]?.init.method).toBe("POST");
  });

  it("names the missing field for the provider actually chosen", async () => {
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" });

    const result = await harness.call("npm_set_trusted_publisher", {
      package: "lodash",
      provider: "gitlab",
      repository: "mgcrea/x", // a GitHub field, useless to GitLab
      workflow_filename: "ci.yml",
      confirm: true,
    });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/project_path/);
    expect(harness.callCount()).toBe(0);
  });

  it("rejects a workflow path where npm wants a bare filename", async () => {
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" });

    const result = await harness.call("npm_set_trusted_publisher", {
      package: "lodash",
      provider: "github",
      repository: "mgcrea/x",
      workflow_filename: ".github/workflows/ci.yml",
      confirm: true,
    });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/bare filename/);
  });

  it("builds gitlab claims under npm's oddly-named ci_config_ref_uri key", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    await harness.call("npm_set_trusted_publisher", {
      package: "lodash",
      provider: "gitlab",
      project_path: "my-group/my-package",
      workflow_filename: ".gitlab-ci.yml",
      environment: "production",
      confirm: true,
    });

    expect((harness.bodyAt(1) as { claims: unknown }[])[0]?.claims).toEqual({
      project_path: "my-group/my-package",
      ci_config_ref_uri: { file: ".gitlab-ci.yml" },
      environment: "production",
    });
  });
});

describe("npm_set_trusted_publisher_batch", () => {
  const packages = Array.from({ length: 12 }, (_, i) => `@mgcrea/pkg-${i}`);

  /**
   * The single assertion that pins the whole design. Twelve packages must cost
   * ONE browser authorization, not twelve — which is the only reason the batch
   * tool exists at all.
   */
  it("spends one OTP authorization across twelve packages", async () => {
    vi.useFakeTimers();
    let first = true;
    const fetchMock = vi.fn<() => Promise<Response>>().mockImplementation(async () => {
      // Only the very first call is challenged; afterwards the cached code
      // rides along, exactly as npm's cooldown allows.
      if (first) {
        first = false;
        return otpChallenge();
      }
      return jsonResponse([]);
    });
    const otp = recordingOtpProvider(["only-code"]);
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock, {
      otpProvider: otp,
    });

    const pending = harness.call("npm_set_trusted_publisher_batch", {
      packages,
      ...GITHUB_ARGS,
    });
    await vi.advanceTimersByTimeAsync(2000 * packages.length);
    const result = await pending;

    expect(result.isToolError).toBeFalsy();
    expect(otp.mints).toBe(1);
    expect((result.summary as Record<string, number>).created).toBe(12);
  });

  it("stops the whole run on a 403, and reports what is left to resume", async () => {
    // A 403 is about the token or the account, so every remaining package would
    // fail identically. Twelve copies of one error is worse than one.
    vi.useFakeTimers();
    let call = 0;
    const fetchMock = vi.fn<() => Promise<Response>>().mockImplementation(async () => {
      call += 1;
      if (call <= 2) return jsonResponse([]);
      return jsonResponse(
        // npm's verbatim message. It says "two-factor" as well, so the
        // bypass branch has to win over the generic 2FA one.
        {
          error:
            "Granular access tokens that bypass two-factor authentication may not perform this action.",
        },
        { status: 403 },
      );
    });
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock, {
      otpProvider: recordingOtpProvider(),
    });

    const pending = harness.call("npm_set_trusted_publisher_batch", {
      packages: packages.slice(0, 5),
      ...GITHUB_ARGS,
    });
    await vi.advanceTimersByTimeAsync(2000 * 5);
    const result = await pending;

    expect(result.aborted_after).toBe(2);
    expect(result.remaining).toEqual(["@mgcrea/pkg-2", "@mgcrea/pkg-3", "@mgcrea/pkg-4"]);
    expect(String(result.reason)).toMatch(/bypass/i);
  });

  /**
   * The counterpart to the test above, and the one that was missing. npm uses the
   * same flat 403 for "this token cannot touch THIS package" as for a token that
   * can touch nothing — observed on one account, where a scoped package's trust
   * config read fine while an unscoped one was refused. Aborting on the first of
   * those abandons packages that would have succeeded.
   */
  it("keeps going after a 403 that is about one package, not the account", async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchMock = vi.fn<() => Promise<Response>>().mockImplementation(async () => {
      call += 1;
      // Package 2's GET /trust is refused; every other call succeeds.
      if (call === 3) {
        return jsonResponse(
          { success: false, error: "You may not perform that action with these credentials." },
          { status: 403 },
        );
      }
      return jsonResponse([]);
    });
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock, {
      otpProvider: recordingOtpProvider(),
    });

    const pending = harness.call("npm_set_trusted_publisher_batch", {
      packages: packages.slice(0, 4),
      ...GITHUB_ARGS,
    });
    await vi.advanceTimersByTimeAsync(2000 * 4);
    const result = await pending;

    expect(result.aborted_after).toBeUndefined();
    expect(result.remaining).toBeUndefined();
    const summary = result.summary as Record<string, number>;
    expect(summary.requested).toBe(4);
    expect(summary.failed).toBe(1);
    expect(summary.created).toBe(3);
  });

  it("caps the batch so a full run stays inside npm's cooldown window", async () => {
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" });

    const result = await harness.call("npm_set_trusted_publisher_batch", {
      packages: Array.from({ length: 26 }, (_, i) => `pkg-${i}`),
      ...GITHUB_ARGS,
    });

    expect(result.isToolError).toBe(true);
    expect(harness.callCount()).toBe(0);
  });
});

describe("npm_delete_trusted_publisher", () => {
  it("refuses a stale id rather than deleting the wrong configuration", async () => {
    // These ids are regenerated whenever a publisher is recreated, so a reused
    // one is a real hazard.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse([existingConfig()]));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_delete_trusted_publisher", {
      package: "lodash",
      id: "99999999-8888-4777-a666-555555555555",
      confirm: true,
    });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/has id 11111111/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the package's single configuration when no id is given", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse([existingConfig()]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock);

    const result = await harness.call("npm_delete_trusted_publisher", {
      package: "lodash",
      confirm: true,
    });

    expect(result.deleted).toBe(true);
    expect(harness.requests()[1]?.init.method).toBe("DELETE");
  });
});
