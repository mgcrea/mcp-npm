import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { expandTilde, readNpmrcToken, resolveNpmrcPath } from "#/client/npmrc";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/**
 * Download counts live on a different host from everything else, and are the
 * only npm API that never wants a token.
 */
export const DEFAULT_DOWNLOADS_BASE_URL = "https://api.npmjs.org";

export const OTP_MODES = ["web", "static", "none"] as const;
export type OtpMode = (typeof OTP_MODES)[number];

/** Where a token came from. Reported by npm_auth_status; never the token itself. */
export type TokenSource = "environment" | "file" | "npmrc";

const ConfigSchema = z
  .object({
    registry: z.url().default(DEFAULT_REGISTRY),
    downloadsBaseUrl: z.url().default(DEFAULT_DOWNLOADS_BASE_URL),
    token: z.string().min(1).optional(),
    tokenSource: z.enum(["environment", "file", "npmrc"]).optional(),
    allowWrites: z.boolean().default(false),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    /**
     * How a one-time password is obtained when npm demands one.
     * `web` runs npm's browser flow; `static` uses NPM_OTP; `none` refuses,
     * which is the right setting for a headless run that must never block.
     */
    otpMode: z.enum(OTP_MODES).default("web"),
    otp: z.string().min(1).optional(),
    /**
     * How long a minted OTP is reused. npm's own cooldown is about five
     * minutes, and this is a client-side guess at that server-side window —
     * see the note in client/otp.ts.
     */
    otpTtlSeconds: z.number().int().min(0).max(900).default(300),
    /** npm's published guidance is roughly 80 packages per cooldown window. */
    otpMaxUses: z.number().int().min(1).max(500).default(80),
    autoOpenBrowser: z.boolean().default(true),
    otpTimeoutMs: z.number().int().min(1000).max(600_000).default(180_000),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Deliberately NOT an error when no token is set. An MCP server that exits
    // on startup shows up in the client as a bare "Connection closed", with
    // stderr swallowed — so the one message that would have explained the
    // problem never reaches anyone. A tokenless server is genuinely useful
    // here too: every packument, search and advisory read is public.
    //
    // A *contradictory* configuration is a different matter and is worth saying.
    if (cfg.otpMode === "static" && !cfg.otp) {
      ctx.addIssue({
        code: "custom",
        path: ["otp"],
        message:
          "NPM_OTP_MODE=static needs a code in NPM_OTP. Note that an npm one-time password " +
          "expires after about five minutes, so a code set at process start is almost always " +
          "already dead — prefer the default web mode, or call npm_auth_otp with a fresh code.",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The on-disk config document. Keys are camelCase to mirror `Config` rather
 * than the env var names: this is a typed JSON file, not a shell.
 *
 * `.strict()` on purpose — a typo'd `allowWrite` must be an error. Silently
 * ignoring an unknown key looks exactly like "that setting had no effect",
 * which is the worst way to learn your credentials came from somewhere else.
 */
const FileConfigSchema = z
  .object({
    registry: z.url().optional(),
    downloadsBaseUrl: z.url().optional(),
    token: z.string().min(1).optional(),
    allowWrites: z.boolean().optional(),
    maxRetries: z.number().int().nonnegative().max(10).optional(),
    otpMode: z.enum(OTP_MODES).optional(),
    otp: z.string().min(1).optional(),
    otpTtlSeconds: z.number().int().min(0).max(900).optional(),
    otpMaxUses: z.number().int().min(1).max(500).optional(),
    autoOpenBrowser: z.boolean().optional(),
    otpTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

/** Maps "" to undefined, so an empty env var means "unset" rather than "empty". */
const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Where the config file lives, most specific first.
 *
 * The variable is `NPM_MCP_CONFIG`, not `NPM_CONFIG`, because npm reads its own
 * `npm_config_*` namespace out of the environment and a bare `NPM_CONFIG` sits
 * confusingly close to it.
 */
export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.NPM_MCP_CONFIG);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "npm-mcp", "config.json");
};

/**
 * This file can hold a registry token, so being readable by other users is
 * worth saying out loud. A warning and not an error: refusing to start would be
 * a worse trade on a single-user machine.
 */
export const warnIfGroupReadable = (path: string): void => {
  if (process.platform === "win32") return; // mode bits mean nothing here
  try {
    if (statSync(path).mode & 0o077) {
      process.stderr.write(
        `[npm-mcp] ${path} is readable by other users. Run: chmod 600 ${path}\n`,
      );
    }
  } catch {
    // Not worth failing startup over; the read below reports anything that matters.
  }
};

/**
 * Read the config file, treating "absent" as "contributes nothing". Every other
 * failure throws and names the path, so a malformed file is never mistaken for
 * a missing one — that confusion sends you hunting for credentials that were
 * sitting right there.
 */
const readConfigFile = (path: string): FileConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read the config file (${path}): ${message(err)}`, { cause: err });
  }

  warnIfGroupReadable(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The config file (${path}) is not valid JSON: ${message(err)}`, { cause: err });
  }

  const result = FileConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`The config file (${path}) is not valid: ${issues}`);
  }
  return result.data;
};

