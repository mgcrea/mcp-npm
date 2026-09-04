import type { Logger, TokenProvider, TokenReload } from "#/client/auth";
import { errorDetail, NpmOtpError, NpmRegistryError } from "#/client/errors";
import { isOtpChallenge, parseWebChallenge, tokenIdentity, type OtpProvider } from "#/client/otp";

export type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

/**
 * Whether a call should participate in npm's one-time-password dance.
 *
 * Opt-in per request, and only four families do: trust, tokens, access and
 * publish. The rest of the registry is public reads, and growing them
 * `npm-auth-type: web` headers would be noise at best.
 */
export type OtpMode = "never" | "auto";

export type RequestOptions = {
  query?: Query;
  body?: unknown;
  otp?: OtpMode;
  /** Sent as `npm-command`; only decides the wording on npm's confirmation page. */
  command?: string;
  /**
   * Block and open a browser if npm challenges this call and nothing is
   * cached, instead of failing immediately with the authorization URL.
   * Defaults to false — see `OtpRequest.wait` for why that is the safe
   * default and which callers deliberately opt back in.
   */
  otpWait?: boolean;
  /** Send no Authorization header at all (the advisories endpoint wants none). */
  anonymous?: boolean;
  /** Override the Accept header, e.g. the abbreviated-packument media type. */
  accept?: string;
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

/**
 * A package name inside a `/-/package/...` path, where npm wants it fully
 * escaped: `@babel/core` becomes `%40babel%2Fcore`.
 *
 * This is NOT the same rule as `packumentPath` below, and mixing them up yields
 * a 404 that reads like "no such package" — see the comment there.
 */
export const escapePackageName = (name: string): string => encodeURIComponent(name);

/**
 * A package name as the packument path `/{pkg}`.
 *
 * Here the scope separator stays a literal `/` and only that one slash is
 * escaped, which is what npm's own client does. So `@babel/core` is
 * `/@babel%2fcore` — not `%40babel%2Fcore`, which is what the `/-/package/`
 * routes want. Two routes, two encodings, and the registry answers 404 rather
 * than complaining when you pick the wrong one.
 */
export const packumentPath = (name: string): string => `/${name.replace("/", "%2f")}`;

export const buildQuery = (query: Query | undefined): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

const safeJsonParse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
};

export type RegistryClientOptions = {
  registry: string;
  downloadsBaseUrl: string;
  tokenProvider: TokenProvider;
  otpProvider: OtpProvider;
  maxRetries: number;
  userAgent: string;
  /** Which config layer supplied the token. Quoted in auth error remedies. */
  tokenSource?: string | undefined;
  /**
   * Overrides the `npm-auth-type` header. Escape hatch only — see the note in
   * the constructor for why `web` is the right default even for a typed code.
   */
  otpAuthType?: "web" | "legacy" | undefined;
  fetch?: typeof fetch;
  logger?: Logger | undefined;
};

export class NpmRegistryClient {
  readonly registry: string;
  readonly downloadsBaseUrl: string;
  private readonly tokens: TokenProvider;
  private readonly otps: OtpProvider;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly initialTokenSource: string;
  private readonly otpAuthType: "web" | "legacy";
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(opts: RegistryClientOptions) {
    this.registry = opts.registry.replace(/\/+$/, "");
    this.downloadsBaseUrl = opts.downloadsBaseUrl.replace(/\/+$/, "");
    this.tokens = opts.tokenProvider;
    this.otps = opts.otpProvider;
    this.maxRetries = opts.maxRetries;
    this.userAgent = opts.userAgent;
    this.initialTokenSource = opts.tokenSource ?? "an unknown source";
    // `web` for every mode, including totp — verified live on 2026-09-04, when a
    // TOTP typed straight from an authenticator was accepted by both the publish
    // and the trusted-publisher endpoints with this header set to `web`. npm
    // validates `npm-otp` on its own and does not consult `npm-auth-type` to do
    // it. Keeping `web` is then strictly better than `legacy`, because it is
    // also what makes npm attach {authUrl, doneUrl} to a challenge, which is the
    // only thing that lets a human recover when the code is missing or wrong.
    // The override exists because this is npm's negotiation to change, not ours.
    this.otpAuthType = opts.otpAuthType ?? "web";
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
  }

  /**
   * Re-read the token from whatever supplies it.
   *
   * Exposed on the client because the tools reach the provider through it, and
   * because a reload is only ever interesting alongside the requests it fixes.
   */
  reloadToken(): TokenReload {
    return this.tokens.reload();
  }

