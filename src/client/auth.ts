import type { ResolvedToken, TokenSource } from "#/config";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

/** What a reload found. Never carries the token itself — only whether it moved. */
export type TokenReload = {
  /** True when the bytes differ from what was held. The only reason to retry. */
  changed: boolean;
  hadToken: boolean;
  hasToken: boolean;
  /** Which layer supplies the token now. Can differ from before the reload. */
  source: TokenSource | undefined;
  previousSource: TokenSource | undefined;
};

export type TokenProvider = {
  getToken(): Promise<string>;
  /**
   * Called by the client's retry loop on a 401. Returns whether the token
   * actually changed — a false says retrying would resend the same bytes, and
   * the loop stops instead of spending its budget on a certain failure.
   */
  invalidate(): boolean;
  /** Re-read the token from its origin, whatever that is. */
  reload(): TokenReload;
  /** Which layer supplied the token currently held. */
  source(): TokenSource | undefined;
};

const missingTokenError = (): Error =>
  new Error(
    "No npm token is configured. Run `npm login` (this server reads ~/.npmrc) or set " +
      "NPM_TOKEN. Call npm_auth_status for the full setup guide.",
  );

/**
 * A token that can be re-read from the layers `config.ts` resolves.
 *
 * This is the default provider, and the reason it exists is a real incident: an
 * npm token expired, `npm login` wrote a fresh one to `~/.npmrc`, and this
 * server went on sending the dead one for the rest of its life because it had
 * captured the string at construction. Every call failed 401 while `npm whoami`
 * in a terminal succeeded — the most misleading shape a credential bug can take,
 * because the evidence in front of you says the credential is fine.
 *
 * `read` is injected rather than called directly so that nothing below
 * `config.ts` touches `process.env`, and so tests can move the token without a
 * filesystem.
 */
export const reloadableTokenProvider = (read: () => ResolvedToken): TokenProvider => {
  let current = read();

  const reload = (): TokenReload => {
    const previous = current;
    // A read that throws — a config file edited into invalid JSON, say — must
    // not destroy a working token. Keep what we have and report no change.
    let next: ResolvedToken;
    try {
      next = read();
    } catch {
      next = previous;
    }
    current = next;
    return {
      changed: previous.token !== next.token,
      hadToken: previous.token !== undefined,
      hasToken: next.token !== undefined,
      source: next.tokenSource,
      previousSource: previous.tokenSource,
    };
  };

  return {
    getToken: async () => {
      if (!current.token) throw missingTokenError();
      return current.token;
    },
    invalidate: () => reload().changed,
    reload,
    source: () => current.tokenSource,
  };
};

/**
 * A fixed token, from an explicit string.
 *
 * Nothing to re-read, so `invalidate` reports no change and the retry loop does
 * not waste an attempt resending bytes npm has already refused.
 */
export const configTokenProvider = (
  token: string | undefined,
  tokenSource?: TokenSource,
): TokenProvider => ({
  getToken: async () => {
    if (!token) throw missingTokenError();
    return token;
  },
  invalidate: () => false,
  reload: () => ({
    changed: false,
    hadToken: token !== undefined,
    hasToken: token !== undefined,
    source: tokenSource,
    previousSource: tokenSource,
  }),
  source: () => tokenSource,
});

/** For tests: always yields the same token, with no network. */
export const staticTokenProvider = (token: string): TokenProvider => configTokenProvider(token);
