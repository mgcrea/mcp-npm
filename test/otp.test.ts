import { describe, expect, it, vi } from "vitest";

import { createWebOtpProvider, isOtpChallenge, parseWebChallenge } from "#/client/otp";
import {
  connect,
  jsonResponse,
  otpChallenge,
  otpChallengeBodyOnly,
  recordingOtpProvider,
  unauthorized,
} from "#test/helpers";

const REGISTRY = "https://registry.npmjs.org";

describe("isOtpChallenge", () => {
  it("matches the www-authenticate header npm normally sends", () => {
    const headers = new Headers({ "www-authenticate": "OTP" });
    expect(isOtpChallenge(401, headers, "")).toBe(true);
  });

  it("matches a comma-separated challenge list", () => {
    const headers = new Headers({ "www-authenticate": "Basic realm=x, otp" });
    expect(isOtpChallenge(401, headers, "")).toBe(true);
  });

  /**
   * npm's own client carries this fallback because some registry responses omit
   * the header entirely. Without it those 401s are misread as a bad token.
   */
  it("falls back to the body when the header is missing", () => {
    const body = JSON.stringify({ message: "You must provide a one-time pass." });
    expect(isOtpChallenge(401, new Headers(), body)).toBe(true);
  });

  it("does not fire on a 401 that is really about the token", () => {
    const body = JSON.stringify({ message: "Unauthorized" });
    expect(isOtpChallenge(401, new Headers(), body)).toBe(false);
  });

  it("does not fire on any status other than 401", () => {
    const headers = new Headers({ "www-authenticate": "OTP" });
    expect(isOtpChallenge(403, headers, "one-time pass")).toBe(false);
  });
});

describe("parseWebChallenge", () => {
  const valid = JSON.stringify({
    authUrl: "https://www.npmjs.com/auth/cli/abc-123",
    doneUrl: "https://registry.npmjs.org/-/v1/done?authId=abc-123",
  });

  it("accepts npm's genuine cross-domain pair", () => {
    // The API is on npmjs.ORG while the login page is on npmjs.COM. That is
    // npm's real topology, not an oversight, so it is allow-listed by name.
    expect(parseWebChallenge(valid, REGISTRY)).toEqual({
      authUrl: "https://www.npmjs.com/auth/cli/abc-123",
      doneUrl: "https://registry.npmjs.org/-/v1/done?authId=abc-123",
    });
  });

  it("refuses an authUrl on some other host", () => {
    // Otherwise every 401 on this path is a drive-by browser-open primitive.
    const body = JSON.stringify({
      authUrl: "https://evil.example.com/auth",
      doneUrl: "https://registry.npmjs.org/-/v1/done",
    });
    expect(parseWebChallenge(body, REGISTRY)).toBeUndefined();
  });

  it("refuses a doneUrl off the registry origin", () => {
    // doneUrl hands back a bearer-equivalent code; it must be the registry.
    const body = JSON.stringify({
      authUrl: "https://www.npmjs.com/auth/cli/abc",
      doneUrl: "https://evil.example.com/done",
    });
    expect(parseWebChallenge(body, REGISTRY)).toBeUndefined();
  });

  it("refuses a plaintext authUrl", () => {
    const body = JSON.stringify({
      authUrl: "http://www.npmjs.com/auth/cli/abc",
      doneUrl: "https://registry.npmjs.org/-/v1/done",
    });
    expect(parseWebChallenge(body, REGISTRY)).toBeUndefined();
  });

  it("requires a private registry to host its own auth page", () => {
    // The npmjs.com allowance is specific to the public registry.
    const body = JSON.stringify({
      authUrl: "https://www.npmjs.com/auth/cli/abc",
      doneUrl: "https://npm.internal.example/-/v1/done",
    });
    expect(parseWebChallenge(body, "https://npm.internal.example")).toBeUndefined();
  });

  it("returns undefined for a body that is not a challenge", () => {
    expect(parseWebChallenge("not json", REGISTRY)).toBeUndefined();
    expect(parseWebChallenge(JSON.stringify({ message: "nope" }), REGISTRY)).toBeUndefined();
  });
});

