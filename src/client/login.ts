// npm's browser login flow, which is the one credential step an agent could not
// drive.
//
// `npm login` in a terminal is not scriptable: with stdin at EOF npm falls
// through to its legacy `Username:` prompt and exits without writing anything.
// The flow underneath it, though, is three HTTP calls — POST /-/v1/login for a
// {loginUrl, doneUrl} pair, open the first, poll the second until it answers 200
// with {token} — and that is drivable from here.
//
// The resulting token is a real session credential, so it never touches disk and
// never appears in a tool result. It lives in memory for the life of the process
// and dies with it; `npm login` in a terminal is what makes one durable.

import { hostname as machineHostname } from "node:os";

import type { Logger } from "#/client/auth";
import { errorDetail, NpmRegistryError } from "#/client/errors";
import { openInBrowser, parseWebChallenge, pollWebToken } from "#/client/otp";

export type WebLoginOptions = {
  registry: string;
  userAgent: string;
  fetch?: typeof fetch;
  logger?: Logger | undefined;
  open?: (url: string) => void;
  autoOpen?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Names the session on npm's device list. Defaults to this machine's hostname. */
  hostname?: string;
};

export type WebLoginResult = {
  token: string;
  /** The page the human was sent to. Reported so a headless caller can relay it. */
  loginUrl: string;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const safeParse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
};

/**
 * Obtain a session token through npm's web login flow.
 *
 * Verified against npm's own `npm-profile`, which this mirrors: the POST is
 * unauthenticated, the pair it returns is validated by the same origin rules as
 * an OTP challenge (the `doneUrl` hands back a bearer-equivalent credential, so
 * it must be the registry itself), and the poll answers 202 until the human
 * finishes in the browser.
 */
export const webLogin = async (opts: WebLoginOptions): Promise<WebLoginResult> => {
  const fetchImpl = opts.fetch ?? fetch;
  const registry = opts.registry.replace(/\/+$/, "");
  // Names the session on npm's token list, exactly as `npm login` does.
  const hostname = opts.hostname ?? machineHostname();

  const res = await fetchImpl(`${registry}/-/v1/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": opts.userAgent,
    },
    body: JSON.stringify({ hostname }),
  });
  const text = await res.text();

  if (!res.ok) {
    const detail = errorDetail(safeParse(text));
    throw new NpmRegistryError(
      `npm refused to start a login: HTTP ${res.status} ${res.statusText}`.trim() +
        (detail ? ` — ${detail}` : ""),
      {
        status: res.status,
        remedy:
          res.status === 404 || res.status === 501
            ? `${registry} does not offer the web login flow — npm's older username/password ` +
              "login is the only one it has, and this server does not implement it. Run " +
              "`npm login` in a terminal and call npm_auth_reload."
            : "Run `npm login` in a terminal and call npm_auth_reload instead.",
      },
    );
  }

  // The same {authUrl|loginUrl, doneUrl} shape an OTP challenge carries, and it
  // gets the same origin validation: this is about to launch a browser at a URL
  // the far end chose and then poll our way to a session credential.
  const challenge = parseWebChallenge(text, registry);
  if (!challenge) {
    throw new NpmRegistryError("npm's login response carried no usable authorization URL.", {
      status: res.status,
      errors: safeParse(text),
      remedy:
        "Expected a {loginUrl, doneUrl} pair on the registry's own origin. A proxy or a " +
        "private registry that answers this endpoint differently cannot be logged into from " +
        "here; run `npm login` in a terminal and call npm_auth_reload.",
    });
  }

  opts.logger?.warn?.(`npm login: authorize at ${challenge.authUrl}`);
  if (opts.autoOpen ?? true) {
    try {
      (opts.open ?? openInBrowser)(challenge.authUrl);
    } catch (err) {
      // A missing `open` binary must not sink the flow — the URL is on stderr
      // and in the tool result, so the user can still click it.
      opts.logger?.warn?.(`could not open a browser: ${String(err)}`);
    }
  }

  const token = await pollWebToken({
    challenge,
    fetch: fetchImpl,
    now: opts.now ?? Date.now,
    sleep: opts.sleep ?? defaultSleep,
    timeoutMs: opts.timeoutMs ?? 180_000,
    pollIntervalMs: opts.pollIntervalMs ?? 1_500,
    what: "the login",
    remedy:
      `Open ${challenge.authUrl} and finish signing in, then run npm_auth_login again. If the ` +
      "browser is on another machine, call it with open=false and visit the URL it reports.",
  });

  opts.logger?.warn?.("npm login confirmed; holding the session token in memory only");
  return { token, loginUrl: challenge.authUrl };
};
