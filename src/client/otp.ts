// npm's second-factor wall, and the reason this server exists in the shape it
// does.
//
// Every trusted-publisher endpoint requires an `npm-otp` header — including the
// GET — and an npm one-time password lives about five minutes. So a code cannot
// be configured once at startup and reused: it is dead before anything runs.
// Fully unattended trusted-publisher configuration is therefore impossible, and
// `npm_auth_status` says so rather than pretending otherwise.
//
// What IS possible is collapsing one human authorization into a whole batch,
// which is what the cache below is for.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

import type { Logger } from "#/client/auth";
import { NpmOtpError } from "#/client/errors";

/** The body npm returns on a web-flow 401. Both URLs are validated before use. */
export type WebOtpChallenge = { authUrl: string; doneUrl: string };

export type OtpRequest = {
  /** Sent as `npm-command`; decides the wording on npm's confirmation page. */
  command: string;
  /** What the OTP is being minted for. Diagnostics only — never a cache key. */
  subject?: string | undefined;
  /** Present only when reacting to a 401. Absent means "give me what you have". */
  challenge?: WebOtpChallenge | undefined;
  /** The identity the code will be paired with, so it is never sent under another token. */
  identity: string;
  /**
   * Block on `mint()` — open a browser and poll for up to `timeoutMs` — when a
   * challenge arrives and nothing is cached. Defaults to false.
   *
   * False is the right default for a call buried inside some other tool: this
   * provider has no way to know whether a human is watching, and a multi-minute
   * hang with nobody to click the link is worse than an immediate failure that
   * names the URL. `true` is for the few call sites that ARE the deliberate
   * "wait for a human" moment — `npm_auth_otp`'s own probe, and the first
   * package of a trusted-publisher batch, which explicitly promises one
   * browser prompt for the whole run.
   */
  wait?: boolean;
};

export type OtpStatus = {
  mode: string;
  cached: boolean;
  expiresInMs: number;
  usesRemaining: number;
};

export type OtpProvider = {
  /**
   * A code for the `npm-otp` header, or undefined when none can be produced
   * without a challenge — OR without a wait nobody asked for. Two different
   * "no" cases share the one return value on purpose: `request()` reacts to
   * both identically, by surfacing the challenge in the thrown error rather
   * than the code.
   *
   * Deliberately NOT symmetric with `TokenProvider.getToken()`, which always
   * yields or throws. `undefined` is what lets `request()` make an un-OTP'd
   * first attempt — and that attempt is the only thing that produces the
   * challenge in the first place. A provider that prompted here would put a
   * browser in front of the user before npm had asked for one.
   */
  getOtp(req: OtpRequest): Promise<string | undefined>;
  /** The registry rejected this exact code. Drop it. */
  invalidate(code: string): void;
  /**
   * Accept a code the user supplied directly, from an authenticator app.
   * Seeds the same cache the browser flow fills, so a batch that follows
   * spends no prompt at all.
   */
  offer(code: string, identity: string): void;
  /** Diagnostics for npm_auth_status. Never returns the code itself. */
  peek(identity: string): OtpStatus;
  /** Drop everything cached. Backs npm_auth_clear_otp. */
  clear(): void;
};

/**
 * A stable, non-reversible handle for a token, used to key the OTP cache.
 *
 * Keyed on the token rather than the package for two reasons, both load-bearing:
 * rotating NPM_TOKEN invalidates the cache without anyone remembering to, and a
 * batch across N packages shares one entry — which is the entire mechanism that
 * turns twelve browser prompts into one.
 */
export const tokenIdentity = (token: string | undefined): string =>
  token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "anonymous";

/**
 * Is this 401 "you need a second factor" or "your token is bad"?
 *
 * Ported from npm's own `otplease`. The body regex is not belt-and-braces: some
 * registry responses omit `www-authenticate` entirely, and npm documents the
 * string match as the fallback for exactly that case.
 *
 * Getting this wrong is the expensive bug. The client's retry loop already
 * treats a 401 as "invalidate the token and retry", so an OTP challenge
 * misclassified as a token failure throws away a perfectly good token, refetches
 * it, and fails with an error naming the wrong cause entirely.
 */
export const isOtpChallenge = (status: number, headers: Headers, bodyText: string): boolean => {
  if (status !== 401) return false;
  const challenges = (headers.get("www-authenticate") ?? "").split(/,\s*/);
  if (challenges.some((c) => c.trim().toLowerCase().startsWith("otp"))) return true;
  return /one-time pass/i.test(bodyText);
};

