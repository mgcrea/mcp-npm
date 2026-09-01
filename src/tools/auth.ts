import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

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
        "configuration rather than a bug. The `trusted_publishing_available` field and its " +
        "`blockers` list answer, without spending a call, whether the trusted-publisher tools " +
        "can work at all.",
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
          token_kind: tokens.ok ? "session" : "granular or limited",
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
          trusted_publishing_available: blockers.length === 0,
          ...(blockers.length > 0 ? { blockers } : {}),
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
        // browser step and caches the result. We discard the trust config it
        // returns — the point was the side effect.
        await client.get(`/-/package/${escapePackageName(pkg)}/trust`, undefined, {
          otp: "auto",
          command: "trust",
        });
        const status = client.otpStatus(identity);
        return {
          ok: status.cached,
          method: "web",
          expires_in_seconds: Math.round(status.expiresInMs / 1000),
          uses_remaining: status.usesRemaining,
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
