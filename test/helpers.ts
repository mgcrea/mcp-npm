import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { vi } from "vitest";

import { staticTokenProvider } from "#/client/auth";
import type { OtpProvider, OtpRequest } from "#/client/otp";
import { loadConfig, type Config } from "#/config";
import { createServer } from "#/server";

/**
 * Paths that cannot exist. Passing both explicitly is what stops a developer's
 * real `~/.config/npm-mcp/config.json` or `~/.npmrc` leaking into the suite —
 * without them the tests pass on the machine that has a token and fail in CI,
 * or, worse, the reverse.
 */
export const ABSENT_CONFIG = "/nonexistent/npm-mcp/config.json";
export const ABSENT_NPMRC = "/nonexistent/.npmrc";

export const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

/**
 * npm's web-flow challenge body. The URLs are what the client needs to run the
 * browser step, and npm only ever hands them out inside a 401 — which is why
 * there is no way to mint a code proactively.
 */
export const CHALLENGE_BODY = {
  authUrl: "https://www.npmjs.com/auth/cli/test-uuid",
  doneUrl: "https://registry.npmjs.org/-/v1/done?authId=test-uuid",
};

/** A 401 shaped the way npm shapes an OTP challenge: header plus web-flow URLs. */
export const otpChallenge = (body: unknown = CHALLENGE_BODY): Response =>
  new Response(JSON.stringify(body), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": "OTP" },
  });

/**
 * The same challenge with NO `www-authenticate` header. npm really does send
 * these — its own client carries a body regex for exactly this case — so the
 * classifier has to catch it from the text alone.
 */
export const otpChallengeBodyOnly = (): Response =>
  new Response(
    JSON.stringify({ ...CHALLENGE_BODY, message: "You must provide a one-time pass." }),
    { status: 401, headers: { "content-type": "application/json" } },
  );

/** A 401 that is genuinely about the token, not a second factor. */
export const unauthorized = (): Response =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

export type RecordingOtpProvider = OtpProvider & { calls: OtpRequest[]; mints: number };

/**
 * An OTP provider that records what it was asked for.
 *
 * `getOtp` returns undefined until it is handed a challenge, mirroring the real
 * contract — that is what lets `request()` make an un-OTP'd first attempt, which
 * is the only thing that elicits a challenge at all.
 */
export const recordingOtpProvider = (codes: string[] = ["otp-1"]): RecordingOtpProvider => {
  const calls: OtpRequest[] = [];
  const queue = [...codes];
  let cached: string | undefined;
  let mints = 0;

  return {
    calls,
    get mints() {
      return mints;
    },
    getOtp: async (req) => {
      calls.push(req);
      if (cached) return cached;
      if (!req.challenge) return undefined;
      mints += 1;
      cached = queue.shift();
      return cached;
    },
    invalidate: (code) => {
      if (cached === code) cached = undefined;
    },
    offer: (code) => {
      cached = code;
    },
    peek: () => ({
      mode: "test",
      cached: cached !== undefined,
      expiresInMs: cached ? 300_000 : 0,
      usesRemaining: cached ? 80 : 0,
    }),
    clear: () => {
      cached = undefined;
    },
  };
};

export type Harness = Awaited<ReturnType<typeof connect>>;

export const connect = async (
  env: Record<string, string> = { NPM_TOKEN: "test-token" },
  fetchImpl?: ReturnType<typeof vi.fn>,
  opts: { otpProvider?: OtpProvider } = {},
) => {
  const config: Config = loadConfig(env, ABSENT_CONFIG, ABSENT_NPMRC);
  const fetchMock = fetchImpl ?? vi.fn(async () => jsonResponse({}));
  // A plain counter rather than vi.spyOn: a spy's type drags @vitest/spy
  // internals into this function's inferred return type, which tsc then refuses
  // to emit.
  let tokenInvalidations = 0;
  const base = staticTokenProvider(config.token ?? "test-token");
  const tokenProvider = {
    getToken: base.getToken,
    invalidate: () => {
      tokenInvalidations += 1;
      base.invalidate();
    },
  };

  const { server, otpProvider } = createServer({
    config,
    fetch: fetchMock as unknown as typeof fetch,
    tokenProvider,
    ...(opts.otpProvider ? { otpProvider: opts.otpProvider } : {}),
  });

  // Both halves of a linked pair must come from the SAME package: the v2 SDK
  // exports InMemoryTransport from both /client and /server, and the two copies
  // keep private state that does not cross. Mixing them makes the pair hang
  // rather than fail, which is a miserable thing to debug.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    config,
    otpProvider,
    /**
     * How many requests actually went out. Exposed as a number rather than the
     * mock itself: a vitest mock's type drags @vitest/spy internals into this
     * function's inferred return type, which tsc then refuses to emit.
     */
    callCount: (): number => fetchMock.mock.calls.length,
    tokenInvalidations: (): number => tokenInvalidations,
    toolNames: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tool: async (name: string) => (await client.listTools()).tools.find((t) => t.name === name),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and
      // never reaches the tool body — which is the behaviour we want, so the
      // harness reports it as an error rather than failing to parse it.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) } as Record<string, unknown>;
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true } as Record<
          string,
          unknown
        >;
      } catch {
        return { isToolError: res.isError === true, error: text } as Record<string, unknown>;
      }
    },
    urls: (): string[] => fetchMock.mock.calls.map((c) => String(c[0])),
    requests: (): { url: string; init: RequestInit }[] =>
      fetchMock.mock.calls.map((c) => ({ url: String(c[0]), init: (c[1] ?? {}) as RequestInit })),
    headerAt: (index: number, name: string): string | undefined => {
      const init = (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit;
      return (init.headers as Record<string, string> | undefined)?.[name];
    },
    bodyAt: (index: number): unknown => {
      const init = (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit;
      return typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    },
  };
};