/**
 * Environment first, config file second, `~/.npmrc` last — **per field**, not
 * whole-source. Docker and CI inject the environment and must keep working
 * untouched, while a one-off `NPM_ALLOW_WRITES=0` still has to override a file
 * that says `true`. Merging field by field is the only rule that gives both.
 *
 * The `.npmrc` layer applies to the token alone, and only to the entry matching
 * the configured registry.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
  npmrcPath: string = resolveNpmrcPath(env),
): Config => {
  const file = readConfigFile(configPath);
  const registry = trimmed(env.NPM_REGISTRY) ?? file.registry ?? DEFAULT_REGISTRY;

  // Resolve the token and remember which layer supplied it. The source is worth
  // as much as the token when something goes wrong: "the token was rejected" is
  // unactionable until you know which of three files to go and fix.
  const envToken = trimmed(env.NPM_TOKEN);
  const fileToken = file.token;
  // Only touch ~/.npmrc when the two explicit layers have nothing. Reading a
  // file the user never pointed us at is a last resort, not a default.
  const npmrcToken =
    envToken === undefined && fileToken === undefined
      ? readNpmrcToken(registry, npmrcPath)
      : undefined;
  const token = envToken ?? fileToken ?? npmrcToken;
  const tokenSource: TokenSource | undefined = envToken
    ? "environment"
    : fileToken
      ? "file"
      : npmrcToken
        ? "npmrc"
        : undefined;

  return ConfigSchema.parse({
    registry,
    downloadsBaseUrl: trimmed(env.NPM_DOWNLOADS_URL) ?? file.downloadsBaseUrl,
    token,
    tokenSource,
    allowWrites: parseBool(env.NPM_ALLOW_WRITES) ?? file.allowWrites,
    maxRetries: parseIntOpt(env.NPM_MAX_RETRIES) ?? file.maxRetries,
    otpMode: trimmed(env.NPM_OTP_MODE) ?? file.otpMode,
    otp: trimmed(env.NPM_OTP) ?? file.otp,
    otpTtlSeconds: parseIntOpt(env.NPM_OTP_TTL_SECONDS) ?? file.otpTtlSeconds,
    otpMaxUses: parseIntOpt(env.NPM_OTP_MAX_USES) ?? file.otpMaxUses,
    autoOpenBrowser: parseBool(env.NPM_AUTO_OPEN_BROWSER) ?? file.autoOpenBrowser,
    otpTimeoutMs: parseIntOpt(env.NPM_OTP_TIMEOUT_MS) ?? file.otpTimeoutMs,
  });
};

/** True once the server holds a token it can send. */
export const isConfigured = (config: Config): boolean => Boolean(config.token);

/**
 * What to do when nothing is configured. Returned by npm_auth_status and
 * printed to stderr at startup, because this is the state a first-time user
 * lands in and the server can no longer signal it by refusing to start.
 */
export const setupInstructions = (config: Config): string[] => {
  if (isConfigured(config)) return [];
  return [
    "No npm token is configured, so only the tools that need none are registered: " +
      "npm_auth_status and npm_audit_dependencies.",
    "The simplest fix is `npm login` — this server reads the resulting " +
      `\`//${new URL(config.registry).host}/:_authToken=\` line from ~/.npmrc automatically.`,
    "Otherwise set NPM_TOKEN. Create a token at https://www.npmjs.com/settings/~/tokens.",
    // The trap that costs the most: the token type that looks most correct for
    // an automated server is the one npm refuses for trusted publishing.
    "For trusted-publisher tools, do NOT enable 'Bypass 2FA' on a granular access token — npm " +
      "rejects such tokens with 403 on every trust write. A classic/session token from " +
      "`npm login` is the safest choice, and is the only kind several governance reads accept.",
    "Two-factor authentication must also be enabled on the npm ACCOUNT itself; no token setting " +
      "substitutes for it.",
  ];
};
