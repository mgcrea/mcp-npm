import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { NpmRegistryError } from "#/client/errors";
import { escapePackageName, type NpmRegistryClient } from "#/client/registry";
import { isConfigured, setupInstructions } from "#/config";
import type { ToolContext } from "#/tools/index";
import { packageArg, wrap } from "#/tools/util";

type Probe<T> = { ok: true; value: T } | { ok: false; reason: string };

const probe = async <T>(fn: () => Promise<T>): Promise<Probe<T>> => {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * Register the auth tools.
 *
 * `npm_auth_status` comes first and unconditionally: an unconfigured server has
 * to be able to say what to configure, and it cannot do that by refusing to
 * start — that surfaces in the client as a bare "Connection closed" with stderr
 * swallowed.
 *
 * The OTP tools are registered whenever a token exists, and deliberately are
 * NOT behind the write gate. Minting a one-time password changes nothing on
 * npm, and a read-only install still needs one to read its own trusted-publisher
 * configuration — npm requires an OTP on that GET too. Gating them would leave
 * a read-only install unable to use the very feature it can read.
 */
export const registerAuthTools = (
  server: McpServer,
  client: NpmRegistryClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "npm_auth_status",
    {
      title: "npm: Auth Status",
      description:
        "Report what this server can and cannot do: whether a token is configured and where it " +
        "came from, which npm account it belongs to, whether two-factor authentication is on, " +
        "whether writes are enabled, and whether a one-time password is currently cached. " +
        "Call this first when a tool you expected is missing — an absent tool means missing " +
        "configuration rather than a bug. `trusted_publishing_available` is true, false, or " +
        '"unknown" when a probe npm refused left the answer undetermined — read `blockers` ' +
        "and `undetermined` for which. It is an ACCOUNT-level answer: npm also refuses the trust " +
        "endpoints per package, which this cannot see, so a true here is not a promise that any " +
        "particular package will work.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const { config } = ctx;
        const configured = isConfigured(config);
        const identity = await client.identity();
        const otp = client.otpStatus(identity);

        if (!configured) {
          return {
            configured: false,
            registry: config.registry,
            token_source: null,
            writes: "disabled",
            trusted_publishing_available: false,
            blockers: ["No npm token is configured."],
            available_without_credentials: ["npm_auth_status", "npm_audit_dependencies"],
            setup: setupInstructions(config),
          };
        }

        // Both probes are best-effort. This tool must never throw: it is the
        // one thing a user reaches for when everything else is failing, and an
        // auth status that fails to load because auth is broken is useless.
        const who = await probe(() => client.get<{ username?: string }>("/-/whoami"));
        const user = await probe(() =>
          client.get<{ tfa?: unknown; name?: string }>("/-/npm/v1/user"),
        );
        // The session-vs-granular split is not visible in the token string, so
        // it is probed: this endpoint refuses granular tokens outright.
        const tokens = await probe(() => client.get("/-/npm/v1/tokens", { perPage: 1 }));

        const tfa = user.ok ? user.value.tfa : undefined;
        const twoFactorOff = user.ok && (tfa === null || tfa === false);

        const blockers: string[] = [];
        /**
         * Checks that could not be RUN, as opposed to checks that failed. The
         * difference is the whole point: a blocker means "this will not work",
         * an undetermined check means "this server does not know", and
         * collapsing the second into neither is how a green status is reported
         * moments before every trusted-publisher call fails.
         */
        const undetermined: string[] = [];
        if (!user.ok) {
          undetermined.push(
            "Two-factor authentication could not be read: npm refused this token on the account " +
              `profile endpoint (/-/npm/v1/user). ${user.reason}`,
          );
        }
        if (twoFactorOff) {
          blockers.push(
            "Two-factor authentication is not enabled on the npm account. Trusted publishing " +
              "requires it on the account itself, not just on the token — turn it on at " +
              "https://www.npmjs.com/settings/~/tfa.",
          );
        }
        if (config.otpMode === "none" && !otp.cached) {
          blockers.push(
            "NPM_OTP_MODE=none and no code has been supplied, so npm's one-time-password " +
              "challenge cannot be answered. Call npm_auth_otp with a code, or unset the mode.",
          );
        }

        return {
          configured: true,
          registry: config.registry,
          token_source: config.tokenSource ?? null,
          // The evidence, not a verdict. These two probes CAN disagree — a token
          // that lists tokens but is refused the account profile is neither
          // cleanly session nor cleanly granular — and a confident one-word
          // label printed over that contradiction is what sends someone off to
          // reissue a token that was never the problem.
          token_kind: tokens.ok
            ? user.ok
              ? "session"
              : "session-like: lists tokens, but npm refuses it on the account profile endpoint"
            : "granular or limited",
          token_probes: {
            list_tokens: tokens.ok,
            account_profile: user.ok,
            whoami: who.ok,
          },
          username: who.ok ? (who.value.username ?? null) : null,
          // "unknown" is a real answer, not a bug: npm returns 403 on the
          // profile endpoint for several token kinds. Reported honestly rather
          // than guessed at, since a wrong "disabled" would send someone off to
          // fix two-factor they already have.
          two_factor: user.ok ? (twoFactorOff ? "disabled" : "enabled") : "unknown",
          writes: config.allowWrites ? "ENABLED" : "disabled",
          otp: {
            mode: config.otpMode,
            cached: otp.cached,
            expires_in_seconds: Math.round(otp.expiresInMs / 1000),
            uses_remaining: otp.usesRemaining,
          },
          // Three states, not two. This only ever meant "no blocker was
          // DETECTED", and reporting that as `true` while the probe that would
          // have found one was itself refused is an unearned green light. It is
          // also per-account only: npm answers 403 per PACKAGE on the trust
          // endpoints, which nothing here can see, so `true` is never a promise
          // that a given package will work.
          trusted_publishing_available:
            blockers.length > 0 ? false : undetermined.length > 0 ? "unknown" : true,
          ...(blockers.length > 0 ? { blockers } : {}),
          ...(undetermined.length > 0 ? { undetermined } : {}),
          // Stated even on a healthy server, because it is the constraint people
          // are most likely to design around wrongly.
          note:
            "npm requires a one-time password on all three trusted-publisher endpoints, the " +
            "read included, and a code lasts about five minutes. Fully unattended " +
            "trusted-publisher configuration is therefore not possible; use " +
            "npm_set_trusted_publisher_batch to spend one authorization across many packages.",
        };
      }),
  );

  server.registerTool(
    "npm_auth_reload",
    {
      title: "npm: Reload Auth",
      description:
        "Re-read the npm token from ~/.npmrc, NPM_TOKEN and the config file, and report " +
        "whether it changed. Use this after `npm login` in a terminal: this server captures " +
        "the token when it starts, so a login that visibly worked leaves it sending the OLD " +
        "credential and failing 401 on everything while `npm whoami` in your shell succeeds. " +
        "Cheap and safe — it reads three files, sends nothing to npm, and never reports the " +
        "token itself. It re-reads ONLY the token: the registry, the write gate and the OTP " +
        "settings stay as they were at startup, so a reload can never quietly widen what this " +
        "server may do. One limit worth knowing: if the server started with NO token at all, " +
        "the credentialled tools were never registered, and a reload cannot add them — that " +
        "case still needs a restart.",
      inputSchema: z.object({}),
      // Reads local files and mutates only this server's own cached credential.
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const result = client.reloadToken();
        return {
          changed: result.changed,
          had_token: result.hadToken,
          has_token: result.hasToken,
          token_source: result.source ?? null,
          ...(result.previousSource !== result.source
            ? { previous_token_source: result.previousSource ?? null }
            : {}),
          next_step: !result.hasToken
            ? "Still no token in any layer. Run `npm login`, or set NPM_TOKEN, then call this again."
            : result.changed
              ? "The token changed. Call npm_auth_status to confirm npm accepts it."
              : "The token is byte-for-byte what it was. If calls are still failing 401, the " +
                "credential itself is the problem rather than a stale copy of it — run " +
                "`npm login` and call this again.",
        };
      }),
  );

  if (!ctx.hasCredentials) return;

  server.registerTool(
    "npm_auth_otp",
    {
      title: "npm: Authorize One-Time Password",
      description:
        "Obtain a one-time password up front and cache it, so the trusted-publisher tools do " +
        "not stop to ask. You rarely need this: those tools trigger the same flow on their own " +
        "when npm asks. Reach for it before a batch, or when the browser is on another machine. " +
        "Pass `code` to hand over a code from your authenticator app (no browser, no network). " +
        "Otherwise pass `package` and this opens npm's confirmation page and waits for you to " +
        "approve it. The cached code lasts about five minutes, which is npm's own window.",
      inputSchema: z.object({
        code: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A one-time password from your authenticator app. Supply this only if you actually " +
              "have one in front of you — do NOT invent a plausible six-digit number. Leave it " +
              "unset to use the browser flow instead.",
          ),
        package: packageArg
          .optional()
          .describe(
            "A package you maintain, used only to ask npm for a challenge. Required when `code` " +
              "is not given, because npm only issues the browser-authorization URL in response " +
              "to a real request. Nothing about the package is changed.",
          ),
        open: z
          .boolean()
          .default(true)
          .describe(
            "Open the authorization URL in a browser. Set false when the browser is elsewhere; " +
              "the URL is reported either way.",
          ),
      }),
      // Not read-only (it may open a browser) but not destructive either: it
      // changes nothing on npm, which is why it is not behind the write gate.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ code, package: pkg }) =>
      wrap(async () => {
        const identity = await client.identity();

        if (code) {
          client.offerOtp(code, identity);
          const status = client.otpStatus(identity);
          return {
            ok: true,
            method: "provided",
            uses_remaining: status.usesRemaining,
            note: "Cached for this server process only, and never written to disk.",
          };
        }

        if (!pkg) {
          return {
            ok: false,
            error:
              "Pass either `code`, or `package` so npm can be asked for a browser-authorization " +
              "URL. npm only issues one in response to a real request, so there is no way to " +
              "start the flow from nothing.",
          };
        }

        // The probe IS the flow: the client answers the 401 challenge, runs the
        // browser step and caches the result. Its own success is beside the
        // point, so it goes through primeOtp and its error is REPORTED rather
        // than thrown.
        //
        // Throwing it — which this did until it was found to be lying — conflates
        // two unrelated questions. The probe can 403 on the package after a code
        // has been minted and cached, in which case the answer to "do I have an
        // OTP?" is yes and re-running only burns a second browser prompt. Or it
        // can fail before npm ever issues a challenge, in which case the OTP flow
        // never started and the package permission is the thing to fix. The cache
        // state distinguishes them; the probe's status code does not.
        const probeError = await client.primeOtp(() =>
          client.get(`/-/package/${escapePackageName(pkg)}/trust`, undefined, {
            otp: "auto",
            command: "trust",
            // The one deliberate exception to the fail-fast default: this
            // tool IS the "wait for a human" moment, called because someone
            // is here to click the link.
            otpWait: true,
          }),
        );
        const status = client.otpStatus(identity);
        return {
          ok: status.cached,
          method: "web",
          expires_in_seconds: Math.round(status.expiresInMs / 1000),
          uses_remaining: status.usesRemaining,
          ...(probeError
            ? {
                probe: {
                  package: pkg,
                  error: probeError instanceof Error ? probeError.message : String(probeError),
                  ...(probeError instanceof NpmRegistryError && probeError.remedy
                    ? { remedy: probeError.remedy }
                    : {}),
                },
                note: status.cached
                  ? "A one-time password WAS obtained and is cached — the failure above is the " +
                    "probe request itself, after the code was minted, and does not affect it. " +
                    "It is reported because it will recur on every call against that package."
                  : "No one-time password was obtained: the probe failed before npm issued a " +
                    "challenge, so this is not an OTP problem. Retry with a package whose trust " +
                    "configuration this token can read, or pass `code` from an authenticator app.",
              }
            : // The probe SUCCEEDED and npm never asked for a second factor, so
              // there is nothing to cache and `ok` is false. That reads as a
              // failed OTP flow and is the opposite of the truth — it is the
              // good case, and saying so is the difference between calling the
              // trusted-publisher tools next and hunting for an OTP nobody
              // wants. Whether npm challenges at all depends on the token kind
              // and the account's 2FA mode, so it cannot be predicted here.
              status.cached
              ? {}
              : {
                  note:
                    "npm did NOT ask for a one-time password on this endpoint with this token, " +
                    "so none was cached and none is needed — this is the good case, not a " +
                    "failure. Call the trusted-publisher tools directly. If one of them does " +
                    "get challenged, it runs this same flow on its own.",
                }),
        };
      }),
  );

  server.registerTool(
    "npm_auth_clear_otp",
    {
      title: "npm: Clear Cached One-Time Password",
      description:
        "Forget the cached one-time password. Use it when a code was minted for the wrong npm " +
        "account, or after switching NPM_TOKEN. Nothing on npm changes, and no token is " +
        "affected — the next trusted-publisher call simply asks for a fresh code.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () =>
      wrap(async () => {
        client.clearOtp();
        return { cleared: true };
      }),
  );
};
