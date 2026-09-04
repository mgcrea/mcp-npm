import { describe, expect, it, vi } from "vitest";

import { createTotpOtpProvider, type OtpProvider } from "#/client/otp";
import { connect, jsonResponse, otpChallenge, otpChallengeBodyOnly } from "#test/helpers";

/** The RFC 6238 SHA-1 seed, base32-encoded. */
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const seedFor =
  (secret = SEED) =>
  async () => ({
    secret,
    digits: 6,
    period: 30,
    algorithm: "SHA1",
  });

const provider = (opts: Partial<Parameters<typeof createTotpOtpProvider>[0]> = {}): OtpProvider =>
  createTotpOtpProvider({
    label: "npm",
    keychainService: "test.service",
    loadSeed: seedFor(),
    ...opts,
  });

describe("createTotpOtpProvider", () => {
  it("mints the RFC 6238 code for the seed", async () => {
    const otp = provider({ now: () => 59_000 });
    expect(await otp.getOtp({ command: "trust", identity: "id", challenged: true })).toBe("287082");
  });

  // Rule 1: an eager pre-flight call must stay empty-handed, because the
  // un-factored first attempt is the only thing that elicits the challenge.
  it("returns nothing when there is no challenge and nothing cached", async () => {
    const otp = provider({ now: () => 59_000 });
    expect(await otp.getOtp({ command: "trust", identity: "id" })).toBeUndefined();
  });

  // Unlike the web provider, `wait` is irrelevant here: there is no browser to
  // open and no human to wait for, so honouring it would block the unattended
  // calls this mode exists to unblock.
  it("mints on a challenge even when nobody asked it to wait", async () => {
    const otp = provider({ now: () => 59_000 });
    expect(await otp.getOtp({ command: "trust", identity: "id", challenged: true })).toBe("287082");
  });

  it("caches across a batch, so twelve packages spend one mint", async () => {
    let mints = 0;
    const otp = provider({
      now: () => 59_000,
      loadSeed: async () => {
        mints += 1;
        return { secret: SEED, digits: 6, period: 30, algorithm: "SHA1" };
      },
    });

    const codes: (string | undefined)[] = [];
    for (let i = 0; i < 12; i += 1) {
      codes.push(await otp.getOtp({ command: "trust", identity: "id", challenged: true }));
    }
    expect(mints).toBe(1);
    expect(new Set(codes)).toEqual(new Set(["287082"]));
  });

  /**
   * The trap this whole provider is shaped around. TOTP verification is
   * single-use, and inside one 30-second window the naive implementation returns
   * the identical string forever — so a code npm already consumed would be
   * resent and rejected, spending the request's single OTP attempt.
   */
  it("waits for the next window rather than replaying a spent code", async () => {
    let clock = 59_000;
    const slept: number[] = [];
    const otp = provider({
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    const first = await otp.getOtp({ command: "trust", identity: "id", challenged: true });
    otp.invalidate(first!);

    const second = await otp.getOtp({ command: "trust", identity: "id", challenged: true });
    expect(second).not.toBe(first);
    // 59s into the epoch, one second remains of the current 30-second window.
    expect(slept).toEqual([1000]);
  });

  it("gives up rather than looping when the next window is also spent", async () => {
    let clock = 59_000;
    const otp = provider({ now: () => clock, sleep: async (ms) => void (clock += ms) });

    const first = await otp.getOtp({ command: "trust", identity: "id", challenged: true });
    const second = await otp.getOtp({ command: "trust", identity: "id", challenged: true });
    expect(second).toBe(first); // cached

    otp.invalidate(first!);
    const third = await otp.getOtp({ command: "trust", identity: "id", challenged: true });
    otp.invalidate(third!);
    // Both windows are now burnt and the clock has moved past them, so the next
    // mint lands on a fresh window rather than throwing.
    expect(await otp.getOtp({ command: "trust", identity: "id", challenged: true })).not.toBe(
      third,
    );
  });

  it("accepts a code the user typed, so npm_auth_otp keeps working", async () => {
    const otp = provider({ now: () => 59_000 });
    otp.offer("123456", "id");
    expect(await otp.getOtp({ command: "trust", identity: "id" })).toBe("123456");
  });

  it("reports its mode and never the code", async () => {
    const otp = provider({ now: () => 59_000 });
    await otp.getOtp({ command: "trust", identity: "id", challenged: true });
    const status = otp.peek("id");
    expect(status.mode).toBe("totp");
    expect(status.cached).toBe(true);
    expect(JSON.stringify(status)).not.toContain("287082");

    otp.clear();
    expect(otp.peek("id").cached).toBe(false);
  });

  /**
   * Verified live on 2026-09-04: a TOTP typed straight from an authenticator was
   * accepted by npm on both the publish and trusted-publisher endpoints with
   * `npm-auth-type: web`. So a locally minted code needs no special header, and
   * `web` is kept because it is also what makes npm return {authUrl, doneUrl} on
   * a challenge — the only route a human has to recover from a bad code.
   */
  it("sends npm-auth-type: web like every other mode", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(otpChallenge())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock, {
      otpProvider: provider({ now: () => 59_000 }),
    });

    await harness.call("npm_get_trusted_publisher", { package: "@mgcrea/mcp-npm" });
    expect(harness.headerAt(0, "npm-auth-type")).toBe("web");
    expect(harness.headerAt(1, "npm-auth-type")).toBe("web");
  });

  it("lets NPM_OTP_AUTH_TYPE override it, since this is npm's negotiation to change", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(otpChallenge())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const harness = await connect(
      { NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1", NPM_OTP_AUTH_TYPE: "legacy" },
      fetchMock,
      { otpProvider: provider({ now: () => 59_000 }) },
    );

    await harness.call("npm_get_trusted_publisher", { package: "@mgcrea/mcp-npm" });
    expect(harness.headerAt(1, "npm-auth-type")).toBe("legacy");
  });
});

