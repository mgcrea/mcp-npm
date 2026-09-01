import { z } from "zod";

import {
  NpmOtpError,
  NpmRegistryError,
  PreconditionError,
  WritesDisabledError,
} from "#/client/errors";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed. Measured on this server's own replies, `null, 2`
 * adds 17-31% to every response — worst on wide lists of short-keyed objects,
 * which are exactly the ones already big enough to hurt. No model needs the
 * indentation, and every tool returns through here.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/**
 * Return text as-is. `ok()` JSON-stringifies, which turns a markdown document
 * into one escaped "# Title\n\n…" line that no one can read.
 */
export const okText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

export const fail = (message: string, extra?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }],
  isError: true,
});

/**
 * Render a thrown value as a tool error.
 *
 * `remedy` is lifted to a top-level field rather than buried in `details`,
 * because it is the part the model should act on. A remedy nested three levels
 * inside an npm error envelope gets skimmed past.
 */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof NpmOtpError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      ...(err.authUrl ? { authorize_url: err.authUrl } : {}),
      status: err.status,
    });
  }
  if (err instanceof NpmRegistryError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      status: err.status,
      ...(err.errors !== undefined ? { details: err.errors } : {}),
    });
  }
  if (err instanceof PreconditionError) return fail(err.message, { details: err.details });
  if (err instanceof WritesDisabledError) return fail(err.message);
  if (err instanceof Error) {
    const details = (err as Error & { details?: unknown }).details;
    return fail(err.message, details ? { details } : undefined);
  }
  return fail("Unknown error", { details: err });
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/** Like `wrap`, but the body chooses its own result shape. */
export const wrapResult = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return toFailure(err);
  }
};

/** Drop undefined values so we never send `{"scope": undefined}` upstream. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

// ------------------------------------------------------------------ args ----

/**
 * npm package names are permissive — lower-case, and scoped names carry exactly
 * one slash. Validating here rather than upstream turns a typo into an
 * immediate message instead of a 404 that reads like "this package does not
 * exist", which sends people looking in the wrong place.
 */
export const packageArg = z
  .string()
  .min(1)
  .regex(
    /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
    "Not a valid npm package name. Names are lower-case; a scoped name looks like `@scope/name`.",
  )
  .describe('Package name, e.g. "lodash" or "@mgcrea/mcp-ovh-api". Lower-case.');

export const versionArg = z
  .string()
  .min(1)
  .describe('An exact published version, e.g. "4.17.21". Not a range — ranges are not resolved.');

export const scopeOrgArg = z
  .string()
  .min(1)
  .describe('npm organisation name, without the leading "@", e.g. "mgcrea".');

export const teamArg = z
  .string()
  .min(1)
  .describe('Team name within the org, without the "org:" prefix, e.g. "developers".');

/** Destructive tools require this, so an agent can never mutate something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this changes state on npm.");

export const dryRunArg = z
  .boolean()
  .default(false)
  .describe(
    "Report every step that would run, and run none of them. Use this first on anything " +
      "irreversible.",
  );