describe("the OTP retry in request()", () => {
  it("answers a challenge and retries the same call carrying npm-otp", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(otpChallenge())
      .mockResolvedValueOnce(jsonResponse([]));
    const otp = recordingOtpProvider(["code-42"]);
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock, { otpProvider: otp });

    const result = await harness.call("npm_get_trusted_publisher", { package: "lodash" });

    expect(result.isToolError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The first attempt goes out bare — that is what elicits the challenge.
    expect(harness.headerAt(0, "npm-otp")).toBeUndefined();
    expect(harness.headerAt(1, "npm-otp")).toBe("code-42");
  });

  it("recognises a challenge that arrives with no www-authenticate header", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(otpChallengeBodyOnly())
      .mockResolvedValueOnce(jsonResponse([]));
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock, {
      otpProvider: recordingOtpProvider(["code-body"]),
    });

    const result = await harness.call("npm_get_trusted_publisher", { package: "lodash" });

    expect(result.isToolError).toBeFalsy();
    expect(harness.headerAt(1, "npm-otp")).toBe("code-body");
  });

  /**
   * The single most important assertion in the suite. The client's other 401
   * branch invalidates the token and retries; if an OTP challenge reached it,
   * a working token would be discarded and the call would fail naming the
   * wrong cause entirely.
   */
  it("does NOT invalidate the token when the 401 is an OTP challenge", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(otpChallenge())
      .mockResolvedValueOnce(jsonResponse([]));
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock, {
      otpProvider: recordingOtpProvider(),
    });

    await harness.call("npm_get_trusted_publisher", { package: "lodash" });

    expect(harness.tokenInvalidations()).toBe(0);
  });

  it("still invalidates the token on a 401 that is not a challenge", async () => {
    // A fresh Response per call: a body can only be read once, and this path
    // deliberately retries.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockImplementation(async () => unauthorized());
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock, {
      otpProvider: recordingOtpProvider(),
    });

    const result = await harness.call("npm_whoami");

    expect(result.isToolError).toBe(true);
    expect(harness.tokenInvalidations()).toBeGreaterThan(0);
    expect(String(result.remedy)).toMatch(/npm login|NPM_TOKEN/);
  });

  it("gives up after one rejected code rather than prompting again", async () => {
    // Two acquisitions would mean two browser prompts for one call, and a
    // provider that keeps minting would loop without bound.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockImplementation(async () => otpChallenge());
    const otp = recordingOtpProvider(["first", "second"]);
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock, { otpProvider: otp });

    const result = await harness.call("npm_get_trusted_publisher", { package: "lodash" });

    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toMatch(/rejected the one-time password/);
    expect(otp.mints).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a usable error when no code can be obtained at all", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockImplementation(async () => otpChallenge());
    const harness = await connect({ NPM_TOKEN: "t", NPM_OTP_MODE: "none" }, fetchMock);

    const result = await harness.call("npm_get_trusted_publisher", { package: "lodash" });

    expect(result.isToolError).toBe(true);
    // The authorize URL must survive into the result, or the user has no way
    // forward from a headless server.
    expect(result.authorize_url).toBe("https://www.npmjs.com/auth/cli/test-uuid");
    expect(String(result.remedy)).toMatch(/unattended/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("which calls opt into the OTP dance", () => {
  it("sends npm-auth-type on the trust endpoints", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValue(jsonResponse([]));
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock);

    await harness.call("npm_get_trusted_publisher", { package: "lodash" });

    expect(harness.headerAt(0, "npm-auth-type")).toBe("web");
    expect(harness.headerAt(0, "npm-command")).toBe("trust");
  });

  it("does not send it on ordinary reads", async () => {
    // A packument fetch has no business advertising a web auth flow.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(jsonResponse({ name: "x" }));
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock);

    await harness.call("npm_get_package", { package: "lodash" });

    expect(harness.headerAt(0, "npm-auth-type")).toBeUndefined();
  });
});

describe("npm_auth_otp", () => {
  it("accepts a code and caches it without touching the network", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValue(jsonResponse({}));
    const otp = recordingOtpProvider();
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock, { otpProvider: otp });

    const result = await harness.call("npm_auth_otp", { code: "123456" });

    expect(result.ok).toBe(true);
    expect(result.method).toBe("provided");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(otp.peek("any").cached).toBe(true);
  });

  it("explains itself when given neither a code nor a package", async () => {
    const harness = await connect({ NPM_TOKEN: "t" });
    const result = await harness.call("npm_auth_otp", {});

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/`code`.*`package`/s);
  });
});

/**
 * These cover the failure that made npm_auth_otp lie: it reported the probe
 * request's own error as though the one-time-password flow had failed. The
 * expensive half is the second test — a code that WAS minted, reported as a
 * failure, costs a second browser authorization to discover was never needed.
 */
