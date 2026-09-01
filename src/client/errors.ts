// npm answers errors in three incompatible shapes depending on which service
// behind the registry handled the request:
//
//   {"message": "..."}                          trust, access, org/team, packages
//   {"error": "..."}                            tokens, /-/whoami, bypass-2FA 403s
//   {"statusCode":400,"error":"Bad Request","message":"..."}   Hapi-style
//
// npm's own client collapses these with `body.error || body.message`, and so do
// we — one place, so no call site has to know which service it just talked to.

export type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Pull the human-readable half out of whichever envelope npm used. */
export const errorDetail = (body: unknown): string | undefined => {
  if (typeof body === "string") return body.trim() || undefined;
  if (!isRecord(body)) return undefined;
  const error = typeof body.error === "string" ? body.error : undefined;
  const msg = typeof body.message === "string" ? body.message : undefined;
  // Hapi sends both, and its `error` is the useless generic half
  // ("Bad Request") while `message` carries the actual reason.
  if (error && msg && typeof body.statusCode === "number") return msg;
  return error ?? msg;
};

/**
 * A failed npm registry call.
 *
 * `remedy` is deliberately separate from `message`. The message says what
 * happened; the remedy says what to do about it, and it is the half a model
 * should read out and act on. Keeping it structured is also what lets the batch
 * tool attach one remedy per failed package instead of one for the whole run.
 */
export class NpmRegistryError extends Error {
  override readonly name: string = "NpmRegistryError";
  readonly status: number;
  readonly remedy: string | undefined;
  readonly errors: unknown;

  constructor(
    message: string,
    opts: { status: number; remedy?: string | undefined; errors?: unknown },
  ) {
    super(message);
    this.status = opts.status;
    this.remedy = opts.remedy;
    this.errors = opts.errors;
  }
}

/**
 * npm demanded a one-time password and we could not supply a usable one.
 *
 * A subclass rather than a flag because the remedies are entirely different
 * from every other failure: nothing about the token needs changing, and the
 * next step is always a human action.
 */
export class NpmOtpError extends NpmRegistryError {
  override readonly name: string = "NpmOtpError";
  /** npm's browser-authorization URL, when the challenge carried one. */
  readonly authUrl: string | undefined;

  constructor(
    message: string,
    opts: {
      status: number;
      remedy?: string | undefined;
      authUrl?: string | undefined;
      errors?: unknown;
    },
  ) {
    super(message, opts);
    this.authUrl = opts.authUrl;
  }
}

/** Thrown when a write path is reached while NPM_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. ` +
        `Set NPM_ALLOW_WRITES=1 to enable the mutating tools.`,
    );
  }
}

/**
 * A local check failed before anything was sent to npm. Carries the state it
 * read, so the caller sees why rather than just that something was wrong.
 */
export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
  readonly details: Rec;

  constructor(message: string, details: Rec = {}) {
    super(message);
    this.details = details;
  }
}
