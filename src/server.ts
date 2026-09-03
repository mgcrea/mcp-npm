import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { reloadableTokenProvider, type Logger, type TokenProvider } from "#/client/auth";
import {
  createWebOtpProvider,
  noOtpProvider,
  staticOtpProvider,
  type OtpProvider,
} from "#/client/otp";
import { NpmRegistryClient } from "#/client/registry";
import { isConfigured, resolveToken, type Config, type ResolvedToken } from "#/config";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-npm-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the token provider (tests). */
  tokenProvider?: TokenProvider;
  /**
   * Where a token reload reads from. Defaults to the same three layers
   * `loadConfig` merges. Injected so tests can move a token without a
   * filesystem, and so nothing below `config.ts` reaches for `process.env`.
   */
  readToken?: () => ResolvedToken;
  /** Override the one-time-password provider (tests). */
  otpProvider?: OtpProvider;
};

export type CreatedServer = {
  server: McpServer;
  client: NpmRegistryClient;
  tokenProvider: TokenProvider;
  otpProvider: OtpProvider;
};

/**
 * Pick the OTP provider from the configuration.
 *
 * Built unconditionally, even with nothing configured, so this factory stays
 * total — the tools that would use it are simply never registered.
 */
const buildOtpProvider = (config: Config, opts: CreateServerOptions): OtpProvider => {
  if (config.otp) return staticOtpProvider(config.otp);
  if (config.otpMode === "none") return noOtpProvider();
  return createWebOtpProvider({
    registry: config.registry,
    ttlMs: config.otpTtlSeconds * 1000,
    maxUses: config.otpMaxUses,
    timeoutMs: config.otpTimeoutMs,
    autoOpen: config.autoOpenBrowser,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Reloadable, not fixed: the token is the one field that changes underneath a
  // running server, and a server that cannot re-read it answers 401 forever
  // after an `npm login` that visibly worked.
  const tokenProvider =
    opts.tokenProvider ?? reloadableTokenProvider(opts.readToken ?? (() => resolveToken()));
  const otpProvider = opts.otpProvider ?? buildOtpProvider(config, opts);

  const client = new NpmRegistryClient({
    registry: config.registry,
    downloadsBaseUrl: config.downloadsBaseUrl,
    tokenProvider,
    otpProvider,
    maxRetries: config.maxRetries,
    userAgent: USER_AGENT,
    ...(config.tokenSource ? { tokenSource: config.tokenSource } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  registerTools(server, client, {
    config,
    allowWrites: config.allowWrites,
    hasCredentials: isConfigured(config),
  });

  return { server, client, tokenProvider, otpProvider };
};