describe("totp mode end to end through the client", () => {
  it("answers a challenge and retries carrying npm-otp", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(otpChallenge())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock, {
      otpProvider: provider({ now: () => 59_000 }),
    });

    await harness.call("npm_get_trusted_publisher", { package: "@mgcrea/mcp-npm" });

    expect(harness.callCount()).toBe(2);
    // The first attempt must go out bare — it is what produces the challenge.
    expect(harness.headerAt(0, "npm-otp")).toBeUndefined();
    expect(harness.headerAt(1, "npm-otp")).toBe("287082");
  });

  /**
   * npm only returns a parseable {authUrl, doneUrl} when the request asked for
   * the web flow — so in totp mode a real challenge arrives with nothing to
   * parse. `challenged` is what carries the fact regardless.
   */
  it("mints from a challenge that carries no parseable web URLs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(otpChallengeBodyOnly())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock, {
      otpProvider: provider({ now: () => 59_000 }),
    });

    await harness.call("npm_get_trusted_publisher", { package: "@mgcrea/mcp-npm" });
    expect(harness.headerAt(1, "npm-otp")).toBe("287082");
  });

  // The expensive bug this fork exists to prevent: a challenge 401 reaching the
  // generic 401 branch throws away a working token and fails naming the wrong cause.
  it("does not invalidate the token on a challenge", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(otpChallenge())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock, {
      otpProvider: provider({ now: () => 59_000 }),
    });

    await harness.call("npm_get_trusted_publisher", { package: "@mgcrea/mcp-npm" });
    expect(harness.tokenInvalidations()).toBe(0);
  });

  it("stops after one rejected code rather than looping on mints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(otpChallenge());

    const harness = await connect({ NPM_TOKEN: "t", NPM_ALLOW_WRITES: "1" }, fetchMock, {
      otpProvider: provider({ now: () => 59_000 }),
    });

    const res = await harness.call("npm_get_trusted_publisher", { package: "@mgcrea/mcp-npm" });
    expect(res.isToolError).toBe(true);
    // One bare attempt plus one carrying the code. No third.
    expect(harness.callCount()).toBe(2);
  });

  it("reports totp mode, and drops the unattended-is-impossible note", async () => {
    const harness = await connect({ NPM_TOKEN: "t" }, undefined, {
      otpProvider: provider({ now: () => 59_000 }),
    });
    const res = await harness.call("npm_auth_status");
    expect((res.otp as { mode: string }).mode).toBe("totp");
    expect(String(res.note)).toContain("unattended");
    expect(String(res.note)).not.toContain("not possible");
  });
});
