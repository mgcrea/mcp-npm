import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { reloadableTokenProvider } from "#/client/auth";
import { resolveToken, type ResolvedToken } from "#/config";
import { connect, jsonResponse } from "#test/helpers";

/**
 * The incident these cover.
 *
 * An npm token expired. `npm login` wrote a fresh one to ~/.npmrc and `npm
 * whoami` in a terminal worked immediately. This server kept sending the dead
 * token for the rest of its life, because it had captured the string at
 * construction — so every call answered 401 while the evidence in front of the
 * user said the credential was fine. Restarting the process was the only fix,
 * and nothing in the error text pointed at it.
 */
describe("reloading the token from its source", () => {
  const dirs: string[] = [];
  const tempNpmrc = (contents: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-npm-"));
    dirs.push(dir);
    const path = join(dir, ".npmrc");
    writeFileSync(path, contents);
    return path;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("picks up a token rewritten underneath it", async () => {
    let stored: ResolvedToken = { token: "stale", tokenSource: "npmrc" };
    const provider = reloadableTokenProvider(() => stored);

    expect(await provider.getToken()).toBe("stale");

    stored = { token: "fresh", tokenSource: "npmrc" };
    // Nothing has re-read yet: the point is that the old value survives until
    // something asks, rather than being re-read on every single request.
    expect(await provider.getToken()).toBe("stale");

    expect(provider.reload()).toMatchObject({ changed: true, hadToken: true, hasToken: true });
    expect(await provider.getToken()).toBe("fresh");
  });

  it("reports a move between layers, because that changes which file to edit", () => {
    let stored: ResolvedToken = { token: "a", tokenSource: "npmrc" };
    const provider = reloadableTokenProvider(() => stored);

    stored = { token: "b", tokenSource: "environment" };
    expect(provider.reload()).toMatchObject({
      changed: true,
      source: "environment",
      previousSource: "npmrc",
    });
    expect(provider.source()).toBe("environment");
  });

  it("says `changed: false` when the bytes are identical", () => {
    const provider = reloadableTokenProvider(() => ({ token: "same", tokenSource: "npmrc" }));
    expect(provider.reload().changed).toBe(false);
    expect(provider.invalidate()).toBe(false);
  });

  it("keeps a working token when the re-read throws", async () => {
    let broken = false;
    const provider = reloadableTokenProvider(() => {
      if (broken) throw new Error("config file is not valid JSON");
      return { token: "good", tokenSource: "file" };
    });

    expect(await provider.getToken()).toBe("good");
    broken = true;

    // A typo in a config file must not cost you the credential you already had.
    expect(provider.reload()).toMatchObject({ changed: false, hasToken: true });
    expect(await provider.getToken()).toBe("good");
  });

  it("re-reads ~/.npmrc from disk", () => {
    const npmrc = tempNpmrc("//registry.npmjs.org/:_authToken=first\n");
    expect(resolveToken({}, "/nonexistent/config.json", npmrc)).toEqual({
      token: "first",
      tokenSource: "npmrc",
    });

    writeFileSync(npmrc, "//registry.npmjs.org/:_authToken=second\n");
    expect(resolveToken({}, "/nonexistent/config.json", npmrc)).toEqual({
      token: "second",
      tokenSource: "npmrc",
    });
  });
});

const unauthorized = (): Response =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

describe("the 401 retry", () => {
  it("does not spend the retry budget resending a token npm just refused", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockImplementation(async () => unauthorized());
    // The token never moves, so every retry would send the identical bytes and
    // arrive at the identical 401 — several seconds later, with the cause no
    // clearer than it was on the first attempt.
    const harness = await connect({ NPM_TOKEN: "dead" }, fetchMock, {
      readToken: () => ({ token: "dead", tokenSource: "environment" }),
    });

    const result = await harness.call("npm_whoami");

    expect(result.isToolError).toBe(true);
    expect(harness.callCount()).toBe(1);
  });

  it("retries once when the token changed on disk, and succeeds", async () => {
    let stored: ResolvedToken = { token: "dead", tokenSource: "npmrc" };
    const seen: (string | undefined)[] = [];
    const fetchMock = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockImplementation(async (_url, init) => {
        const auth = (init.headers as Record<string, string>).Authorization;
        seen.push(auth);
        if (auth === "Bearer dead") {
          // Simulate `npm login` landing between the two attempts.
          stored = { token: "fresh", tokenSource: "npmrc" };
          return unauthorized();
        }
        return jsonResponse({ username: "mgcrea" });
      });

    const harness = await connect({ NPM_TOKEN: "dead" }, fetchMock, {
      readToken: () => stored,
    });

    const result = await harness.call("npm_whoami");

    expect(result.isToolError).toBe(false);
    expect(seen).toEqual(["Bearer dead", "Bearer fresh"]);
  });
});

describe("npm_auth_reload", () => {
  it("is registered even with no token, because that is when it is needed", async () => {
    const harness = await connect({}, undefined, {
      readToken: () => ({ token: undefined, tokenSource: undefined }),
    });
    expect(await harness.toolNames()).toContain("npm_auth_reload");
  });

  it("reports the change and never the token itself", async () => {
    let stored: ResolvedToken = { token: "stale", tokenSource: "npmrc" };
    const harness = await connect({ NPM_TOKEN: "stale" }, undefined, {
      readToken: () => stored,
    });

    stored = { token: "fresh-and-secret", tokenSource: "npmrc" };
    const result = await harness.call("npm_auth_reload");

    expect(result.isToolError).toBe(false);
    expect(result).toMatchObject({ changed: true, has_token: true, token_source: "npmrc" });
    expect(JSON.stringify(result)).not.toContain("fresh-and-secret");
  });

  it("says what to do next when there is still nothing to read", async () => {
    const harness = await connect({}, undefined, {
      readToken: () => ({ token: undefined, tokenSource: undefined }),
    });

    const result = await harness.call("npm_auth_reload");

    expect(result).toMatchObject({ changed: false, has_token: false, token_source: null });
    expect(String(result.next_step)).toMatch(/npm login/);
  });
});
