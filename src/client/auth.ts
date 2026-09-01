export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

export type TokenProvider = {
  getToken(): Promise<string>;
  /** Called by the client's retry loop on a 401, so an expired token is reminted once. */
  invalidate(): void;
};

/**
 * npm tokens are static strings — there is nothing to refresh, so `invalidate`
 * is a no-op. A 401 here means the token is wrong, and retrying with the same
 * bytes would only burn the retry budget; the client's remedy text says as much.
 *
 * When nothing is configured this still constructs, so `createServer` stays
 * total. Every tool that would call it is simply not registered, and the throw
 * is a backstop that names the fix rather than a path anyone should reach.
 */
export const configTokenProvider = (token: string | undefined): TokenProvider => ({
  getToken: async () => {
    if (!token) {
      throw new Error(
        "No npm token is configured. Run `npm login` (this server reads ~/.npmrc) or set " +
          "NPM_TOKEN. Call npm_auth_status for the full setup guide.",
      );
    }
    return token;
  },
  invalidate: () => {},
});

/** For tests: always yields the same token, with no network. */
export const staticTokenProvider = (token: string): TokenProvider => ({
  getToken: async () => token,
  invalidate: () => {},
});