/**
 * Hosts allowed to serve the browser-authorization page for a given registry.
 *
 * The public registry is a genuine cross-domain case rather than an oversight:
 * the API lives on `registry.npmjs.org` but the login page it points at is on
 * `www.npmjs.com`, a different registrable domain. That pair is allow-listed
 * explicitly; every other registry must host its own auth page.
 */
const allowedAuthHosts = (registryUrl: URL): Set<string> => {
  const hosts = new Set([registryUrl.host]);
  if (registryUrl.host === "registry.npmjs.org") {
    hosts.add("www.npmjs.com");
    hosts.add("npmjs.com");
  }
  return hosts;
};

/**
 * Pull `{authUrl, doneUrl}` out of a 401 body, **validating both origins**.
 *
 * We are about to launch a browser at a URL the far end chose and then POST our
 * way to a bearer-equivalent code. An unvalidated `authUrl` turns every 401 on
 * this path into a drive-by browser-open primitive; an unvalidated `doneUrl`
 * hands the OTP to whoever asked. Returning undefined ends the flow with a
 * readable error instead.
 */
export const parseWebChallenge = (
  bodyText: string,
  registry: string,
): WebOtpChallenge | undefined => {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const { authUrl, doneUrl } = body as { authUrl?: unknown; doneUrl?: unknown };
  if (typeof authUrl !== "string" || typeof doneUrl !== "string") return undefined;

  let registryUrl: URL;
  let auth: URL;
  let done: URL;
  try {
    registryUrl = new URL(registry);
    auth = new URL(authUrl);
    done = new URL(doneUrl);
  } catch {
    return undefined;
  }

  if (auth.protocol !== "https:" || !allowedAuthHosts(registryUrl).has(auth.host)) return undefined;
  // The done endpoint hands back the code, so it must be the registry itself —
  // no allow-list, no exceptions.
  if (done.origin !== registryUrl.origin) return undefined;

  return { authUrl: auth.toString(), doneUrl: done.toString() };
};

/** Open a URL in the user's browser. Isolated so tests can pass a spy. */
export const openInBrowser = (url: string): void => {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  // Detached and ignored: an MCP server must not block on, or inherit output
  // from, a browser launch. stdout in particular is the protocol channel.
  const child = execFile(command, [url], { windowsHide: true });
  child.unref?.();
};

type OtpEntry = {
  code: string;
  expiresAt: number;
  usesRemaining: number;
};