  /**
   * Which layer supplies the token right now.
   *
   * Read from the provider rather than remembered from construction: a reload
   * can move the token between layers, and naming the layer it used to come
   * from sends you to edit a file that is no longer being read.
   */
  private get tokenSource(): string {
    return this.tokens.source() ?? this.initialTokenSource;
  }

  /** The OTP cache key for the token currently configured. */
  async identity(): Promise<string> {
    return tokenIdentity(await this.tokens.getToken().catch(() => undefined));
  }

  otpStatus(identity: string): ReturnType<OtpProvider["peek"]> {
    return this.otps.peek(identity);
  }

  clearOtp(): void {
    this.otps.clear();
  }

  /** Seed a user-supplied one-time password. Backs npm_auth_otp({code}). */
  offerOtp(code: string, identity: string): void {
    this.otps.offer(code, identity);
  }

  /**
   * Warm the OTP cache by reacting to a challenge on a call the caller was
   * going to make anyway. There is no way to mint a code proactively — npm only
   * hands out the `authUrl`/`doneUrl` pair inside a 401 — so "prewarming" is
   * always a real request whose challenge we answer once.
   *
   * The probe's outcome is NOT the caller's outcome, which is the whole reason
   * this exists rather than a bare call. A code can be minted, cached and
   * perfectly usable while the probe request that elicited it still fails
   * afterwards — a 403 on that particular package, say — and reporting that
   * failure as an OTP failure sends the caller off to spend a second browser
   * authorization it already has. Equally, a probe that fails BEFORE npm issues
   * a challenge mints nothing, and calling that an OTP problem points at the
   * wrong thing entirely.
   *
   * So the error is returned rather than thrown. The caller reports it beside
   * the cache state, which is what actually answers "do I have a code?".
   */
  async primeOtp(probe: () => Promise<unknown>): Promise<unknown | undefined> {
    try {
      await probe();
      return undefined;
    } catch (err) {
      return err;
    }
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.registry}${path}${buildQuery(opts.query)}`;
    const wantsOtp = opts.otp === "auto";
    const command = opts.command ?? "trust";
    const identity = await this.identity();
    const hasBody = opts.body !== undefined;
    const bodyText = hasBody ? JSON.stringify(opts.body) : undefined;

    /** Token-refresh and 429/5xx budget. */
    let attempt = 0;
    /**
     * OTP acquisitions. Capped at one and deliberately not configurable: the
     * worst outcome available on this path is an unbounded loop of browser
     * prompts, and one acquisition per request is all a correct flow ever needs.
     */
    let otpAttempts = 0;
    const spentOtps = new Set<string>();

    // Eager reuse only — never a prompt. A cached code rides along; an absent
    // one leaves the first attempt bare, which is what elicits the challenge.
    let otp = wantsOtp ? await this.otps.getOtp({ command, identity }) : undefined;

    for (;;) {
      this.logger?.debug?.(`${method} ${path} (attempt ${attempt + 1})`);
      const token = opts.anonymous ? undefined : await this.tokens.getToken();

      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: opts.accept ?? "application/json",
          "User-Agent": this.userAgent,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          // This pair is what turns a bare 401 into a machine-usable
          // {authUrl, doneUrl} challenge. Omitting it is the easiest way to an
          // unrecoverable "one-time pass required" with nothing to act on.
          ...(wantsOtp ? { "npm-auth-type": this.otpAuthType, "npm-command": command } : {}),
          ...(otp ? { "npm-otp": otp } : {}),
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(bodyText !== undefined ? { body: bodyText } : {}),
      });

      // Read the body once, before classification: the OTP heuristic needs it
      // and a Response body cannot be read twice.
      const text = res.status === 204 ? "" : await res.text();

      // ---- the 401 fork. Order is load-bearing. --------------------------
      if (wantsOtp && isOtpChallenge(res.status, res.headers, text)) {
        // NOT a token problem. Do not invalidate the token, do not spend
        // `attempt`, do not back off. A generic 401 handler reaching this case
        // discards a working token, refetches it, and fails naming the wrong
        // cause.
        if (otp) {
          this.otps.invalidate(otp);
          spentOtps.add(otp);
        }
        if (otpAttempts >= 1) throw this.otpRejected(path, text);

        otpAttempts += 1;
        const challenge = parseWebChallenge(text, this.registry);
        const fresh = await this.otps.getOtp({
          command,
          subject: path,
          identity,
          challenged: true,
          ...(challenge ? { challenge } : {}),
          ...(opts.otpWait ? { wait: true } : {}),
        });
        // No provider, headless, or a provider handing back the code we just
        // buried. Either way this is no progress, so stop rather than loop.
        if (!fresh || spentOtps.has(fresh)) throw this.otpUnavailable(path, text, challenge);
        otp = fresh;
        continue;
      }

      if (res.status === 401 && !opts.anonymous && attempt < this.maxRetries) {
        // Re-read the token from its source before deciding. `npm login` writes
        // a fresh one to ~/.npmrc, so a 401 is genuinely recoverable — but only
        // when the bytes actually moved. Retrying with the same token npm just
        // refused spends the whole budget to arrive at the same 401, several
        // seconds later and with the cause no clearer.
        if (this.tokens.invalidate()) {
          this.logger?.warn?.("HTTP 401 — the token changed on disk; retrying with the new one");
          attempt += 1;
          continue;
        }
        this.logger?.warn?.("HTTP 401 — the token is unchanged at its source; not retrying");
      }
      // ---- end 401 fork ---------------------------------------------------

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const delay = retryAfterMs(res) ?? backoffMs(attempt);
        this.logger?.warn?.(`HTTP ${res.status} — retrying in ${delay}ms`);
        await sleep(delay);
        attempt += 1;
        continue;
      }

      if (!res.ok) throw this.toError(res, text, method, path);
      if (res.status === 204 || text.trim() === "") return null as T;
      return safeJsonParse(text) as T;
    }
  }

  get<T = unknown>(path: string, query?: Query, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, { ...opts, ...(query ? { query } : {}) });
  }

  post<T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body });
  }

  put<T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, { ...opts, body });
  }

  del<T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, {
      ...opts,
      ...(body !== undefined ? { body } : {}),
    });
  }

  /**
   * The download-counts API, on its own host and never authenticated.
   * Kept separate from `request()` because none of the auth, OTP or retry-on-401
   * machinery applies, and threading a second base URL through that loop would
   * only invite a token onto a host that never wanted one.
   */
  async downloads<T = unknown>(path: string): Promise<T> {
    const url = `${this.downloadsBaseUrl}${path}`;
    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": this.userAgent },
      });
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        await sleep(retryAfterMs(res) ?? backoffMs(attempt));
        attempt += 1;
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        throw new NpmRegistryError(
          `npm downloads GET ${path} failed: HTTP ${res.status} ${res.statusText}`.trim(),
          {
            status: res.status,
            errors: safeJsonParse(text),
            remedy:
              res.status === 404
                ? "No download data for that package or period. Note the bulk form " +
                  "(`a,b,c`) is point-only, caps at 128 packages, and rejects scoped names — " +
                  "query a scoped package on its own."
                : undefined,
          },
        );
      }
      return safeJsonParse(text) as T;
    }
  }

  private otpRejected(path: string, text: string): NpmOtpError {
    return new NpmOtpError(`npm rejected the one-time password for ${path}.`, {
      status: 401,
      errors: safeJsonParse(text),
      remedy:
        "The code has probably expired — npm one-time passwords last about five minutes — or " +
        "it was issued for a different npm account than the token this server is using " +
        `(token source: ${this.tokenSource}). Run npm_auth_clear_otp, then npm_auth_otp, and ` +
        "check that npm_auth_status names the account you expect.",
    });
  }

  private otpUnavailable(
    path: string,
    text: string,
    challenge: { authUrl: string } | undefined,
  ): NpmOtpError {
    return new NpmOtpError(
      `npm requires a one-time password for ${path}, and this server could not obtain one.`,
      {
        status: 401,
        errors: safeJsonParse(text),
        ...(challenge ? { authUrl: challenge.authUrl } : {}),
        remedy:
          (challenge
            ? `Open ${challenge.authUrl} to authorize, then retry. `
            : "npm did not return a browser-authorization URL. ") +
          "Or run npm_auth_otp with a code from your authenticator app. Note that npm requires " +
          "an OTP on all three trusted-publisher endpoints — the read included — so fully " +
          "unattended trusted-publisher configuration is not possible.",
      },
    );
  }

  /**
   * Turn a failed response into an error whose `remedy` says what to do.
   *
   * Every branch here exists because the bare status sends people to the wrong
   * place. A 403 in particular has four distinct causes on npm, and three of
   * them have nothing to do with the token's permissions.
   */
  private toError(res: Response, text: string, method: string, path: string): NpmRegistryError {
    const parsed = safeJsonParse(text);
    const detail = errorDetail(parsed);
    const base =
      `npm registry ${method} ${path} failed: HTTP ${res.status} ${res.statusText}`.trim() +
      (detail ? ` — ${detail}` : "");
    const haystack = `${detail ?? ""} ${text}`;

    if (res.status === 401) {
      return new NpmRegistryError(base, {
        status: res.status,
        errors: parsed,
        remedy:
          `The npm token was rejected. It came from ${this.tokenSource}. Run \`npm login\` and ` +
          "let this server read ~/.npmrc, or create a new token at " +
          "https://www.npmjs.com/settings/~/tokens and set NPM_TOKEN.",
      });
    }

    if (res.status === 403) {
      // Must be tested BEFORE the generic two-factor branch below. npm's real
      // message is "Granular access tokens that bypass two-factor
      // authentication may not perform this action", which matches both — and
      // the generic branch would send the user off to enable 2FA they already
      // have, instead of to reissue the token.
      if (/bypass\w*[\s-]*(?:2fa|two.?factor)|gat-bypass2fa/i.test(haystack)) {
        return new NpmRegistryError(base, {
          status: res.status,
          errors: parsed,
          remedy:
            "This granular access token has 'Bypass 2FA' enabled, and npm no longer accepts " +
            "such tokens for this action (see https://gh.io/npm-gat-bypass2fa-deprecation). " +
            "Create a new granular access token WITHOUT the bypass option, with read-and-write " +
            "on this package or its scope, and set NPM_TOKEN to it. Reads keep working with " +
            "the old token, which is why this only surfaces now, on the write.",
        });
      }
      if (/two.?factor|\b2fa\b/i.test(haystack)) {
        return new NpmRegistryError(base, {
          status: res.status,
          errors: parsed,
          remedy:
            "Two-factor authentication must be enabled on the npm ACCOUNT, not just on the " +
            "token. Turn it on at https://www.npmjs.com/settings/~/tfa and retry. No token " +
            "setting substitutes for this.",
        });
      }
      return new NpmRegistryError(base, {
        status: res.status,
        errors: parsed,
        remedy:
          "The token authenticated but is not permitted to do this. For a package, check you " +
          "are a maintainer and that a granular token names it or its scope with read-and-write. " +
          "For an account or org endpoint, note that npm accepts only a session token from " +
          "`npm login` on several of them — a granular token is refused outright. " +
          "npm_auth_status reports which kind this token is.",
      });
    }

    if (res.status === 404) {
      // A 404 on a WRITE is not "no such path". npm answers the create route
      // with 404 rather than 403 when the token may not create the package —
      // it will not confirm to a caller who could not claim a name that the
      // name is there to be claimed. Read as "nothing at that path", it sends
      // you hunting for a typo in a path that was correct, which is what makes
      // a first publish so much harder than it should be.
      if (method !== "GET" && method !== "HEAD") {
        return new NpmRegistryError(base, {
          status: res.status,
          errors: parsed,
          remedy:
            "npm refused this write. On a FIRST publish this nearly always means the token may " +
            "not CREATE a package here, not that the path is wrong: a granular access token " +
            "limited to selected packages cannot claim a name that does not exist yet, and npm " +
            "reports that as 404 rather than 403. Either give the token read-and-write on the " +
            "whole scope, or run `npm login` for a session token and call npm_auth_reload — " +
            "npm_auth_status shows which kind you have. Note that OIDC trusted publishing " +
            "cannot create a name either, so the first version always needs a token.",
        });
      }
      return new NpmRegistryError(base, {
        status: res.status,
        errors: parsed,
        remedy:
          `Nothing at that path on ${this.registry}. If the package is scoped, note that the ` +
          "`/-/package/...` routes need it fully escaped (`@scope/name` → `%40scope%2Fname`) " +
          "while the packument route does not. A private package also needs a token with read " +
          "access to the scope, and a just-published one may not have replicated yet.",
      });
    }

    if (res.status === 409) {
      return new NpmRegistryError(base, {
        status: res.status,
        errors: parsed,
        remedy:
          "npm allows only one trusted-publisher configuration per package and has no update " +
          "endpoint. Call npm_set_trusted_publisher with replace_existing=true to delete the " +
          "existing one and create yours, or npm_delete_trusted_publisher first.",
      });
    }

    if (res.status === 429) {
      return new NpmRegistryError(base, {
        status: res.status,
        errors: parsed,
        remedy:
          "Rate limited. npm publishes no rate-limit headers and no per-endpoint numbers, but " +
          "suggests at most ~80 packages per five-minute window and about 2s between calls " +
          "when scripting. npm_set_trusted_publisher_batch already paces itself this way.",
      });
    }

    return new NpmRegistryError(base, { status: res.status, errors: parsed });
  }
}