describe("npm_auth_otp", () => {
  it("reports a probe failure without claiming the OTP flow failed", async () => {
    // npm's verbatim per-package refusal, arriving before any challenge — so
    // nothing was minted and this is not an OTP problem at all.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(
        jsonResponse(
          { success: false, error: "You may not perform that action with these credentials." },
          { status: 403 },
        ),
      );
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock, {
      otpProvider: recordingOtpProvider(),
    });

    const result = await harness.call("npm_auth_otp", { package: "tydom-client" });

    expect(result.isToolError).toBeFalsy();
    expect(result.ok).toBe(false);
    expect((result.probe as Record<string, unknown>).package).toBe("tydom-client");
    expect(String((result.probe as Record<string, unknown>).error)).toMatch(/403/);
    expect(String(result.note)).toMatch(/not an OTP problem/i);
  });

  it("reports ok when a code was minted, even though the probe then failed", async () => {
    // The 401 challenge mints and caches a code; the retry with it attached is
    // refused for an unrelated reason. The code is real, cached and usable, and
    // saying otherwise burns a second authorization for nothing.
    let call = 0;
    const fetchMock = vi.fn<() => Promise<Response>>().mockImplementation(async () => {
      call += 1;
      if (call === 1) return otpChallenge();
      return jsonResponse(
        { error: "You may not perform that action with these credentials." },
        { status: 403 },
      );
    });
    const otp = recordingOtpProvider(["minted-code"]);
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock, { otpProvider: otp });

    const result = await harness.call("npm_auth_otp", { package: "tydom-client" });

    expect(result.isToolError).toBeFalsy();
    expect(otp.mints).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.probe).toBeDefined();
    expect(String(result.note)).toMatch(/WAS obtained/);
  });

  it("still caches a code handed over directly, with no network call", async () => {
    const harness = await connect({ NPM_TOKEN: "t" }, undefined, {
      otpProvider: recordingOtpProvider(),
    });

    const result = await harness.call("npm_auth_otp", { code: "123456" });

    expect(result.ok).toBe(true);
    expect(result.method).toBe("provided");
    expect(harness.callCount()).toBe(0);
  });
});

describe("wait: only the deliberate callers block", () => {
  it("createWebOtpProvider returns undefined immediately when wait is unset, never polling doneUrl", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(jsonResponse({ token: "x" }));
    const provider = createWebOtpProvider({
      registry: REGISTRY,
      fetch: fetchMock,
      autoOpen: false,
    });

    const code = await provider.getOtp({
      command: "trust",
      identity: "id-1",
      challenge: {
        authUrl: "https://www.npmjs.com/auth/cli/x",
        doneUrl: `${REGISTRY}/-/v1/done?authId=x`,
      },
    });

    expect(code).toBeUndefined();
    // No cached entry existed and wait was never requested, so mint() — the
    // thing that would call doneUrl — must never run at all.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("createWebOtpProvider still blocks and polls when wait is true", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(jsonResponse({ token: "waited-code" }));
    const provider = createWebOtpProvider({
      registry: REGISTRY,
      fetch: fetchMock,
      autoOpen: false,
      pollIntervalMs: 0,
    });

    const code = await provider.getOtp({
      command: "trust",
      identity: "id-2",
      wait: true,
      challenge: {
        authUrl: "https://www.npmjs.com/auth/cli/x",
        doneUrl: `${REGISTRY}/-/v1/done?authId=x`,
      },
    });

    expect(code).toBe("waited-code");
    expect(fetchMock).toHaveBeenCalledWith(`${REGISTRY}/-/v1/done?authId=x`, expect.anything());
  });

  it("npm_get_trusted_publisher fails fast against the REAL provider — one fetch, no doneUrl poll", async () => {
    // No otpProvider override: this is the default createWebOtpProvider(),
    // exercised through the actual tool rather than a recording mock.
    const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValue(otpChallenge());
    const harness = await connect({ NPM_TOKEN: "t" }, fetchMock);

    const result = await harness.call("npm_get_trusted_publisher", { package: "lodash" });

    expect(result.isToolError).toBe(true);
    expect(result.authorize_url).toBe("https://www.npmjs.com/auth/cli/test-uuid");
    // One call for the 401 itself. A blocking wait would have meant a second
    // (or many) calls to doneUrl before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("npm_auth_otp still waits and succeeds against the REAL provider", async () => {
    const fetchMock = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async (url, init) => {
        if (url.includes("/-/v1/done")) return jsonResponse({ token: "confirmed-code" });
        // The bare first attempt gets challenged; the retry that carries the
        // confirmed code — the whole point of this test — has to succeed, or
        // registry.ts correctly reads it as a rejected code and invalidates it.
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.["npm-otp"]) return jsonResponse([]);
        return otpChallenge();
      });
    const harness = await connect({ NPM_TOKEN: "t", NPM_OTP_TIMEOUT_MS: "5000" }, fetchMock);

    const result = await harness.call("npm_auth_otp", { package: "lodash", open: false });

    expect(result.ok).toBe(true);
    expect(result.method).toBe("web");
  });
});