export type WebOtpProviderOptions = {
  registry: string;
  fetch?: typeof fetch;
  logger?: Logger | undefined;
  open?: (url: string) => void;
  autoOpen?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  ttlMs?: number;
  maxUses?: number;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * npm's browser flow: open the authorization page, poll the done endpoint until
 * it yields a code, cache it for the cooldown window.
 *
 * The cache is a **client-side guess at a server-side window**. npm's cooldown
 * lives on npm's side, keyed by IP and account, and we cannot observe it. So
 * cache optimistically, treat a rejection as routine rather than exceptional,
 * and never treat a cached code as authoritative.
 *
 * Nothing here is written to disk. `mcp-reddit` and `mcp-boursobank` persist
 * their credentials because a refresh token is good for months and worth
 * keeping; an npm OTP is a bearer-equivalent second factor with a five-minute
 * life. Persisting it would convert a human-gated, minutes-long capability into
 * a file that outlives reboots and lands in backups, for no upside at all — it
 * expires long before the next session.
 */
export const createWebOtpProvider = (opts: WebOtpProviderOptions): OtpProvider => {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const open = opts.open ?? openInBrowser;
  const autoOpen = opts.autoOpen ?? true;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_500;
  const ttlMs = opts.ttlMs ?? 300_000;
  const maxUses = opts.maxUses ?? 80;

  const cache = new Map<string, OtpEntry>();
  /**
   * One mint at a time, per identity. Two trust calls that 401 simultaneously
   * must share a single browser prompt — and the client cannot coordinate that
   * itself, because it does not know two of its own calls want the same code.
   */
  const inflight = new Map<string, Promise<string>>();

  const live = (identity: string): OtpEntry | undefined => {
    const entry = cache.get(identity);
    if (!entry) return undefined;
    if (entry.expiresAt <= now() || entry.usesRemaining <= 0) {
      cache.delete(identity);
      return undefined;
    }
    return entry;
  };

  const mint = async (challenge: WebOtpChallenge, identity: string): Promise<string> => {
    opts.logger?.warn?.(`npm requires a one-time password. Authorize at: ${challenge.authUrl}`);
    if (autoOpen) {
      try {
        open(challenge.authUrl);
      } catch (err) {
        // A missing `open` binary must not sink the flow — the URL is on stderr
        // and in the tool result, so the user can still click it.
        opts.logger?.warn?.(`could not open a browser: ${String(err)}`);
      }
    }

    const deadline = now() + timeoutMs;
    for (;;) {
      if (now() >= deadline) {
        throw new NpmOtpError(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for npm to confirm the ` +
            `one-time password.`,
          {
            status: 401,
            authUrl: challenge.authUrl,
            remedy:
              `Open ${challenge.authUrl} and complete the two-factor confirmation, then retry. ` +
              `If the browser is on another machine, call npm_auth_otp with open=false and ` +
              `visit the URL it returns.`,
          },
        );
      }

      const res = await fetchImpl(challenge.doneUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      if (res.status === 200) {
        const body = (await res.json().catch(() => undefined)) as { token?: unknown } | undefined;
        if (typeof body?.token === "string" && body.token) {
          cache.set(identity, {
            code: body.token,
            expiresAt: now() + ttlMs,
            usesRemaining: maxUses,
          });
          opts.logger?.warn?.("one-time password confirmed");
          return body.token;
        }
      }

      // 202 is npm's "still waiting"; anything else transient is treated the
      // same way, because the deadline above is what actually bounds this loop.
      const retryAfter = Number(res.headers.get("Retry-After"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : pollIntervalMs,
      );
    }
  };

  return {
    async getOtp(req) {
      const entry = live(req.identity);
      if (entry) {
        // Decrement on hand-out rather than on success: the code is about to be
        // attached to a request either way, and over-counting a use is far
        // cheaper than exhausting npm's real window without noticing.
        entry.usesRemaining -= 1;
        return entry.code;
      }
      if (!req.challenge) return undefined;

      // A challenge with no cached code, and nobody asked this call to wait:
      // hand back nothing rather than opening a browser and polling for up to
      // `timeoutMs`. The caller loses nothing by this — request()'s own
      // otpUnavailable() builds the same authUrl/remedy from the challenge it
      // already parsed, just without the wait nobody asked for.
      if (!req.wait) return undefined;

      const pending = inflight.get(req.identity);
      if (pending) return pending;

      const promise = mint(req.challenge, req.identity).finally(() => {
        inflight.delete(req.identity);
      });
      inflight.set(req.identity, promise);
      return promise;
    },

    invalidate(code) {
      for (const [identity, entry] of cache) {
        if (entry.code === code) cache.delete(identity);
      }
    },

    offer(code, identity) {
      cache.set(identity, { code, expiresAt: now() + ttlMs, usesRemaining: maxUses });
    },

    peek(identity) {
      const entry = live(identity);
      return {
        mode: "web",
        cached: entry !== undefined,
        expiresInMs: entry ? Math.max(0, entry.expiresAt - now()) : 0,
        usesRemaining: entry?.usesRemaining ?? 0,
      };
    },

    clear() {
      cache.clear();
    },
  };
};

/**
 * A fixed code, from NPM_OTP or npm_auth_otp({code}).
 *
 * Single-use in practice: npm burns a TOTP code on first acceptance, so the
 * `dead` set stops us resending one the registry has already rejected. That is
 * what turns "retried forever with a stale code" into one clear error.
 */
export const staticOtpProvider = (initial: string): OtpProvider => {
  const dead = new Set<string>();
  let code = initial;
  return {
    getOtp: async () => (dead.has(code) ? undefined : code),
    invalidate: (c) => {
      dead.add(c);
    },
    offer: (next) => {
      code = next;
      dead.delete(next);
    },
    peek: () => ({
      mode: "static",
      cached: !dead.has(code),
      expiresInMs: 0,
      usesRemaining: dead.has(code) ? 0 : 1,
    }),
    clear: () => dead.add(code),
  };
};

/**
 * Never mints a code, but still accepts one handed to it. `NPM_OTP_MODE=none`
 * means "do not open a browser", not "refuse a code the user typed" — so
 * npm_auth_otp keeps working here, which is the whole point of having the mode.
 */
export const noOtpProvider = (): OtpProvider => {
  const manual = new Map<string, string>();
  return {
    getOtp: async (req) => manual.get(req.identity),
    invalidate: (code) => {
      for (const [identity, value] of manual) if (value === code) manual.delete(identity);
    },
    offer: (code, identity) => {
      manual.set(identity, code);
    },
    peek: (identity) => ({
      mode: "none",
      cached: manual.has(identity),
      expiresInMs: 0,
      usesRemaining: manual.has(identity) ? 1 : 0,
    }),
    clear: () => manual.clear(),
  };
};
